// S7 real public BookStack SCIP PHP memory probe. Never accesses QuestBoard SQLite,
// MCP, Flow, or production snapshots. Run only after Composer and scip-php are
// installed into the explicitly disposable /tmp/questboard-s7-bookstack-* clone.
// The provider's transient root index.scip is removed by the production adapter;
// the external SCIP artifact is retained only under a new /tmp probe directory.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { assertValidCodeGraphSnapshot } from "../dist/src/application/code-intelligence.js";
import { CodeMapService } from "../dist/src/application/code-map-service.js";
import { FileSystemCodeFileInventory } from "../dist/src/adapters/code-intelligence/file-inventory.js";
import { ScipPhpProvider } from "../dist/src/adapters/code-intelligence/scip-php-provider.js";
import { loadScipGraphInProcess, indexDirectory } from "../dist/src/adapters/code-intelligence/scip-provider.js";

const root = resolve(process.argv[2] ?? "/tmp/questboard-s7-bookstack-20261030");
// Compare legacy source-inventory inflation without changing the native SCIP
// provider, Composer install, or any checkout files.
const includeComposerDependencies = process.argv.includes("--legacy-vendor-inventory");
const php = "/opt/homebrew/opt/php@8.4/bin/php";
const indexer = join(root, "vendor", "bin", "scip-php");
for (const file of [join(root, ".git"), join(root, "composer.json"), join(root, "composer.lock"),
  join(root, "vendor", "autoload.php"), indexer, php]) {
  if (!existsSync(file)) throw new Error("Isolated SCIP PHP fixture prerequisite absent: " + file);
}
if (!root.startsWith("/tmp/questboard-s7-bookstack-") || existsSync(join(root, "index.scip"))) {
  throw new Error("Only an isolated clean BookStack fixture without an existing index.scip is allowed");
}
const outputRoot = mkdtempSync(join(tmpdir(), "questboard-s7-php-scip-"));
const projectId = "s7-public-bookstack-real-php";
const request = { projectId, rootPath: root };
const steps = [];
const mib = (value) => +(value / 1048576).toFixed(1);
const nodeMemory = () => ({
  rssMiB: mib(process.memoryUsage().rss),
  heapUsedMiB: mib(process.memoryUsage().heapUsed),
  processMaxRssMiB: +(process.resourceUsage().maxRSS / 1024).toFixed(1),
});
let nodePeakRss = process.memoryUsage().rss;
let phpPeakRssMiB = 0;
let currentChildPid;
const samples = { count: 0, php: 0 };
function sample() {
  samples.count += 1;
  nodePeakRss = Math.max(nodePeakRss, process.memoryUsage().rss);
  if (!currentChildPid) return;
  try {
    const output = execFileSync("/bin/ps", ["-o", "rss=", "-p", String(currentChildPid)], {
      encoding: "utf8", timeout: 1800, maxBuffer: 4096,
    }).trim();
    const rssKiB = Number(output);
    if (Number.isFinite(rssKiB) && rssKiB > 0) {
      phpPeakRssMiB = Math.max(phpPeakRssMiB, +(rssKiB / 1024).toFixed(1));
      samples.php += 1;
    }
  } catch { /* process ended during sampling */ }
}
const timer = setInterval(sample, 100);
timer.unref();
const t0 = performance.now();
async function stage(name, work) {
  sample();
  const before = nodeMemory();
  const started = performance.now();
  const value = await work();
  sample();
  steps.push({ stage: name, ms: +(performance.now() - started).toFixed(1),
    before, after: nodeMemory() });
  return value;
}
const runner = {
  run(executable, args, options) {
    assert.equal(executable, indexer);
    assert.equal(options.cwd, root);
    return new Promise((resolveRun, rejectRun) => {
      const child = spawn(php, ["-d", "memory_limit=512M", executable, ...args], {
        cwd: root, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: "/opt/homebrew/opt/php@8.4/bin:/opt/homebrew/bin:" + (process.env.PATH ?? "") },
      });
      currentChildPid = child.pid;
      let stdout = "", stderr = "";
      let outputBytes = 0;
      const limit = 1024 * 1024;
      const onData = (channel) => (buffer) => {
        outputBytes += buffer.length;
        if (outputBytes > limit) { child.kill("SIGKILL"); return; }
        if (channel === "out") stdout += buffer.toString("utf8");
        else stderr += buffer.toString("utf8");
      };
      child.stdout.on("data", onData("out"));
      child.stderr.on("data", onData("err"));
      const timeout = setTimeout(() => child.kill("SIGKILL"), 240_000);
      child.once("error", (error) => { clearTimeout(timeout); currentChildPid = undefined; rejectRun(error); });
      child.once("close", (code, signal) => {
        sample();
        currentChildPid = undefined;
        clearTimeout(timeout);
        if (code !== 0 || signal || outputBytes > limit) {
          rejectRun(new Error("scip-php failed: exit=" + code + ", signal=" + signal +
            ", stderrTail=" + stderr.slice(-1000)));
        } else resolveRun({ stdout, stderr, exitCode: 0 });
      });
    });
  },
};
let status = "error";
let failure;
let results;
try {
  const inventory = new FileSystemCodeFileInventory({ includeComposerDependencies });
  const files = await stage("file_inventory", () => inventory.listFiles(root));
  const phpFiles = files.filter(f => f.path.endsWith(".php")).length;
  const vendorPhpFiles = files.filter(f => f.path.startsWith("vendor/") && f.path.endsWith(".php")).length;
  const provider = new ScipPhpProvider(runner, {
    storageRoot: outputRoot, graphLoader: { load: loadScipGraphInProcess },
  });
  const service = new CodeMapService(provider, inventory);
  const refreshed = await stage("scip_php_index_decode_hierarchy_projection", () => service.refresh(request));
  assertValidCodeGraphSnapshot(refreshed.graph);
  const page = await stage("source_subsystem_page", () =>
    service.querySourceSubsystems(projectId, { operation: "list_subsystems", limit: 12 }));
  const artifact = join(indexDirectory(outputRoot, request), "index.scip");
  results = {
    inventoryMode: includeComposerDependencies ? "legacy_including_composer_vendor" : "first_party_excluding_composer_vendor",
    files: files.length, phpFiles, vendorPhpFiles,
    semanticPhpCoverage: refreshed.graph.coverage?.languages.find(entry => entry.language === "php"),
    rawNodes: refreshed.graph.nodes.length,
    rawRelations: refreshed.graph.relations.length,
    calls: refreshed.graph.relations.filter(r => r.kind === "calls").length,
    instantiates: refreshed.graph.relations.filter(r => r.kind === "instantiates").length,
    contains: refreshed.graph.relations.filter(r => r.kind === "contains").length,
    providerRuns: refreshed.graph.providerRuns?.length ?? 0,
    subsystemCandidates: page.candidateCount,
    sourcePageCount: page.returnedCount,
    indexArtifactBytes: existsSync(artifact) ? statSync(artifact).size : null,
    indexArtifactPath: artifact,
    generatedIndexCleaned: !existsSync(join(root, "index.scip")),
  };
  if (results.rawNodes <= 0 || results.providerRuns <= 0
    || results.calls <= 0 || results.instantiates <= 0)
    throw new Error("SCIP PHP semantic acceptance requires native provider evidence and verified call/constructor relations");
  status = "real_scip_php_success";
} catch (error) {
  failure = String(error?.stack ?? error).slice(-2500);
} finally {
  clearInterval(timer);
}
console.log(JSON.stringify({
  status, projectId, root, outputRoot, results,
  memory: {
    nodePeakRssMiB: mib(nodePeakRss),
    nodeResourceMaxRssMiB: +(process.resourceUsage().maxRSS / 1024).toFixed(1),
    phpSampledPeakRssMiB: phpPeakRssMiB,
    caveat: "PHP RSS sampled by ps; peak is approximate and does not sum possible grandchild processes. Node/PHP peaks are not necessarily simultaneous.",
    samples,
  },
  elapsedMs: +(performance.now() - t0).toFixed(1),
  steps, error: failure,
}, null, 2));
if (status !== "real_scip_php_success") process.exitCode = 1;
