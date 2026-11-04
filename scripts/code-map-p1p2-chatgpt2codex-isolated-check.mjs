// Isolated full reindex of the real ChatGPT2Codex checkout.
// Never writes QuestBoard DB, installed MCP, or the existing last-good snapshot.
// SCIP artifacts and the comparison report live only in a new /tmp directory.
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createConfiguredCodeMapService } from "../dist/src/server/code-map-config.js";
import { queryCodeGraph } from "../dist/src/application/code-map-query.js";

const projectRoot = resolve(process.argv[2] ?? "");
const expectedRoot = "/Users/seungjinhan/project/ChatGPT2Codex";
if (projectRoot !== expectedRoot || !existsSync(join(projectRoot, ".git"))
  || !existsSync(join(projectRoot, "tsconfig.json"))) {
  throw Error("Requires the exact known ChatGPT2Codex root; no user-supplied arbitrary path");
}
const executable = resolve("node_modules/.bin/scip-typescript");
if (!existsSync(executable)) throw Error("Pinned local scip-typescript executable missing");
const outputRoot = mkdtempSync(join(tmpdir(), "questboard-code-map-p1p2-isolated-"));
const projectId = "350d266c-a8f6-4235-926f-e403f4c125b3";
const service = createConfiguredCodeMapService({
  ...process.env,
  QUESTBOARD_CODE_MAP: "1",
  QUESTBOARD_CODE_MAP_PROVIDER: "scip-typescript",
  QUESTBOARD_CODE_MAP_STORAGE_ROOT: outputRoot,
  QUESTBOARD_SCIP_TYPESCRIPT_EXECUTABLE: executable,
  QUESTBOARD_CODE_MAP_ISOLATED_CHILD: "1",
});
if (!service) throw Error("Configured isolated Code Map service unavailable");

let sampledPeakMiB = 0;
let sampledProcessTreePeakMiB = 0;
let samples = 0;
const mib = (bytes) => +(bytes / 1048576).toFixed(1);
function sampleMemory() {
  samples++;
  sampledPeakMiB = Math.max(sampledPeakMiB, mib(process.memoryUsage().rss));
  try {
    const ps = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,rss="], {
      encoding: "utf8", timeout: 1500, maxBuffer: 1024 * 1024,
    });
    const entries = ps.split("\n").map(line => line.trim().split(/\s+/).map(Number))
      .filter(row => row.length === 3 && row.every(Number.isFinite));
    const descendants = new Set([process.pid]);
    let changed;
    do {
      changed = false;
      for (const [pid, parent] of entries) {
        if (descendants.has(parent) && !descendants.has(pid)) { descendants.add(pid); changed = true; }
      }
    } while (changed);
    const treeMiB = entries.filter(([pid]) => descendants.has(pid))
      .reduce((sum, row) => sum + row[2] / 1024, 0);
    sampledProcessTreePeakMiB = Math.max(sampledProcessTreePeakMiB, +treeMiB.toFixed(1));
  } catch { /* process may exit between samples */ }
}
const timer = setInterval(sampleMemory, 300);
const started = performance.now();
try {
  const result = await service.refresh({ projectId, rootPath: projectRoot });
  const graph = result.graph;
  const subsystem = service.sourceSubsystems(projectId);
  let files = [];
  for (let offset = 0; ; ) {
    const page = queryCodeGraph(graph, "composite", {
      operation: "list_files", offset, limit: 100,
      ...(offset ? { expectedSourceIndexedAt: graph.indexedAt,
        expectedSnapshotId: "isolated-pinned-source" } : {}),
    });
    if (page.operation !== "list_files") throw Error("Unexpected file listing");
    files.push(...page.files);
    if (page.nextOffset === undefined) break;
    offset = page.nextOffset;
  }
  const levels = files.reduce((counts, file) => {
    counts[file.analysisLevel] = (counts[file.analysisLevel] ?? 0) + 1;
    counts[file.analysisState] = (counts[file.analysisState] ?? 0) + 1;
    return counts;
  }, {});
  const byLanguage = files.reduce((counts, file) => {
    const row = counts[file.language] ?? { files: 0, semantic: 0, structural: 0, fileOnly: 0 };
    row.files++;
    if (file.analysisLevel === "semantic") row.semantic++;
    else if (file.analysisLevel === "structural") row.structural++;
    else row.fileOnly++;
    counts[file.language] = row;
    return counts;
  }, {});
  const counts = graph.relations.reduce((out, edge) => {
    out[edge.kind] = (out[edge.kind] ?? 0) + 1;
    return out;
  }, {});
  const report = {
    status: "isolated_full_reindex_pass",
    root: projectRoot,
    previousSnapshotId: "f5bb9e02d6262013a05102a7246157e67032cf85d99fbd980134e69ff86cd16c",
    baseline: { statusAtRead: "stale", nodes: 31344, relations: 86168,
      architectureGroups: 4, architectureRelations: 3, unknownFiles: 21, rawCalls: 12119 },
    sourceIndexedAt: graph.indexedAt,
    elapsedSeconds: +((performance.now() - started) / 1000).toFixed(2),
    memory: { sampledPeakMainRssMiB: sampledPeakMiB, sampledPeakProcessTreeRssMiB: sampledProcessTreePeakMiB,
      processMaxRssMiB: +(process.resourceUsage().maxRSS / 1024).toFixed(1), samples },
    graph: { nodeCount: graph.nodes.length, relationCount: graph.relations.length,
      relationKinds: counts, semanticCoverage: graph.coverage?.languages },
    architecture: { groups: result.projection.nodes.length, relations: result.projection.relations.length,
      quality: result.projection.quality },
    subsystem: { groupCount: subsystem.nodes.length, relationCount: subsystem.relations.length,
      quality: subsystem.quality, truncation: subsystem.truncation },
    coverage: { discoveredFileCount: files.length, levels, byLanguage,
      unknown: files.filter(file => file.language === "unknown").map(file =>
        ({ path: file.path, type: file.fileType, reason: file.classificationReason })),
      providerScopeExclusions: files.filter(file => file.analysisState === "excluded")
        .map(file => ({ path: file.path, reason: file.reason, analysisLevel: file.analysisLevel })),
      structuralExamples: files.filter(file => file.analysisLevel === "structural").slice(0, 30) },
    preservation: "Existing persisted QuestBoard DB/snapshots untouched; SCIP artifact and probe report under isolated /tmp only",
  };
  writeFileSync(join(outputRoot, "comparison.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, artifactDirectory: outputRoot,
    graph: { ...report.graph, semanticCoverage: report.graph.semanticCoverage?.map(x =>
      ({ language: x.language, fileCount: x.fileCount, semanticEligibleFileCount: x.semanticEligibleFileCount,
        semanticIndexedFileCount: x.semanticIndexedFileCount })) } }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: "isolated_full_reindex_failed",
    reason: String(error), artifacts: outputRoot }));
  process.exitCode = 1;
} finally {
  clearInterval(timer);
}
