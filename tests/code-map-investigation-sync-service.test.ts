import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_GRAPH_SCHEMA_VERSION,
  CodeMapInvestigationSyncService,
  CodeMapService,
  CodeMapSyncPreviewStaleError,
  QuestBoardService,
  SqliteQuestBoardRepository,
  type ActorRef,
  type CodeGraphSnapshot,
  type CodeIndexRequest,
  type CodeIntelligenceProvider,
  type InvestigationItemLink,
} from "../src/index.js";

const actor: ActorRef = { id: "agent:code-map-sync", provider: "test" };

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

function graph(projectId: string, indexedAt: string, evidenceSuffix: string): CodeGraphSnapshot {
  return {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId,
    rootPath: "/workspace/project",
    indexedAt,
    nodes: [
      {
        id: `http-${evidenceSuffix}`,
        kind: "function",
        name: "handleRequest",
        canonicalIdentity: `src/server/http-api.ts#function:handleRequest:${evidenceSuffix}`,
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
        id: `call-${evidenceSuffix}`,
        from: `http-${evidenceSuffix}`,
        to: "service-stable",
        kind: "calls",
        confidence: 1,
      },
    ],
  };
}

test("preview/apply materializes Code Map as Investigation graph transactionally and idempotently", async () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  const project = service.createProject({ name: "Sync engine" }, actor);
  const provider = new MutableProvider([
    graph(project.id, "2026-09-24T10:00:00.000Z", "v1"),
    graph(project.id, "2026-09-24T10:05:00.000Z", "v2"),
  ]);
  const codeMap = new CodeMapService(provider);
  const sync = new CodeMapInvestigationSyncService(codeMap, repository);

  await codeMap.refresh({ projectId: project.id, rootPath: "/workspace/project" });
  const initialPreview = sync.preview(project.id);
  assert.equal(initialPreview.counts.nodes.create, 2);
  assert.equal(initialPreview.counts.relations.create, 1);
  assert.equal(initialPreview.counts.relations.blocked, 0);

  const first = sync.apply(
    project.id,
    { expectedProjectionFingerprint: initialPreview.projectionFingerprint },
    actor,
    "sync-engine-initial-001",
  );
  assert.equal(first.counts.createdNodes, 2);
  assert.equal(first.counts.createdRelationItems, 1);
  assert.equal(first.counts.createdRelationLinks, 1);

  const afterFirst = service.getInvestigationGraph(project.id);
  assert.equal(afterFirst.nodes.length, 2);
  assert.equal(afterFirst.items.length, 1);
  assert.equal(afterFirst.itemLinks.length, 1);
  assert.equal(afterFirst.positions.filter((position) => position.entityType === "investigation_node").length, 2);
  assert.equal(repository.listCodeMapInvestigationNodeBindings(project.id).length, 2);
  assert.equal(repository.listCodeMapInvestigationRelationBindings(project.id).length, 1);

  const replay = sync.apply(
    project.id,
    { expectedProjectionFingerprint: initialPreview.projectionFingerprint },
    actor,
    "sync-engine-initial-001",
  );
  assert.deepEqual(replay, first);
  const afterReplay = service.getInvestigationGraph(project.id);
  assert.equal(afterReplay.nodes.length, 2);
  assert.equal(afterReplay.items.length, 1);
  assert.equal(afterReplay.itemLinks.length, 1);

  const httpNode = afterReplay.nodes.find((node) => node.kind === "code-map/http_api");
  assert.ok(httpNode);
  const generatedItem = afterReplay.items[0]!;
  service.updateInvestigationNode(
    httpNode.id,
    { title: "Human-owned HTTP title", description: "Human notes stay here" },
    actor,
  );
  service.updateInvestigationItem(
    generatedItem.id,
    { title: "Human-owned relation title", description: "Do not overwrite this" },
    actor,
  );
  service.setBoardPosition(
    project.id,
    { entityType: "investigation_node", entityId: httpNode.id, x: 777, y: 333 },
    actor,
  );
  const task = service.createTask({ projectId: project.id, title: "Human task", status: "ready" }, actor);
  service.linkTaskToInvestigationItem(generatedItem.id, task.id, actor);

  await codeMap.refresh({
    projectId: project.id,
    rootPath: "/workspace/project",
    changes: [{ path: "src/server/http-api.ts", kind: "modified" }],
  });

  assert.throws(
    () => sync.apply(
      project.id,
      { expectedProjectionFingerprint: initialPreview.projectionFingerprint },
      actor,
      "sync-engine-stale-001",
    ),
    CodeMapSyncPreviewStaleError,
  );

  const changedPreview = sync.preview(project.id);
  assert.equal(changedPreview.counts.nodes.evidence_changed, 1);
  assert.equal(changedPreview.counts.nodes.unchanged, 1);
  assert.equal(changedPreview.counts.relations.evidence_changed, 1);

  const changed = sync.apply(
    project.id,
    { expectedProjectionFingerprint: changedPreview.projectionFingerprint },
    actor,
    "sync-engine-changed-001",
  );
  assert.equal(changed.counts.createdNodes, 0);
  assert.equal(changed.counts.createdRelationItems, 0);
  assert.equal(changed.counts.createdRelationLinks, 0);
  assert.equal(changed.counts.updatedBindings, 2);

  const afterChanged = service.getInvestigationGraph(project.id);
  assert.equal(afterChanged.nodes.length, 2);
  assert.equal(afterChanged.items.length, 1);
  assert.equal(afterChanged.itemLinks.length, 1);
  const preservedNode = afterChanged.nodes.find((node) => node.id === httpNode.id)!;
  assert.equal(preservedNode.title, "Human-owned HTTP title");
  assert.equal(preservedNode.description, "Human notes stay here");
  const preservedItem = afterChanged.items.find((item) => item.id === generatedItem.id)!;
  assert.equal(preservedItem.title, "Human-owned relation title");
  assert.equal(preservedItem.description, "Do not overwrite this");
  assert.ok(afterChanged.itemTaskLinks.some((link) => link.itemId === generatedItem.id && link.taskId === task.id));
  const preservedPosition = afterChanged.positions.find(
    (position) => position.entityType === "investigation_node" && position.entityId === httpNode.id,
  )!;
  assert.equal(preservedPosition.x, 777);
  assert.equal(preservedPosition.y, 333);
  repository.close();
});

