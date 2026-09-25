import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  QuestBoardService,
  SqliteQuestBoardRepository,
  type ActorRef,
  type CodeMapInvestigationNodeBinding,
  type CodeMapInvestigationRelationBinding,
} from "../src/index.js";

const actor: ActorRef = { id: "agent:code-map-sync", provider: "test" };

test("Code Map Investigation bindings persist across restart and detach without losing provenance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "questboard-code-map-bindings-"));
  const databasePath = join(directory, "questboard.sqlite");

  try {
    const repository = new SqliteQuestBoardRepository(databasePath);
    const service = new QuestBoardService(repository);
    const project = service.createProject({ name: "Binding persistence" }, actor);
    const sourceNode = service.createInvestigationNode(
      { projectId: project.id, title: "HTTP API", kind: "code-map/http_api" },
      actor,
    );
    const targetNode = service.createInvestigationNode(
      { projectId: project.id, title: "Application Service", kind: "code-map/application_service" },
      actor,
    );
    const item = service.createInvestigationItem(
      { nodeId: sourceNode.id, title: "invokes → Application Service" },
      actor,
    );
    const link = service.createInvestigationItemLink(
      { fromItemId: item.id, toNodeId: targetNode.id, kind: "invokes", label: "invokes" },
      actor,
    );

    const nodeBinding: CodeMapInvestigationNodeBinding = {
      projectId: project.id,
      codeNodeId: "code-map:node:http",
      investigationNodeId: sourceNode.id,
      sourceKind: "http_api",
      sourceTitle: "HTTP API",
      sourceFingerprint: "node-fingerprint-v1",
      sourceIndexedAt: "2026-09-24T10:00:00.000Z",
      syncState: "active",
      firstSyncedAt: "2026-09-24T10:01:00.000Z",
      lastSyncedAt: "2026-09-24T10:01:00.000Z",
    };
    const relationBinding: CodeMapInvestigationRelationBinding = {
      projectId: project.id,
      codeRelationId: "code-map:relation:http-service",
      fromCodeNodeId: "code-map:node:http",
      toCodeNodeId: "code-map:node:service",
      investigationItemId: item.id,
      investigationItemLinkId: link.id,
      relationKind: "invokes",
      sourceRelationIds: ["raw:2", "raw:1"],
      sourceFingerprint: "relation-fingerprint-v1",
      sourceIndexedAt: "2026-09-24T10:00:00.000Z",
      syncState: "active",
      firstSyncedAt: "2026-09-24T10:01:00.000Z",
      lastSyncedAt: "2026-09-24T10:01:00.000Z",
    };

    assert.deepEqual(repository.upsertCodeMapInvestigationNodeBinding(nodeBinding), nodeBinding);
    assert.deepEqual(repository.upsertCodeMapInvestigationRelationBinding(relationBinding), relationBinding);

    const updatedNode = repository.upsertCodeMapInvestigationNodeBinding({
      ...nodeBinding,
      sourceTitle: "HTTP API changed upstream",
      sourceFingerprint: "node-fingerprint-v2",
      sourceIndexedAt: "2026-09-24T10:05:00.000Z",
      firstSyncedAt: "SHOULD-NOT-REPLACE-FIRST-SYNC",
      lastSyncedAt: "2026-09-24T10:06:00.000Z",
    });
    assert.equal(updatedNode.firstSyncedAt, nodeBinding.firstSyncedAt);
    assert.equal(updatedNode.lastSyncedAt, "2026-09-24T10:06:00.000Z");
    assert.equal(updatedNode.sourceFingerprint, "node-fingerprint-v2");
    repository.close();

    const reopened = new SqliteQuestBoardRepository(databasePath);
    assert.equal(reopened.listCodeMapInvestigationNodeBindings(project.id).length, 1);
    assert.equal(reopened.listCodeMapInvestigationRelationBindings(project.id).length, 1);
    assert.equal(
      reopened.getCodeMapInvestigationNodeBinding(project.id, nodeBinding.codeNodeId)?.investigationNodeId,
      sourceNode.id,
    );
    assert.deepEqual(
      reopened.getCodeMapInvestigationRelationBinding(project.id, relationBinding.codeRelationId)?.sourceRelationIds,
      ["raw:2", "raw:1"],
    );

    const reopenedService = new QuestBoardService(reopened);
    reopenedService.deleteInvestigationNode(sourceNode.id, actor);

    const detachedNode = reopened.getCodeMapInvestigationNodeBinding(project.id, nodeBinding.codeNodeId);
    assert.ok(detachedNode);
    assert.equal(detachedNode.syncState, "detached");
    assert.equal(detachedNode.investigationNodeId, undefined);
    assert.equal(detachedNode.sourceFingerprint, "node-fingerprint-v2");

    const detachedRelation = reopened.getCodeMapInvestigationRelationBinding(project.id, relationBinding.codeRelationId);
    assert.ok(detachedRelation);
    assert.equal(detachedRelation.syncState, "detached");
    assert.equal(detachedRelation.investigationItemId, undefined);
    assert.equal(detachedRelation.investigationItemLinkId, undefined);
    assert.deepEqual(detachedRelation.sourceRelationIds, ["raw:2", "raw:1"]);
    reopened.close();

    const reopenedAgain = new SqliteQuestBoardRepository(databasePath);
    assert.equal(
      reopenedAgain.getCodeMapInvestigationNodeBinding(project.id, nodeBinding.codeNodeId)?.syncState,
      "detached",
    );
    assert.equal(
      reopenedAgain.getCodeMapInvestigationRelationBinding(project.id, relationBinding.codeRelationId)?.syncState,
      "detached",
    );

    reopenedAgain.deleteCodeMapInvestigationNodeBinding(project.id, nodeBinding.codeNodeId);
    reopenedAgain.deleteCodeMapInvestigationRelationBinding(project.id, relationBinding.codeRelationId);
    assert.equal(reopenedAgain.getCodeMapInvestigationNodeBinding(project.id, nodeBinding.codeNodeId), undefined);
    assert.equal(reopenedAgain.getCodeMapInvestigationRelationBinding(project.id, relationBinding.codeRelationId), undefined);
    reopenedAgain.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
