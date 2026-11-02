import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import {
  CODE_GRAPH_SCHEMA_VERSION,
  type CodeGraphSnapshot,
} from "../src/application/code-intelligence.js";
import { computeCodeMapSnapshotIdentity } from "../src/application/code-map-snapshot-identity.js";
import { createConfiguredCodeMapRuntime } from "../src/server/code-map-config.js";
import { createIsolatedCodeMapReadExecutor } from "../src/server/code-map-isolated-read.js";
import { SqliteQuestBoardRepository } from "../src/storage/sqlite/sqlite-quest-board-repository.js";
import { QuestBoardService } from "../src/application/quest-board-service.js";
import { SourceStructureFlowSyncService } from "../src/application/source-structure-flow-sync.js";
import { CodeMapInvestigationSyncService } from "../src/application/code-map-investigation-sync.js";
import { CodeScopeBindingService } from "../src/application/code-scope-binding.js";
import { executeQuestBoardAgentTool } from "../src/adapters/agent-tools.js";
import { createQuestBoardHttpServer } from "../src/server/http-api.js";

const actor = { id: "agent:s7-apply", provider: "test" };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const rootNode = (id: string, path: string) => ({
  id: "code:node:" + id, kind: "method" as const, name: id,
  canonicalIdentity: "php:synthetic:" + path + "#" + id,
  language: "php", location: { path, startLine: 1 },
});
function graph(projectId: string, rootPath: string): CodeGraphSnapshot {
  const nodes = [
    rootNode("handle", "src/Application/Handler.php"),
    rootNode("load", "src/Service/Loader.php"),
    rootNode("save", "src/Storage/Writer.php"),
    { id: "http-stable", kind: "function" as const, name: "handleRequest",
      canonicalIdentity: "src/server/http-api.ts#function:handleRequest",
      location: { path: "src/server/http-api.ts", startLine: 1 } },
    { id: "service-stable", kind: "method" as const, name: "createTask",
      canonicalIdentity: "src/application/quest-board-service.ts#method:QuestBoardService.createTask",
      location: { path: "src/application/quest-board-service.ts", startLine: 1 } },
  ];
  return {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION, projectId, rootPath,
    indexedAt: "2026-10-31T00:00:00.000Z",
    nodes,
    relations: [
      { id: "code:relation:call-1", from: nodes[0]!.id, to: nodes[1]!.id,
        kind: "calls", confidence: 0.99,
        evidence: [{ location: { path: "src/Application/Handler.php", startLine: 7 } }] },
      { id: "code:relation:call-2", from: nodes[1]!.id, to: nodes[2]!.id,
        kind: "calls", confidence: 0.95,
        evidence: [{ location: { path: "src/Service/Loader.php", startLine: 8 } }] },
      { id: "call-stable", from: "http-stable", to: "service-stable",
        kind: "calls", confidence: 1 },
    ],
  };
}