test("partial preview blocks relations whose unselected endpoint has not been extracted", async () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  const project = service.createProject({ name: "Partial sync" }, actor);
  const codeMap = new CodeMapService(new MutableProvider([
    graph(project.id, "2026-09-24T10:00:00.000Z", "partial"),
  ]));
  const sync = new CodeMapInvestigationSyncService(codeMap, repository);
  await codeMap.refresh({ projectId: project.id, rootPath: "/workspace/project" });
  const projection = codeMap.getCached(project.id)!.projection;
  const http = projection.nodes.find((node) => node.kind === "http_api")!;

  const preview = sync.preview(project.id, { codeNodeIds: [http.id], includeRelations: true });
  assert.equal(preview.counts.nodes.create, 1);
  assert.equal(preview.counts.relations.blocked, 1);
  assert.equal(preview.relations[0]?.blockedReason, "to_node_unselected");

  const result = sync.apply(
    project.id,
    {
      codeNodeIds: [http.id],
      includeRelations: true,
      expectedProjectionFingerprint: preview.projectionFingerprint,
    },
    actor,
    "sync-engine-partial-001",
  );
  assert.equal(result.counts.createdNodes, 1);
  assert.equal(result.counts.blockedRelations, 1);
  assert.equal(service.getInvestigationGraph(project.id).items.length, 0);
  repository.close();
});

class FailingLinkRepository extends SqliteQuestBoardRepository {
  override createInvestigationItemLink(_link: InvestigationItemLink): void {
    throw new Error("forced relation link failure");
  }
}

test("apply rolls back nodes, items, positions, bindings, and mutation receipt when relation creation fails", async () => {
  const repository = new FailingLinkRepository();
  const service = new QuestBoardService(repository);
  const project = service.createProject({ name: "Atomic sync" }, actor);
  const codeMap = new CodeMapService(new MutableProvider([
    graph(project.id, "2026-09-24T10:00:00.000Z", "rollback"),
  ]));
  const sync = new CodeMapInvestigationSyncService(codeMap, repository);
  await codeMap.refresh({ projectId: project.id, rootPath: "/workspace/project" });
  const preview = sync.preview(project.id);

  assert.throws(
    () => sync.apply(
      project.id,
      { expectedProjectionFingerprint: preview.projectionFingerprint },
      actor,
      "sync-engine-rollback-001",
    ),
    /forced relation link failure/,
  );

  const graphAfterFailure = service.getInvestigationGraph(project.id);
  assert.equal(graphAfterFailure.nodes.length, 0);
  assert.equal(graphAfterFailure.items.length, 0);
  assert.equal(graphAfterFailure.itemLinks.length, 0);
  assert.equal(graphAfterFailure.positions.length, 0);
  assert.equal(repository.listCodeMapInvestigationNodeBindings(project.id).length, 0);
  assert.equal(repository.listCodeMapInvestigationRelationBindings(project.id).length, 0);
  repository.close();
});
