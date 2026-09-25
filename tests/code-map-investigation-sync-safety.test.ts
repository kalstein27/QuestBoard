import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_GRAPH_SCHEMA_VERSION,
  CodeMapInvestigationSyncService,
  CodeMapService,
  QuestBoardService,
  SqliteQuestBoardRepository,
  type ActorRef,
  type CodeGraphSnapshot,
  type CodeIndexRequest,
  type CodeIntelligenceProvider,
} from "../src/index.js";

const actor: ActorRef = { id: "agent:code-map-sync-safety", provider: "test" };

class MutableProvider implements CodeIntelligenceProvider {
  readonly capabilities = { incrementalIndexing: true, impactAnalysis: false, callTrace: false } as const;
  readonly providerId = "test-provider";
  readonly #snapshots: CodeGraphSnapshot[];

  constructor(snapshots: CodeGraphSnapshot[]) {
    this.#snapshots = [...snapshots];
  }

  async indexProject(_request: CodeIndexRequest): Promise<CodeGraphSnapshot> {
    const snapshot = this.#snapshots.shift();
    if (!snapshot) throw new Error("Unexpected provider call");
    return snapshot;
  }
}

function fullGraph(projectId: string, indexedAt: string): CodeGraphSnapshot {
  return {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId,
    rootPath: "/workspace/project",
    indexedAt,
    nodes: [
      {
        id: "http-stable",
        kind: "function",
        name: "handleRequest",
        canonicalIdentity: "src/server/http-api.ts#function:handleRequest",
        location: { path: "src/server/http-api.ts", startLine: 1 },
      },
      {
        id: "service-stable",
        kind: "method",
        name: "createTask",
        canonicalIdentity: "src/application/quest-board-service.ts#method:QuestBoardService.createTask",
        location: { path: "src/application/quest-board-service.ts", startLine: 1 },
      },
    ],
    relations: [
      {
        id: "call-stable",
        from: "http-stable",
        to: "service-stable",
        kind: "calls",
        confidence: 1,
      },
    ],
  };
}

function httpOnlyGraph(projectId: string, indexedAt: string): CodeGraphSnapshot {
  return {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId,
    rootPath: "/workspace/project",
    indexedAt,
    nodes: [
      {
        id: "http-stable",
        kind: "function",
        name: "handleRequest",
        canonicalIdentity: "src/server/http-api.ts#function:handleRequest",
        location: { path: "src/server/http-api.ts", startLine: 1 },
      },
    ],
    relations: [],
  };
}

async function setup(snapshots: CodeGraphSnapshot[]) {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  const project = service.createProject({ name: "Sync safety" }, actor);
  const codeMap = new CodeMapService(new MutableProvider(snapshots.map((snapshot) => ({ ...snapshot, projectId: project.id }))));
  const sync = new CodeMapInvestigationSyncService(codeMap, repository);
  await codeMap.refresh({ projectId: project.id, rootPath: "/workspace/project" });
  return { repository, service, project, codeMap, sync };
}

function withProject(snapshot: CodeGraphSnapshot, projectId: string): CodeGraphSnapshot {
  return { ...snapshot, projectId };
}

test("a different requestId on the same projection is idempotent and leaves ordinary Investigation content alone", async () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  const project = service.createProject({ name: "Idempotent resync" }, actor);
  const codeMap = new CodeMapService(new MutableProvider([
    fullGraph(project.id, "2026-09-24T12:00:00.000Z"),
  ]));
  const sync = new CodeMapInvestigationSyncService(codeMap, repository);

  const manualNode = service.createInvestigationNode(
    { projectId: project.id, title: "Manual investigation", description: "Human-only content", kind: "manual" },
    actor,
  );
  await codeMap.refresh({ projectId: project.id, rootPath: "/workspace/project" });
  const preview = sync.preview(project.id);
  const first = sync.apply(
    project.id,
    { expectedProjectionFingerprint: preview.projectionFingerprint },
    actor,
    "sync-safety-first-001",
  );
  assert.equal(first.counts.createdNodes, 2);
  assert.equal(first.counts.createdRelationItems, 1);
  assert.equal(first.counts.createdRelationLinks, 1);

  const secondPreview = sync.preview(project.id);
  assert.equal(secondPreview.counts.nodes.unchanged, 2);
  assert.equal(secondPreview.counts.relations.unchanged, 1);
  const second = sync.apply(
    project.id,
    { expectedProjectionFingerprint: secondPreview.projectionFingerprint },
    actor,
    "sync-safety-second-002",
  );
  assert.equal(second.counts.createdNodes, 0);
  assert.equal(second.counts.createdRelationItems, 0);
  assert.equal(second.counts.createdRelationLinks, 0);
  assert.equal(second.counts.unchangedNodes, 2);
  assert.equal(second.counts.unchangedRelations, 1);

  const graph = service.getInvestigationGraph(project.id);
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.items.length, 1);
  assert.equal(graph.itemLinks.length, 1);
  assert.deepEqual(service.getInvestigationNode(manualNode.id), manualNode);
  repository.close();
});

