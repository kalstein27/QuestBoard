import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { CodeMapQueryError } from "../src/application/code-map-query.js";
import { QuestBoardService } from "../src/application/quest-board-service.js";
import { SqliteQuestBoardRepository } from "../src/storage/sqlite/sqlite-quest-board-repository.js";
import { executeQuestBoardAgentTool } from "../src/adapters/agent-tools.js";
import { createQuestBoardHttpServer } from "../src/server/http-api.js";
import { SourceStructureFlowSyncService } from "../src/application/source-structure-flow-sync.js";
import { CodeMapInvestigationSyncService } from "../src/application/code-map-investigation-sync.js";
import { CodeScopeBindingService } from "../src/application/code-scope-binding.js";
import type { CodeMapManualRelationReader } from "../src/application/code-map-augmentation.js";
import type { QuestBoardRepository } from "../src/application/quest-board-repository.js";
import { createConfiguredCodeMapRuntime } from "../src/server/code-map-config.js";
import { createIsolatedCodeMapReadExecutor } from "../src/server/code-map-isolated-read.js";

function isolatedFixture() {
  const root = mkdtempSync(join(tmpdir(), "qb-p2-php-root-"));
  const storage = mkdtempSync(join(tmpdir(), "qb-p2-php-storage-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "composer.json"), '{"name":"example/p2"}\n');
  writeFileSync(join(root, "src", "Handler.php"), "<?php class Handler {}\n");
  writeFileSync(join(root, "src", "Service.php"), "<?php class Service {}\n");
  const projectId = "p2-isolated-php";
  const canonicalRoot = realpathSync.native(root);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    QUESTBOARD_CODE_MAP: "1",
    QUESTBOARD_CODE_MAP_PROVIDERS: "scip-php",
    QUESTBOARD_CODE_MAP_STORAGE_ROOT: storage,
  };
  const reader = {
    listCodeMapManualRelations: () => [],
    getProject: (id: string) => id === projectId
      ? { id, rootPath: canonicalRoot } : undefined,
  } as unknown as CodeMapManualRelationReader & Pick<QuestBoardRepository, "getProject">;
  return { root, storage, projectId, canonicalRoot, env, reader,
    dispose: () => { rmSync(root, { recursive: true, force: true }); rmSync(storage, { recursive: true, force: true }); } };
}

test("P2 async queries match local reads and never hydrate the parent raw graph", { timeout: 40_000 }, async () => {
  const f = isolatedFixture();
  try {
    const seed = createConfiguredCodeMapRuntime(f.env, f.reader).service!;
    await seed.refresh({ projectId: f.projectId, rootPath: f.canonicalRoot });
    const originalQuery = seed.query(f.projectId, { operation: "find_nodes", query: "Handler.php" });
    assert.equal(originalQuery.operation, "find_nodes");
    assert.ok(seed.snapshotIdentity(f.projectId)?.snapshotId);

    const parent = createConfiguredCodeMapRuntime(f.env, f.reader).service!;
    const rssSamples: number[] = [];
    parent.setIsolatedReadExecutor(createIsolatedCodeMapReadExecutor(f.env, {
      timeoutMs: 15_000, onProcessMetrics: ({ childMaxRssMiB }) => rssSamples.push(childMaxRssMiB),
    }));

    // Direct hydration and synchronous graph operations are forbidden in this
    // test. P2 queries must not accidentally fall through to the parent.
    parent.getCached = () => { throw new Error("P2 parent graph hydration forbidden"); };
    parent.query = () => { throw new Error("P2 parent query forbidden"); };
    parent.queryContinuations = () => { throw new Error("P2 parent continuation forbidden"); };
    parent.querySourceSubsystems = () => { throw new Error("P2 parent subsystem query forbidden"); };
    parent.sourceSubsystems = () => { throw new Error("P2 parent full subsystem read forbidden"); };

    const remoteQuery = await parent.queryAsync(f.projectId, { operation: "find_nodes", query: "Handler.php" });
    assert.deepEqual(remoteQuery, originalQuery);
    const remoteHierarchy = await parent.queryAsync(f.projectId, {
      operation: "hierarchy", nodeId: originalQuery.operation === "find_nodes" ? originalQuery.nodes[0]!.id : "", limit: 10,
    });
    assert.equal(remoteHierarchy.operation, "hierarchy");
    const continuation = await parent.queryContinuationsAsync(f.projectId, { nodeId: originalQuery.operation === "find_nodes" ? originalQuery.nodes[0]!.id : "" });
    assert.ok(continuation);
    const sourcePage = await parent.querySourceSubsystemsAsync(f.projectId, { operation: "list_subsystems", limit: 12 });
    assert.equal(sourcePage.operation, "list_subsystems");
    assert.equal(sourcePage.candidateCount, 0, "file-only PHP cannot invent semantic calls");
    const subsystems = await parent.sourceSubsystemsAsync(f.projectId);
    assert.equal(subsystems.nodes.length, 0);
    const status = await parent.snapshotReadSummary(f.projectId);
    assert.equal(status.indexed, true);
    assert.equal(status.nodeCount, seed.getCached(f.projectId)!.graph.nodes.length);
    assert.equal(status.snapshotIdentity?.snapshotId, seed.snapshotIdentity(f.projectId)?.snapshotId);
    assert.ok(rssSamples.length >= 6, "every bounded read runs in an isolated child");
    assert.ok(rssSamples.every((rss) => rss > 0));
    await assert.rejects(
      parent.queryAsync(f.projectId, { operation: "find_nodes", query: "Handler", expectedSnapshotId: "stale-p2-snapshot" }),
      (error: unknown) => error instanceof CodeMapQueryError && error.code === "code_map_snapshot_changed",
    );
  } finally {
    f.dispose();
  }
});

test("P2 isolated bounded read fails closed on a project without a trusted registered root", { timeout: 15_000 }, async () => {
  const f = isolatedFixture();
  try {
    const parent = createConfiguredCodeMapRuntime(f.env, f.reader).service!;
    parent.setIsolatedReadExecutor(createIsolatedCodeMapReadExecutor(f.env));
    await assert.rejects(
      parent.queryAsync("forged-project-id", { operation: "find_nodes", query: "anything" }),
      (error: unknown) => error instanceof CodeMapQueryError && error.code === "code_map_not_indexed",
    );
  } finally {
    f.dispose();
  }
});

test("P2 Web/HTTP and direct agent bounded queries agree without daemon graph hydration", { timeout: 30_000 }, async () => {
  const f = isolatedFixture();
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  const project = service.createProject(
    { name: "P2 isolated HTTP", rootPath: f.canonicalRoot },
    { id: "human:p2", provider: "test" },
  );
  const env = f.env;
  const seed = createConfiguredCodeMapRuntime(env, repository).service!;
  const parent = createConfiguredCodeMapRuntime(env, repository).service!;
  const sync = new SourceStructureFlowSyncService(repository, {
    read: () => { throw new Error("P2 Source Structure read must not load the parent graph"); },
  });
  const investigationSync = new CodeMapInvestigationSyncService(parent, repository);
  const bindingService = new CodeScopeBindingService(parent, repository, service);
  const server = createQuestBoardHttpServer(service, {
    codeMapService: parent, sourceStructureFlowSyncService: sync,
    codeMapInvestigationSyncService: investigationSync,
    codeScopeBindingService: bindingService,
  });
  try {
    await seed.refresh({ projectId: project.id, rootPath: f.canonicalRoot });
    parent.setIsolatedReadExecutor(createIsolatedCodeMapReadExecutor(env));
    parent.getCached = () => { throw new Error("HTTP must never hydrate the daemon graph"); };
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/projects/${encodeURIComponent(project.id)}/code-map`;
    const statusResp = await fetch(`${base}/status`);
    assert.equal(statusResp.status, 200);
    const status = await statusResp.json() as { codeMap: { indexed: boolean; nodeCount: number } };
    assert.equal(status.codeMap.indexed, true);
    assert.ok(status.codeMap.nodeCount > 0);
    const bootstrapResp = await fetch(base);
    assert.equal(bootstrapResp.status, 200);
    const bootstrap = await bootstrapResp.json() as {
      indexed: boolean; boundedSourceTree: boolean; graph: unknown; projection: unknown;
      nodeCount: number; snapshotId: string; nodeKinds: string[];
    };
    assert.equal(bootstrap.indexed, true);
    assert.equal(bootstrap.boundedSourceTree, true);
    assert.equal(bootstrap.graph, null, "no full Code Map graph can cross Web bootstrap");
    const bindingResp = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/projects/${encodeURIComponent(project.id)}/code-scope-bindings`);
    assert.equal(bindingResp.status, 200);
    const bindingBody = await bindingResp.json() as { codeScopeBindings: unknown[] };
    assert.deepEqual(bindingBody.codeScopeBindings, [],
      "Task CodeScope read-only list must not hydrate the parent graph");
    assert.ok(bootstrap.nodeCount > 0);
    assert.ok(bootstrap.projection);
    assert.ok(bootstrap.nodeKinds.includes("file"));
    const rootTreeResp = await fetch(`${base}/source-tree?limit=1&expectedSnapshotId=${encodeURIComponent(bootstrap.snapshotId)}`);
    assert.equal(rootTreeResp.status, 200);
    const rootTree = await rootTreeResp.json() as { page: {
      entries: Array<{ type: string; name: string; path: string }>;
      snapshotId: string; candidateCount: number;
    } };
    assert.equal(rootTree.page.snapshotId, bootstrap.snapshotId);
    assert.deepEqual(rootTree.page.entries.map((item) => item.name), ["src"]);
    const srcTreeResp = await fetch(
      `${base}/source-tree?pathPrefix=src&limit=1&expectedSnapshotId=${encodeURIComponent(bootstrap.snapshotId)}`);
    assert.equal(srcTreeResp.status, 200);
    const srcTree = await srcTreeResp.json() as { page: {
      entries: Array<{ type: string; node?: { kind: string } }>; candidateCount: number; hasMore: boolean;
    } };
    assert.equal(srcTree.page.candidateCount, 2);
    assert.equal(srcTree.page.entries[0]?.type, "file");
    assert.equal(srcTree.page.entries[0]?.node?.kind, "file");
    assert.equal(srcTree.page.hasMore, true);
    const badPin = await fetch(`${base}/source-tree?expectedSnapshotId=stale-p2-web-pin`);
    assert.notEqual(badPin.status, 200, "stale directory page must fail closed");
    const fullGraphLegacy = await fetch(base, { method: "POST" });
    assert.equal(fullGraphLegacy.status, 409,
      "legacy synchronous graph refresh must not bypass isolated P1/P2 mode");
    const sourceCandidatesResp = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/projects/${encodeURIComponent(project.id)}/source-structure/flow-sync/candidates`);
    assert.equal(sourceCandidatesResp.status, 200);
    const sourceCandidates = await sourceCandidatesResp.json() as {
      candidates: { candidateCount: number; snapshotId: string };
    };
    assert.equal(sourceCandidates.candidates.candidateCount, 0);
    assert.equal(sourceCandidates.candidates.snapshotId, bootstrap.snapshotId);
    const legacySyncPreviewResponse = await fetch(`${base}/investigation-sync/preview`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ includeRelations: true }),
    });
    assert.equal(legacySyncPreviewResponse.status, 200,
      "compatibility Code→Flow preview uses the isolated projection, not parent getCached");
    const syncPreview = await legacySyncPreviewResponse.json() as {
      preview: { projectId: string; sourceIndexedAt: string; projectionFingerprint: string };
    };
    assert.equal(syncPreview.preview.projectId, project.id);
    assert.ok(syncPreview.preview.projectionFingerprint);
    const agentSync = await executeQuestBoardAgentTool(
      { service, codeMapService: parent, codeMapInvestigationSyncService: investigationSync },
      "questboard_preview_code_map_investigation_sync",
      { projectId: project.id, includeRelations: true },
    ) as { preview: unknown };
    assert.deepEqual(agentSync.preview, syncPreview.preview,
      "agent and Web isolated compatibility previews use the same raw source revision");
    const queryArgs = { operation: "find_nodes", query: "Handler.php", limit: 5 };
    const queryResp = await fetch(`${base}/query`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(queryArgs),
    });
    assert.equal(queryResp.status, 200);
    const httpQuery = await queryResp.json() as { query: { operation: string; nodes: unknown[] } };
    assert.equal(httpQuery.query.operation, "find_nodes");
    const agent = await executeQuestBoardAgentTool(
      { service, codeMapService: parent }, "questboard_query_code_map",
      { ...queryArgs, projectId: project.id },
    ) as { query: unknown };
    assert.deepEqual(agent.query, httpQuery.query);
    const subsystems = await fetch(`${base}/subsystems`);
    assert.equal(subsystems.status, 200);
    const subBody = await subsystems.json() as { subsystems: { nodes: unknown[] } };
    assert.deepEqual(subBody.subsystems.nodes, []);
    const filtered = await fetch(`${base}/subsystems/query`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "list_subsystems", limit: 12 }),
    });
    assert.equal(filtered.status, 200);
    const filteredBody = await filtered.json() as { query: { candidateCount: number } };
    assert.equal(filteredBody.query.candidateCount, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    repository.close();
    f.dispose();
  }
});
