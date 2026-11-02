// Isolated S7 public-repository memory probe. Read-only on the fixture and no QuestBoard DB/API writes.
// This probes the real QuestBoard file-inventory → canonical hierarchy → CodeMapService
// → subsystem-read path. It never pretends file-only data contains semantic PHP calls.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { performance } from "node:perf_hooks";
import { CODE_GRAPH_SCHEMA_VERSION, assertValidCodeGraphSnapshot } from "../dist/src/application/code-intelligence.js";
import { FileSystemCodeFileInventory } from "../dist/src/adapters/code-intelligence/file-inventory.js";
import { materializeCodeFileHierarchy } from "../dist/src/application/code-map-hierarchy.js";
import { CodeMapService } from "../dist/src/application/code-map-service.js";

const root = resolve(process.argv[2] ?? "/tmp/questboard-s7-laravel-framework-20261022");
if (!root.startsWith("/tmp/questboard-s7-") || !existsSync(join(root, ".git")) || !existsSync(join(root, "composer.json"))) {
  throw new Error("S7 probe requires an existing, explicitly isolated /tmp/questboard-s7-* Composer Git fixture");
}
const projectId = "s7-public-laravel-file-only";
const t0 = performance.now();
const steps = [];
let sampledPeakRss = 0;
const measure = () => {
  const m = process.memoryUsage();
  sampledPeakRss = Math.max(sampledPeakRss, m.rss);
  return {
    rssMiB: +(m.rss / 1048576).toFixed(2),
    heapUsedMiB: +(m.heapUsed / 1048576).toFixed(2),
    heapTotalMiB: +(m.heapTotal / 1048576).toFixed(2),
    externalMiB: +(m.external / 1048576).toFixed(2),
    arrayBuffersMiB: +(m.arrayBuffers / 1048576).toFixed(2),
    processMaxRssKiB: process.resourceUsage().maxRSS,
  };
};
const started = measure();
const timer = setInterval(() => { measure(); }, 10);
timer.unref();
const stage = async (name, fn) => {
  const before = measure();
  const startedAt = performance.now();
  const value = await fn();
  steps.push({
    name,
    durationMs: +(performance.now() - startedAt).toFixed(1),
    before,
    after: measure(),
  });
  return value;
};
try {
  const inventory = new FileSystemCodeFileInventory();
  const files = await stage("filesystem_inventory", () => inventory.listFiles(root));
  const phpFiles = files.filter((entry) => entry.path.toLowerCase().endsWith(".php"));
  const timestamp = new Date().toISOString();
  const base = {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId,
    rootPath: root,
    indexedAt: timestamp,
    nodes: [],
    relations: [],
  };
  const hierarchy = await stage("canonical_file_hierarchy", () =>
    materializeCodeFileHierarchy(base, files));
  assertValidCodeGraphSnapshot(hierarchy);
  assert.equal(hierarchy.nodes.filter((node) => node.kind === "file").length, files.length);
  assert.equal(hierarchy.relations.length, 0, "file-only must never fabricate calls/contains");
  const provider = {
    providerId: "public-php-file-only",
    fidelity: "file-only",
    capabilities: { incrementalIndexing: false, impactAnalysis: false, callTrace: false },
    async indexProject(request) {
      return { ...base, projectId: request.projectId, rootPath: request.rootPath, indexedAt: new Date().toISOString() };
    },
  };
  const codeMap = new CodeMapService(provider, new FileSystemCodeFileInventory());
  const refreshed = await stage("code_map_service_refresh", () =>
    codeMap.refresh({ projectId, rootPath: root }));
  assert.equal(refreshed.graph.nodes.filter((node) => node.kind === "file").length, files.length);
  assert.equal(refreshed.graph.relations.length, 0, "no semantic facts: zero relations");
  const subsystemPage = await stage("source_subsystem_page_12", () =>
    codeMap.querySourceSubsystems(projectId, { operation: "list_subsystems", offset: 0, limit: 12 }));
  const secondPage = subsystemPage.hasMore ? await stage("source_subsystem_next_page_12", () =>
    codeMap.querySourceSubsystems(projectId, {
      operation: "list_subsystems",
      offset: subsystemPage.nextOffset,
      limit: 12,
      expectedSourceIndexedAt: subsystemPage.sourceIndexedAt,
      expectedSnapshotId: subsystemPage.snapshotId,
    })) : undefined;
  const report = {
    status: "completed_file_only",
    fixture: { name: "laravel/framework", gitRoot: root, phpFiles: phpFiles.length, totalFiles: files.length,
      phpFraction: +(phpFiles.length / Math.max(1, files.length)).toFixed(4),
      composerLockPresent: existsSync(join(root, "composer.lock")),
      vendorAutoloadPresent: existsSync(join(root, "vendor", "autoload.php")),
      localScipPhpPresent: existsSync(join(root, "vendor", "bin", "scip-php")) },
    semanticPhp: { status: "blocked_missing_php_composer_and_project_dependencies",
      tested: false, semanticNodeCount: null, semanticRelationCount: null,
      note: "This is a real file-only Code Map pass. No parser, PHP execution, or semantic calls claimed." },
    outputs: { graphNodes: refreshed.graph.nodes.length, graphRelations: refreshed.graph.relations.length,
      compatibilityProjectionNodes: refreshed.projection.nodes.length,
      compatibilityProjectionRelations: refreshed.projection.relations.length,
      subsystemCandidates: subsystemPage.candidateCount,
      firstPageItems: subsystemPage.returnedCount,
      secondPageItems: secondPage?.returnedCount ?? 0,
      pageTruncated: subsystemPage.truncated },
    memory: { baseline: started, final: measure(),
      sampledPeakRssMiB: +(sampledPeakRss / 1048576).toFixed(2),
      processMaxRssKiB: process.resourceUsage().maxRSS,
      processMaxRssUnit: "KiB per Node.js process.resourceUsage()",
      caveat: "Peak excludes PHP/indexer child process because none was run." },
    timing: { totalMs: +(performance.now() - t0).toFixed(1), stages: steps },
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  clearInterval(timer);
}