test("disappeared Code Map sources become stale without deletion and reactivate in place when they return", async () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  const project = service.createProject({ name: "Stale round trip" }, actor);
  const codeMap = new CodeMapService(new MutableProvider([
    fullGraph(project.id, "2026-09-24T12:00:00.000Z"),
    httpOnlyGraph(project.id, "2026-09-24T12:05:00.000Z"),
    fullGraph(project.id, "2026-09-24T12:10:00.000Z"),
  ]));
  const sync = new CodeMapInvestigationSyncService(codeMap, repository);

  await codeMap.refresh({ projectId: project.id, rootPath: "/workspace/project" });
  const initialPreview = sync.preview(project.id);
  sync.apply(
    project.id,
    { expectedProjectionFingerprint: initialPreview.projectionFingerprint },
    actor,
    "sync-safety-stale-initial-001",
  );
  const initialGraph = service.getInvestigationGraph(project.id);
  const initialNodeIds = initialGraph.nodes.map((node) => node.id).sort();
  const initialItemIds = initialGraph.items.map((item) => item.id).sort();
  const initialLinkIds = initialGraph.itemLinks.map((link) => link.id).sort();

  await codeMap.refresh({
    projectId: project.id,
    rootPath: "/workspace/project",
    changes: [{ path: "src/application/quest-board-service.ts", kind: "deleted" }],
  });
  const stalePreview = sync.preview(project.id);
  assert.equal(stalePreview.counts.nodes.stale, 1);
  assert.equal(stalePreview.counts.relations.stale, 1);
  const staleResult = sync.apply(
    project.id,
    { expectedProjectionFingerprint: stalePreview.projectionFingerprint },
    actor,
    "sync-safety-stale-apply-002",
  );
  assert.equal(staleResult.counts.staleBindings, 2);

  const staleGraph = service.getInvestigationGraph(project.id);
  assert.deepEqual(staleGraph.nodes.map((node) => node.id).sort(), initialNodeIds);
  assert.deepEqual(staleGraph.items.map((item) => item.id).sort(), initialItemIds);
  assert.deepEqual(staleGraph.itemLinks.map((link) => link.id).sort(), initialLinkIds);

  await codeMap.refresh({
    projectId: project.id,
    rootPath: "/workspace/project",
    changes: [{ path: "src/application/quest-board-service.ts", kind: "added" }],
  });
  const returnPreview = sync.preview(project.id);
  assert.ok(returnPreview.counts.nodes.evidence_changed >= 1);
  assert.equal(returnPreview.counts.relations.evidence_changed, 1);
  const returned = sync.apply(
    project.id,
    { expectedProjectionFingerprint: returnPreview.projectionFingerprint },
    actor,
    "sync-safety-stale-return-003",
  );
  assert.equal(returned.counts.createdNodes, 0);
  assert.equal(returned.counts.createdRelationItems, 0);
  assert.equal(returned.counts.createdRelationLinks, 0);

  const afterReturn = service.getInvestigationGraph(project.id);
  assert.deepEqual(afterReturn.nodes.map((node) => node.id).sort(), initialNodeIds);
  assert.deepEqual(afterReturn.items.map((item) => item.id).sort(), initialItemIds);
  assert.deepEqual(afterReturn.itemLinks.map((link) => link.id).sort(), initialLinkIds);
  const finalPreview = sync.preview(project.id);
  assert.equal(finalPreview.counts.nodes.unchanged, 2);
  assert.equal(finalPreview.counts.relations.unchanged, 1);
  repository.close();
});

