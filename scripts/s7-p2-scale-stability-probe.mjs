// S7 isolated scale probe. Every path is a fresh disposable /tmp fixture.
// Seeding and measured read execution happen in separate Node processes so
// the measured daemon-like parent NEVER constructs or deserializes a raw graph.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { CODE_GRAPH_SCHEMA_VERSION } from "../dist/src/application/code-intelligence.js";
import { computeCodeMapSnapshotIdentity } from "../dist/src/application/code-map-snapshot-identity.js";
import { createConfiguredCodeMapRuntime } from "../dist/src/server/code-map-config.js";
import { createIsolatedCodeMapReadExecutor } from "../dist/src/server/code-map-isolated-read.js";

const phase = process.argv[2] ?? "all";
const projectId = "s7-disposable-scale";
const mb = bytes => Math.round(bytes / 1048576 * 10) / 10;
const hash = value => createHash("sha256").update(value).digest("hex");
const snapshotPath = storage => join(storage, "snapshots", hash(projectId), "snapshot.json");
const rootFor = root => realpathSync.native(root);
const envFor = storage => ({
  HOME: process.env.HOME, PATH: process.env.PATH,
  QUESTBOARD_CODE_MAP: "1",
  QUESTBOARD_CODE_MAP_PROVIDERS: "scip-php",
  QUESTBOARD_CODE_MAP_STORAGE_ROOT: storage,
});
function readerFor(root) {
  return {
    getProject: id => id === projectId ? { id, rootPath: root } : undefined,
    listCodeMapManualRelations: () => [],
  };
}
function synthesizeGraph(root, count, oversize = false) {
  const fileCount = oversize ? 1 : Math.max(1, Math.ceil(count / 12));
  const nodes = [];
  const relations = [];
  for (let i = 0; i < fileCount; i++) {
    const path = `src/C${String(i).padStart(5,"0")}.php`;
    nodes.push({ id: `code:node:file:${i}`, kind: "file",
      name: `C${i}.php`, canonicalIdentity: `file:${path}`,
      location: { path }, language: "php" });
  }
  for (let i = 0; i < count - fileCount; i++) {
    const owner = i % fileCount;
    const path = `src/C${String(owner).padStart(5,"0")}.php`;
    const id = `code:node:method:${i}`;
    nodes.push({ id, kind: "method", name: oversize ? `oversize_${i}` : `method_${i}`,
      canonicalIdentity: `php:synthetic:${path}#method_${i}`,
      location: { path, startLine: (i % 25) + 1 }, language: "php",
      ...(oversize ? { signature: "s".repeat(15_000) } : {}) });
    relations.push({ id: `code:relation:contains:${i}`, kind: "contains",
      from: `code:node:file:${owner}`, to: id, confidence: 1 });
    if (i > 0 && !oversize) relations.push({ id: `code:relation:calls:${i}`,
      kind: "calls", from: `code:node:method:${i-1}`, to: id, confidence: 0.95 });
  }
  return { schemaVersion: CODE_GRAPH_SCHEMA_VERSION, projectId, rootPath: root,
    indexedAt: "2026-10-31T00:00:00.000Z", nodes, relations };
}
async function seed(root, storage, size) {
  const env = envFor(storage);
  const path = snapshotPath(storage);
  if (!existsSync(path)) {
    const service = createConfiguredCodeMapRuntime(env, readerFor(root)).service;
    assert.ok(service);
    await service.refresh({ projectId, rootPath: root });
    assert.ok(existsSync(path), "seed snapshot must persist outside source project");
  }
  const prior = JSON.parse(readFileSync(path, "utf8"));
  const graph = synthesizeGraph(root, size === "ipc" ? 121 : Number(size), size === "ipc");
  const exact = computeCodeMapSnapshotIdentity({
    projectId, rootIdentity: prior.rootIdentity,
    providerConfigFingerprint: prior.providerConfigFingerprint,
    sourceManifestFingerprint: prior.sourceManifestFingerprint,
    graph,
  });
  const next = { ...prior, graphSchemaVersion: CODE_GRAPH_SCHEMA_VERSION, ...exact,
    graph, persistedAt: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(next));
  console.log(JSON.stringify({ size, nodes: graph.nodes.length, relations: graph.relations.length,
    snapshotBytes: Buffer.byteLength(JSON.stringify(next)), snapshotId: exact.snapshotId }));
}
function sampleTree() {
  const records = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,rss=,comm="],
    { encoding: "utf8", timeout: 1500 }).trim().split("\n")
    .map(row => row.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/))
    .filter(Boolean)
    .map(match => ({ pid: Number(match[1]), ppid: Number(match[2]),
      rss: Number(match[3]), executable: match[4] }))
    // The synchronous sampler itself is temporarily our child. It is not a
    // QuestBoard read worker and must not be counted as an orphan after timeout.
    .filter(entry => !/(?:^|\/)ps$/.test(entry.executable));
  const pids = new Set([process.pid]);
  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    for (const { pid, ppid } of records) {
      if (pids.has(ppid) && !pids.has(pid)) { pids.add(pid); changed = true; }
    }
    if (!changed) break;
  }
  return { rssMiB: mb(records.reduce((total,{pid,rss}) =>
    total + (pids.has(pid) ? rss * 1024 : 0), 0)), processes: pids.size,
    children: records.filter(entry => entry.ppid === process.pid).map(entry => ({
      pid: entry.pid, executable: entry.executable,
    })) };
}
function createClient(root, storage, options = {}) {
  const env = envFor(storage);
  const service = createConfiguredCodeMapRuntime(env, readerFor(root)).service;
  assert.ok(service);
  let childPeakRssMiB = 0;
  service.setIsolatedReadExecutor(createIsolatedCodeMapReadExecutor(env, {
    timeoutMs: 90_000, maxOldSpaceMiB: 512, maxConcurrent: 2, maxQueued: 1,
    onProcessMetrics: ({ childMaxRssMiB }) => { childPeakRssMiB = Math.max(childPeakRssMiB,childMaxRssMiB); },
    ...options,
  }));
  service.getCached = () => { throw new Error("S7 P2 measured parent graph hydration forbidden"); };
  return { service, childPeakRss: () => childPeakRssMiB };
}
async function read(root, storage, size) {
  const { service, childPeakRss } = createClient(root, storage);
  const baseline = mb(process.memoryUsage().rss);
  let parentPeakRssMiB = baseline;
  let treePeakRssMiB = 0, maxTreeProcesses = 0, samples = 0;
  const observe = () => {
    parentPeakRssMiB = Math.max(parentPeakRssMiB, mb(process.memoryUsage().rss));
    try { const t = sampleTree(); treePeakRssMiB = Math.max(treePeakRssMiB, t.rssMiB);
      maxTreeProcesses = Math.max(maxTreeProcesses,t.processes); samples++; } catch {}
  };
  observe();
  const timer = setInterval(observe, 150);
  const start = performance.now();
  try {
    if (size === "ipc") {
      await assert.rejects(
        service.queryAsync(projectId, { operation: "find_nodes", query: "oversize", limit: 100 }),
        /bounded response size|exceeded/i,
      );
      return { size, status: "oversize_ipc_fail_closed", baselineRssMiB: baseline,
        parentPeakRssMiB, treePeakRssMiB, maxTreeProcesses, samples };
    }
    if (size === "corrupt") {
      const summary = await service.snapshotReadSummary(projectId);
      assert.equal(summary.indexed, false);
      assert.equal(summary.hydrationDiagnostic?.hydrationRejectReason, "identity_invalid");
      return { size, status: "tampered_last_good_snapshot_rejected", ...summary };
    }
    // Concurrent=2, bounded queue=1: immediate fourth submission must reject.
    const a = service.sourceTreePageAsync(projectId, { limit: 40 });
    const b = service.queryAsync(projectId, { operation: "find_nodes", query: "method_100", limit: 5 });
    const c = service.webBootstrapAsync(projectId);
    const queueFull = service.queryAsync(projectId, { operation: "find_nodes", query: "method_101" });
    await assert.rejects(queueFull, /queue is full/);
    const [tree, query, bootstrap] = await Promise.all([a,b,c]);
    assert.equal(bootstrap.indexed,true);
    assert.equal(bootstrap.nodeCount, Number(size));
    assert.ok(bootstrap.snapshotIdentity?.snapshotId);
    assert.equal(tree.snapshotId,bootstrap.snapshotIdentity.snapshotId);
    assert.ok(tree.entries.length <= 40);
    assert.equal(query.operation,"find_nodes");
    assert.ok(query.nodes.length > 0);
    await assert.rejects(service.sourceTreePageAsync(projectId, {
      limit: 40, offset: 1, expectedSnapshotId:"tampered-stale-identity",
    }), /snapshot changed/);
    observe();
    return { size: Number(size), status: "bounded_parallel_read_pass",
      snapshotId: bootstrap.snapshotIdentity.snapshotId,
      candidateCount: tree.candidateCount, queryResultCount: query.nodes.length,
      childPeakRssMiB: childPeakRss(), baselineRssMiB:baseline, parentPeakRssMiB,
      treePeakRssMiB, maxTreeProcesses, samples, elapsedMs: Math.round(performance.now()-start) };
  } finally { clearInterval(timer); }
}
async function timeout(root,storage) {
  const { service } = createClient(root,storage,{timeoutMs:100,maxConcurrent:1,maxQueued:0});
  await assert.rejects(service.webBootstrapAsync(projectId),/timed out/);
  await new Promise(resolve=>setTimeout(resolve,350));
  const children = sampleTree().processes-1;
  assert.equal(children,0,"timed-out disposable read child must be reaped, not orphaned");
  return { status:"read_timeout_killed_child", childrenAfterTimeout:children };
}
async function exitOwner(root,storage) {
  const { service } = createClient(root,storage);
  // Run a graph-heavy child and exit the owning Node normally before it
  // finishes. The registered process-exit hook must kill its process group.
  void service.webBootstrapAsync(projectId).catch(() => {});
  await new Promise(resolve => setTimeout(resolve,90));
  const children = sampleTree().children.filter(entry => /(?:^|\/)node$/.test(entry.executable));
  assert.ok(children.length > 0,"an isolated read child must have spawned before owner shutdown");
  console.log(JSON.stringify({status:"owner_exiting",childPid:children[0].pid}));
  process.exit(0);
}
if (phase === "seed" || phase === "read" || phase === "timeout" || phase === "exit-owner") {
  const root = rootFor(process.argv[3]);
  const storage = process.argv[4];
  const size = process.argv[5];
  if (phase === "seed") await seed(root,storage,size);
  else if (phase === "exit-owner") await exitOwner(root,storage);
  else console.log(JSON.stringify(phase === "read"
    ? await read(root,storage,size) : await timeout(root,storage)));
} else if (phase === "all") {
  const root = mkdtempSync(join(tmpdir(),"questboard-s7-scale-root-"));
  const storage = mkdtempSync(join(tmpdir(),"questboard-s7-scale-storage-"));
  mkdirSync(join(root,"src"));
  writeFileSync(join(root,"composer.json"),'{"name":"fixture/s7-scale"}\n');
  writeFileSync(join(root,"src","Seed.php"),"<?php class Seed {}\n");
  const run = (mode,size) => {
    const out = spawnSync(process.execPath,[process.argv[1],mode,root,storage,String(size)],{
      cwd:process.cwd(),encoding:"utf8",timeout:170_000,maxBuffer:1024*1024*3 });
    if (out.status !== 0 || out.error) throw new Error(
      `S7 ${mode} ${size} failed: ${out.error?.message??""} ${out.stdout.slice(-2000)} ${out.stderr.slice(-1700)}`);
    return JSON.parse(out.stdout.trim().split("\n").at(-1));
  };
  const output = [];
  try {
    for(const count of [5_000,20_000,50_000]) {
      const seeded = run("seed",count);
      const measured = run("read",count);
      output.push({ seeded, measured });
      console.log(JSON.stringify({ stage:"scale", ...measured }));
    }
    output.push({ timeout:run("timeout",50_000) });
    const owner = run("exit-owner",50_000);
    await new Promise(resolve => setTimeout(resolve,400));
    let childAlive = true;
    try { process.kill(owner.childPid,0); } catch (error) {
      if (error?.code === "ESRCH") childAlive = false;
      else throw error;
    }
    assert.equal(childAlive,false,"normal owner exit must terminate the owned worker process group");
    output.push({ ownerExit: { status:"owner_exit_reaped_read_child",childAlive } });
    run("seed","ipc");
    output.push({ ipc:run("read","ipc") });
    const saved = JSON.parse(readFileSync(snapshotPath(storage),"utf8"));
    saved.snapshotId = "invalid-s7-corrupt-snapshot";
    writeFileSync(snapshotPath(storage),JSON.stringify(saved));
    output.push({ corrupt:run("read","corrupt") });
    console.log(JSON.stringify({ status:"S7_SCALE_STABILITY_PASS", results:output },null,2));
  } finally { rmSync(root,{recursive:true,force:true});rmSync(storage,{recursive:true,force:true}); }
} else throw Error("Unsupported probe phase");