async function fixture(run: (x: Awaited<ReturnType<typeof setup>>) => Promise<void>): Promise<void> {
  const x = await setup();
  try { await run(x); }
  finally {
    x.repository.close();
    rmSync(x.directory, { recursive: true, force: true });
  }
}
async function setup() {
  const directory = mkdtempSync(join(tmpdir(), "questboard-s7-apply-"));
  const root = join(directory, "source");
  const storage = join(directory, "snapshots");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "composer.json"), '{"name":"test/s7-apply"}\n');
  writeFileSync(join(root, "src", "Seed.php"), "<?php class Seed {}\n");
  const canonicalRoot = realpathSync.native(root);
  const repository = new SqliteQuestBoardRepository(join(directory, "isolated.sqlite"));
  const tasks = new QuestBoardService(repository);
  const projectId = tasks.createProject({ name: "S7 Apply isolated", rootPath: canonicalRoot }, actor).id;
  const env = { HOME: process.env.HOME, PATH: process.env.PATH,
    QUESTBOARD_CODE_MAP: "1", QUESTBOARD_CODE_MAP_PROVIDERS: "scip-php",
    QUESTBOARD_CODE_MAP_STORAGE_ROOT: storage };
  const seed = createConfiguredCodeMapRuntime(env, repository).service!;
  await seed.refresh({ projectId, rootPath: canonicalRoot });
  const snapshotPath = join(storage, "snapshots", hash(projectId), "snapshot.json");
  const previous = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const actualGraph = graph(projectId, canonicalRoot);
  const exact = computeCodeMapSnapshotIdentity({
    projectId, rootIdentity: previous.rootIdentity,
    providerConfigFingerprint: previous.providerConfigFingerprint,
    sourceManifestFingerprint: previous.sourceManifestFingerprint,
    graph: actualGraph,
  });
  const envelope = { ...previous, graph: actualGraph, ...exact,
    persistedAt: new Date().toISOString() };
  const replaceSnapshot = (replacement: CodeGraphSnapshot = actualGraph) => {
    const identity = computeCodeMapSnapshotIdentity({
      projectId, rootIdentity: previous.rootIdentity,
      providerConfigFingerprint: previous.providerConfigFingerprint,
      sourceManifestFingerprint: previous.sourceManifestFingerprint,
      graph: replacement,
    });
    const next = { ...envelope, ...identity, graph: replacement };
    const temporary = join(dirname(snapshotPath), "snapshot." + randomUUID() + ".tmp");
    writeFileSync(temporary, JSON.stringify(next));
    renameSync(temporary, snapshotPath);
  };
  replaceSnapshot();
  const codeMap = createConfiguredCodeMapRuntime(env, repository).service!;
  codeMap.setIsolatedReadExecutor(createIsolatedCodeMapReadExecutor(env, { timeoutMs: 20_000 }));
  codeMap.getCached = () => { throw new Error("S7 isolated Apply MUST NOT load parent graph"); };
  const sync = new SourceStructureFlowSyncService(repository, {
    read: () => { throw new Error("S7 isolated Apply MUST NOT use legacy synchronous source"); },
  });
  const investigation = new CodeMapInvestigationSyncService(codeMap, repository);
  const bindings = new CodeScopeBindingService(codeMap, repository, tasks);
  const context = { service: tasks, codeMapService: codeMap,
    sourceStructureFlowSyncService: sync, codeMapInvestigationSyncService: investigation,
    codeScopeBindingService: bindings,
    sourceStructureApplyAuthority: (project: string, claimed: typeof actor) =>
      project === projectId && claimed.id === actor.id && claimed.provider === actor.provider
        ? actor : undefined };
  const candidate = await codeMap.querySourceSubsystemsAsync(projectId, {
    operation: "list_subsystems", offset: 0, limit: 12,
  });
  assert.equal(candidate.operation, "list_subsystems");
  assert.ok(candidate.nodes.length >= 3, "synthetic graph must contain real cross-file subsystems");
  const selection = { projectId, selectionKey: "s7-pinned",
    selectedSubsystemIds: candidate.nodes.slice(0, 3).map(node => node.id),
    offset: candidate.offset, limit: candidate.limit,
    expectedSnapshotId: candidate.snapshotId!,
    expectedSourceIndexedAt: candidate.sourceIndexedAt,
  };
  const derived = await codeMap.sourceStructurePreviewGraphAsync(projectId, selection);
  const preview = sync.previewTrustedProjection(projectId, selection.selectionKey, derived);
  const applyInput = { ...selection,
    approved: true, actor, requestId: "s7-apply-authorized-0001",
    expectedSelectionFingerprint: preview.selectionFingerprint,
    expectedSelectionRevision: preview.expectedSelectionRevision };
  return { directory, canonicalRoot, repository, projectId, codeMap, sync, investigation, bindings, tasks,
    context, selection, preview, applyInput, replaceSnapshot };
}

test("S7 trusted P2 Source Structure Apply is authorized, duplicate-safe, and never hydrates parent", { timeout: 35_000 }, async () => {
  await fixture(async x => {
    const { sourceStructureApplyAuthority: _unauthorized, ...denied } = x.context;
    await assert.rejects(Promise.resolve().then(() =>
      executeQuestBoardAgentTool(denied, "questboard_apply_source_structure_flow_sync", x.applyInput)),
      /unauthorized|permission|authority/i);
    assert.equal(x.repository.listInvestigationNodes(x.projectId).length, 0);
    const accepted = await Promise.resolve(executeQuestBoardAgentTool(
      x.context, "questboard_apply_source_structure_flow_sync", x.applyInput)) as {
        result: { createdNodes: number; createdRelationLinks: number; replayed: boolean };
      };
    assert.ok(accepted.result.createdNodes >= 3);
    assert.equal(accepted.result.replayed, false);
    const before = x.repository.listInvestigationNodes(x.projectId).length;
    const replay = await Promise.resolve(executeQuestBoardAgentTool(
      x.context, "questboard_apply_source_structure_flow_sync", x.applyInput)) as typeof accepted;
    assert.equal(replay.result.replayed, true);
    assert.equal(x.repository.listInvestigationNodes(x.projectId).length, before);
  });
});