test("deleted generated Item or link stays detached until recreateDetached is explicitly requested", async () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  const project = service.createProject({ name: "Detached relation" }, actor);
  const codeMap = new CodeMapService(new MutableProvider([
    fullGraph(project.id, "2026-09-24T12:00:00.000Z"),
  ]));
  const sync = new CodeMapInvestigationSyncService(codeMap, repository);

  await codeMap.refresh({ projectId: project.id, rootPath: "/workspace/project" });
  const initialPreview = sync.preview(project.id);
  sync.apply(
    project.id,
    { expectedProjectionFingerprint: initialPreview.projectionFingerprint },
    actor,
    "sync-safety-detached-initial-001",
  );
  const initialGraph = service.getInvestigationGraph(project.id);
  const deletedItemId = initialGraph.items[0]!.id;
  service.deleteInvestigationItem(deletedItemId, actor);

  const detachedPreview = sync.preview(project.id);
  assert.equal(detachedPreview.counts.relations.detached, 1);
  assert.throws(
    () => sync.apply(
      project.id,
      { expectedProjectionFingerprint: detachedPreview.projectionFingerprint },
      actor,
      "sync-safety-detached-default-002",
    ),
    /recreateDetached=true/,
  );
  const stillDetached = service.getInvestigationGraph(project.id);
  assert.equal(stillDetached.nodes.length, 2);
  assert.equal(stillDetached.items.length, 0);
  assert.equal(stillDetached.itemLinks.length, 0);

  const recreatePreview = sync.preview(project.id, { recreateDetached: true });
  const recreated = sync.apply(
    project.id,
    { recreateDetached: true, expectedProjectionFingerprint: recreatePreview.projectionFingerprint },
    actor,
    "sync-safety-detached-recreate-003",
  );
  assert.equal(recreated.counts.createdRelationItems, 1);
  assert.equal(recreated.counts.createdRelationLinks, 1);
  const afterRecreate = service.getInvestigationGraph(project.id);
  assert.equal(afterRecreate.items.length, 1);
  assert.equal(afterRecreate.itemLinks.length, 1);
  assert.notEqual(afterRecreate.items[0]!.id, deletedItemId);

  const recreatedLinkId = afterRecreate.itemLinks[0]!.id;
  service.removeInvestigationItemLink(recreatedLinkId, actor);
  const linkDetachedPreview = sync.preview(project.id);
  assert.equal(linkDetachedPreview.counts.relations.detached, 1);
  assert.throws(
    () => sync.apply(
      project.id,
      { expectedProjectionFingerprint: linkDetachedPreview.projectionFingerprint },
      actor,
      "sync-safety-link-detached-default-004",
    ),
    /recreateDetached=true/,
  );
  const afterLinkDelete = service.getInvestigationGraph(project.id);
  assert.equal(afterLinkDelete.items.length, 1);
  assert.equal(afterLinkDelete.itemLinks.length, 0);
  repository.close();
});

test("deleted generated Node stays detached and is not resurrected by a normal sync", async () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  const project = service.createProject({ name: "Detached node" }, actor);
  const codeMap = new CodeMapService(new MutableProvider([
    fullGraph(project.id, "2026-09-24T12:00:00.000Z"),
  ]));
  const sync = new CodeMapInvestigationSyncService(codeMap, repository);

  await codeMap.refresh({ projectId: project.id, rootPath: "/workspace/project" });
  const initialPreview = sync.preview(project.id);
  sync.apply(
    project.id,
    { expectedProjectionFingerprint: initialPreview.projectionFingerprint },
    actor,
    "sync-safety-node-initial-001",
  );
  const initialGraph = service.getInvestigationGraph(project.id);
  const httpNode = initialGraph.nodes.find((node) => node.kind === "code-map/http_api")!;
  service.deleteInvestigationNode(httpNode.id, actor);

  const detachedPreview = sync.preview(project.id);
  assert.equal(detachedPreview.counts.nodes.detached, 1);
  assert.throws(
    () => sync.apply(
      project.id,
      { expectedProjectionFingerprint: detachedPreview.projectionFingerprint },
      actor,
      "sync-safety-node-default-002",
    ),
    /recreateDetached=true/,
  );
  const afterDefault = service.getInvestigationGraph(project.id);
  assert.equal(afterDefault.nodes.length, 1);
  assert.equal(afterDefault.nodes.some((node) => node.id === httpNode.id), false);
  repository.close();
});