test("S7 Source Structure Apply rejects snapshot replacement after worker read without writes", { timeout: 30_000 }, async () => {
  await fixture(async x => {
    const prior = x.codeMap.sourceStructureApplySourceAsync.bind(x.codeMap);
    x.codeMap.sourceStructureApplySourceAsync = async (...args) => {
      const source = await prior(...args);
      x.replaceSnapshot(); // Different inode, same graph bytes and exact snapshotId.
      return source;
    };
    await assert.rejects(Promise.resolve(executeQuestBoardAgentTool(
      x.context, "questboard_apply_source_structure_flow_sync", x.applyInput)), /snapshot changed/i);
    assert.equal(x.repository.listInvestigationNodes(x.projectId).length, 0);
    assert.equal(x.repository.sourceStructureBindings.listBindings(x.projectId).length, 0);
  });
});

test("S7 Source Structure Apply rolls back SQLite writes if snapshot changes just before commit", { timeout: 30_000 }, async () => {
  await fixture(async x => {
    const original = x.codeMap.assertSnapshotRevision.bind(x.codeMap);
    let checks = 0;
    x.codeMap.assertSnapshotRevision = (project, revision) => {
      checks++;
      if (checks === 3) x.replaceSnapshot(); // after writes, before SQLite commit
      original(project, revision);
    };
    await assert.rejects(Promise.resolve(executeQuestBoardAgentTool(
      x.context, "questboard_apply_source_structure_flow_sync", x.applyInput)), /snapshot changed/i);
    assert.equal(checks, 3);
    assert.equal(x.repository.listInvestigationNodes(x.projectId).length, 0);
    assert.equal(x.repository.listInvestigationItems(x.projectId).length, 0);
    assert.equal(x.repository.sourceStructureBindings.listBindings(x.projectId).length, 0);
  });
});

test("S7 Code→Flow isolated Apply uses exact projection and rejects stale file revision without parent hydration", { timeout: 30_000 }, async () => {
  await fixture(async x => {
    const src = await x.codeMap.investigationPreviewSourceAsync(x.projectId);
    const preview = x.investigation.previewTrustedProjection(x.projectId, src);
    assert.ok(preview.nodes.length > 0);
    const input = { projectId: x.projectId, expectedProjectionFingerprint: preview.projectionFingerprint,
      actor, requestId: "s7-investigation-apply-0001" };
    const applied = await Promise.resolve(executeQuestBoardAgentTool(
      x.context, "questboard_apply_code_map_investigation_sync", input)) as {
        result: { counts: { createdNodes: number } };
      };
    assert.ok(applied.result.counts.createdNodes > 0);
    const before = x.repository.listInvestigationNodes(x.projectId).length;
    const prior = x.codeMap.investigationPreviewSourceAsync.bind(x.codeMap);
    x.codeMap.investigationPreviewSourceAsync = async (...args) => {
      const source = await prior(...args);
      x.replaceSnapshot();
      return source;
    };
    await assert.rejects(Promise.resolve(executeQuestBoardAgentTool(
      x.context, "questboard_apply_code_map_investigation_sync", {
        ...input, requestId: "s7-investigation-apply-0002" })), /snapshot changed/i);
    assert.equal(x.repository.listInvestigationNodes(x.projectId).length, before);
  });
});

test("S7 HTTP Source Structure P2 Apply enforces transport authority and replays the exact transaction", { timeout: 30_000 }, async () => {
  await fixture(async x => {
    const server = createQuestBoardHttpServer(x.tasks, {
      codeMapService: x.codeMap,
      sourceStructureFlowSyncService: x.sync,
      authorizeSourceStructureApply: (request, project, claimed) =>
        request.headers["x-s7-fixture-auth"] === "trusted-session"
          && project === x.projectId && claimed.id === actor.id
          && claimed.provider === actor.provider ? actor : undefined,
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const route = `http://127.0.0.1:${(server.address() as AddressInfo).port}/projects/${x.projectId}/source-structure/flow-sync/apply`;
      const headers = { "content-type": "application/json",
        "x-questboard-actor-id": actor.id,
        "x-questboard-actor-provider": actor.provider,
        "x-questboard-request-id": x.applyInput.requestId };
      const post = async (trusted: boolean) => {
        const response = await fetch(route, { method: "POST",
          headers: { ...headers, ...(trusted ? { "x-s7-fixture-auth": "trusted-session" } : {}) },
          body: JSON.stringify(x.applyInput) });
        return { status: response.status, body: await response.json() as any };
      };
      const denied = await post(false);
      assert.equal(denied.status, 403);
      assert.equal(denied.body.error.code, "source_structure_apply_unauthorized");
      assert.equal(x.repository.listInvestigationNodes(x.projectId).length, 0);
      const first = await post(true);
      assert.equal(first.status, 200);
      assert.ok(first.body.result.createdNodes > 0);
      const second = await post(true);
      assert.equal(second.status, 200);
      assert.equal(second.body.result.replayed, true);
      assert.equal(x.repository.listInvestigationNodes(x.projectId).length,
        first.body.result.createdNodes);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

test("S7 HTTP Code→Flow P2 Preview and Apply share the same fingerprint without parent graph loading", { timeout: 30_000 }, async () => {
  await fixture(async x => {
    const server = createQuestBoardHttpServer(x.tasks, {
      codeMapService: x.codeMap,
      codeMapInvestigationSyncService: x.investigation,
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/projects/${x.projectId}/code-map/investigation-sync`;
      const headers = { "content-type": "application/json",
        "x-questboard-actor-id": actor.id,
        "x-questboard-actor-provider": actor.provider,
        "x-questboard-request-id": "s7-http-investigation-0001" };
      const previewResponse = await fetch(base + "/preview", {
        method: "POST", headers, body: JSON.stringify({ includeRelations: true }),
      });
      assert.equal(previewResponse.status, 200);
      const previewBody = await previewResponse.json() as any;
      const fingerprint = previewBody.preview.projectionFingerprint as string;
      assert.equal(fingerprint.length, 64);
      const applyResponse = await fetch(base + "/apply", {
        method: "POST", headers,
        body: JSON.stringify({ includeRelations: true, expectedProjectionFingerprint: fingerprint }),
      });
      assert.equal(applyResponse.status, 200);
      const applyBody = await applyResponse.json() as any;
      assert.ok(applyBody.result.counts.createdNodes > 0);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

test("S7 P2 CodeScope attach/task creation uses exact native child node and rolls back a changed source", { timeout: 30_000 }, async () => {
  await fixture(async x => {
    const task = x.tasks.createTask({ projectId: x.projectId, title: "Pinned CodeScope task" }, actor);
    const input = { projectId: x.projectId, taskId: task.id,
      codeNodeId: "code:node:handle", actor, requestId: "s7-codescope-attach-0001" };
    const attached = await Promise.resolve(executeQuestBoardAgentTool(
      x.context, "questboard_attach_task_code_scope", input)) as any;
    assert.equal(attached.codeScopeBinding.state, "active");
    assert.equal(attached.codeScopeBinding.codeNode.id, input.codeNodeId);
    const replay = await Promise.resolve(executeQuestBoardAgentTool(
      x.context, "questboard_attach_task_code_scope", input)) as any;
    assert.equal(replay.codeScopeBinding.id, attached.codeScopeBinding.id);
    const list = await Promise.resolve(executeQuestBoardAgentTool(
      x.context, "questboard_list_code_scope_bindings", { projectId: x.projectId })) as any;
    assert.equal(list.codeScopeBindings.length, 1);
    assert.equal(list.codeScopeBindings[0].state, "unverified");
    const beforeTasks = x.repository.listTasks({ projectId: x.projectId }).length;
    const beforeBindings = x.repository.listTaskCodeScopeBindings(x.projectId).length;
    const original = x.codeMap.pinnedNodeForMutation.bind(x.codeMap);
    x.codeMap.pinnedNodeForMutation = async (...args) => {
      const pinned = await original(...args);
      x.replaceSnapshot();
      return pinned;
    };
    await assert.rejects(Promise.resolve(executeQuestBoardAgentTool(
      x.context, "questboard_create_task_for_code_scope",
      { projectId: x.projectId, codeNodeId: "code:node:load",
        title: "Must not persist after snapshot change", actor,
        requestId: "s7-codescope-create-stale-0002" })), /snapshot changed/i);
    assert.equal(x.repository.listTasks({ projectId: x.projectId }).length, beforeTasks);
    assert.equal(x.repository.listTaskCodeScopeBindings(x.projectId).length, beforeBindings);
  });
});

test("S7 P2 HTTP CodeScope attach and Task creation never hydrate the daemon raw graph", { timeout: 30_000 }, async () => {
  await fixture(async x => {
    const task = x.tasks.createTask({ projectId: x.projectId, title: "HTTP scoped task" }, actor);
    const server = createQuestBoardHttpServer(x.tasks, {
      codeMapService: x.codeMap, codeScopeBindingService: x.bindings,
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/projects/${x.projectId}`;
      const headers = { "content-type": "application/json",
        "x-questboard-actor-id": actor.id,
        "x-questboard-actor-provider": actor.provider,
        "x-questboard-request-id": "s7-http-codescope-0001" };
      const attach = await fetch(base + "/code-scope-bindings", {
        method: "POST", headers, body: JSON.stringify({
          taskId: task.id, codeNodeId: "code:node:handle",
        }),
      });
      assert.equal(attach.status, 201);
      const body = await attach.json() as any;
      assert.equal(body.codeScopeBinding.state, "active");
      const created = await fetch(base + "/code-scope-tasks", {
        method: "POST",
        headers: { ...headers, "x-questboard-request-id": "s7-http-codescope-create-0002" },
        body: JSON.stringify({ codeNodeId: "code:node:load", title: "HTTP P2 scoped Task" }),
      });
      assert.equal(created.status, 201);
      const result = await created.json() as any;
      assert.equal(result.binding.state, "active");
      assert.equal(x.repository.listTaskCodeScopeBindings(x.projectId).length, 2);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

test("S7 P2 CodeScope relink accepts only a unique native identity and preserves revision CAS", { timeout: 30_000 }, async () => {
  await fixture(async x => {
    const task = x.tasks.createTask({ projectId: x.projectId, title: "Relink owned node" }, actor);
    const attached = await Promise.resolve(executeQuestBoardAgentTool(
      x.context, "questboard_attach_task_code_scope", {
        projectId: x.projectId, taskId: task.id,
        codeNodeId: "code:node:handle", actor, requestId: "s7-relink-attach-0001",
      })) as any;
    const bindingId = attached.codeScopeBinding.id;
    const next = graph(x.projectId, x.canonicalRoot);
    const changeId = (id: string) => id === "code:node:handle"
      ? "code:node:handle-reindexed" : id;
    x.replaceSnapshot({
      ...next,
      indexedAt: "2026-10-31T00:02:00.000Z",
      nodes: next.nodes.map(node => ({ ...node, id: changeId(node.id) })),
      relations: next.relations.map(relation => ({
        ...relation, from: changeId(relation.from), to: changeId(relation.to),
      })),
    });
    const updated = await Promise.resolve(executeQuestBoardAgentTool(
      x.context, "questboard_relink_task_code_scope", {
        bindingId, actor, expectedRevision: 1, requestId: "s7-relink-unique-0002",
      })) as any;
    assert.equal(updated.codeScopeBinding.codeNodeId, "code:node:handle-reindexed");
    assert.equal(updated.codeScopeBinding.codeCanonicalIdentity,
      attached.codeScopeBinding.codeCanonicalIdentity);
    assert.equal(updated.codeScopeBinding.revision, 2);
    const record = x.repository.getTaskCodeScopeBinding(bindingId)!;
    assert.equal(record.codeNodeId, "code:node:handle-reindexed");
    await assert.rejects(Promise.resolve(executeQuestBoardAgentTool(
      x.context, "questboard_relink_task_code_scope", {
        bindingId, actor, expectedRevision: 1, requestId: "s7-relink-stale-revision-0003",
      })), /revision|conflict/i);
    assert.equal(x.repository.getTaskCodeScopeBinding(bindingId)!.revision, 2);
  });
});

test("S7 P2 CodeScope relink rejects ambiguous native identities without a database mutation", { timeout: 30_000 }, async () => {
  await fixture(async x => {
    const task = x.tasks.createTask({ projectId: x.projectId, title: "Ambiguous code binding" }, actor);
    const attached = await Promise.resolve(executeQuestBoardAgentTool(
      x.context, "questboard_attach_task_code_scope", {
        projectId: x.projectId, taskId: task.id,
        codeNodeId: "code:node:handle", actor, requestId: "s7-relink-ambiguous-attach-0001",
      })) as any;
    const original = graph(x.projectId, x.canonicalRoot);
    const old = original.nodes.find(node => node.id === "code:node:handle")!;
    x.replaceSnapshot({
      ...original, indexedAt: "2026-10-31T00:05:00.000Z",
      nodes: [
        ...original.nodes.filter(node => node.id !== old.id),
        { ...old, id: "code:node:duplicate-first" },
        { ...old, id: "code:node:duplicate-second" },
      ],
      relations: original.relations.filter(relation => relation.from !== old.id && relation.to !== old.id),
    });
    await assert.rejects(Promise.resolve(executeQuestBoardAgentTool(
      x.context, "questboard_relink_task_code_scope", {
        bindingId: attached.codeScopeBinding.id, actor,
        expectedRevision: 1, requestId: "s7-relink-ambiguous-attempt-0002",
      })), /no unique relink|unavailable|ambiguous/i);
    const unchanged = x.repository.getTaskCodeScopeBinding(attached.codeScopeBinding.id)!;
    assert.equal(unchanged.revision, 1);
    assert.equal(unchanged.codeNodeId, "code:node:handle");
  });
});
