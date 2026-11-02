import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  QuestBoardService, SqliteQuestBoardRepository, SourceStructureBindingConflict,
  reconcileSourceStructureBinding, migrateSourceStructureBindings,
  type ActorRef, type SourceStructureRecordRequest, type SourceStructureSyncGraph,
} from "../src/index.js";

const actor: ActorRef = { id: "agent:s3-fixture", provider: "synthetic" };
const stamp = "2026-10-15T00:00:00.000Z";
const A = "source-structure-sync:binding:v1:aaaa";
const B = "source-structure-sync:binding:v1:bbbb";
const R = "source-structure-sync:relation:v1:cccc";
const pin = "s3-isolated-snapshot";
function graph(projectId: string, options: { sourceId?: string; evidence?: string; snapshot?: string; includeB?: boolean } = {}): SourceStructureSyncGraph {
  const nodes = [
    { id: A, sourceId: options.sourceId ?? "code-subsystem:node:srcA", sourceType: "subsystem",
      identityKey: "canonical:/src/A", title: "A", pathPrefix: "src/A", classification: "project_directory", ownerContainment: [] },
    ...(options.includeB === false ? [] : [{ id: B, sourceId: "code-subsystem:node:srcB", sourceType: "subsystem",
      identityKey: "canonical:/src/B", title: "B", pathPrefix: "src/B", classification: "project_directory", ownerContainment: [] }]),
  ];
  const relations = options.includeB === false ? [] : [{
    id: R, sourceId: "code-subsystem:relation:A-B", from: A, to: B,
    kind: "calls", directed: true, sourceRelationCount: 1,
    rawRelationIds: ["code:relation:call-1"], evidence: [{
      rawRelationId: "code:relation:call-1", fromRawNodeId: "code:node:call-A",
      toRawNodeId: "code:node:call-B", confidence: 0.98,
    }], evidenceTruncated: false,
  }];
  return {
    schemaVersion: 1, projectId, sourceIndexedAt: stamp,
    snapshotId: options.snapshot ?? pin, selectionFingerprint: "selection-" + (options.evidence ?? "v1"),
    evidenceFingerprint: "evidence-" + (options.evidence ?? "v1"),
    nodes, relations,
  } as unknown as SourceStructureSyncGraph;
}
function input(
  source: SourceStructureSyncGraph,
  writes: SourceStructureRecordRequest["writes"],
  options: Partial<SourceStructureRecordRequest> = {},
): SourceStructureRecordRequest {
  return {
    graph: source, selectionKey: "selection-alpha", expectedSelectionRevision: null,
    currentSnapshotId: source.snapshotId, currentIndexedAt: stamp,
    requestId: "s3-fixture-record-" + source.projectId,
    actor, recordedAt: stamp, writes, ...options,
  };
}
function reject(code: string, action: () => unknown): void {
  assert.throws(action, (error: unknown) =>
    error instanceof SourceStructureBindingConflict && error.code === code);
}
async function fixture(fn: (context: {
  repo: SqliteQuestBoardRepository; service: QuestBoardService;
  path: string; projectId: string; nodeId: string;
}) => void | Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "questboard-source-s3-"));
  const path = join(dir, "isolated.sqlite");
  const repo = new SqliteQuestBoardRepository(path);
  const service = new QuestBoardService(repo);
  const project = service.createProject({ name: "S3 synthetic sandbox" }, actor);
  const node = service.createInvestigationNode({ projectId: project.id, title: "S3 node", kind: "source-structure/synthetic" }, actor);
  try {
    await fn({ repo, service, path, projectId: project.id, nodeId: node.id });
  } finally {
    // Tests may intentionally close and reopen the connection; closing an already-closed handle is harmless.
    try { repo.close(); } catch { /* closed for restart fixture */ }
    await rm(dir, { recursive: true, force: true });
  }
}

test("S3 additive migration is repeatable and independent of legacy schema", async () => {
  await fixture(({ repo, path, projectId, nodeId }) => {
    const db = new DatabaseSync(path);
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'source_structure_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    assert.deepEqual(names.map((row) => row.name), [
      "source_structure_bindings", "source_structure_mutation_receipts", "source_structure_selections",
    ]);
    db.prepare(`INSERT INTO code_map_investigation_node_bindings
      (project_id, code_node_id, investigation_node_id, source_kind, source_title,
      source_fingerprint, source_indexed_at, sync_state, first_synced_at, last_synced_at)
      VALUES (?, 'code-map:node:compat', ?, 'http_api', 'existing manual text',
      'legacy-six-role-fingerprint', ?, 'active', ?, ?)`
    ).run(projectId, nodeId, stamp, stamp, stamp);
    const before = db.prepare("SELECT * FROM code_map_investigation_node_bindings WHERE project_id = ?")
      .all(projectId);
    assert.equal(before.length, 1);
    db.close();
    // Reopen: create-if-not-exists migration must leave legacy records byte-for-byte identical.
    repo.close();
    const reopened = new SqliteQuestBoardRepository(path);
    const check = new DatabaseSync(path);
    assert.deepEqual(check.prepare("SELECT * FROM code_map_investigation_node_bindings WHERE project_id = ?")
      .all(projectId), before);
    const original = check.prepare("SELECT sql FROM sqlite_master WHERE name = 'code_map_investigation_node_bindings'")
      .get() as { sql: string };
    assert.match(original.sql, /http_api.*agent_mcp.*application_service/);
    assert.equal(reopened.sourceStructureBindings.listBindings(projectId).length, 0);
    check.close();
    reopened.close();
  });
});

test("S3 migration rolls back all new tables on DDL conflict without altering prior objects", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY);");
    db.exec("CREATE VIEW source_structure_bindings AS SELECT 'manual-view' AS project_id;");
    assert.throws(() => migrateSourceStructureBindings(db));
    const names = db.prepare("SELECT name, type FROM sqlite_master WHERE name LIKE 'source_structure_%' ORDER BY name")
      .all() as Array<{ name: string; type: string }>;
    assert.deepEqual(names.map((row) => [row.name, row.type]), [["source_structure_bindings", "view"]]);
  } finally { db.close(); }
});

test("S3 persists stable identity, last-good evidence, actor and exact request replay across restart", async () => {
  await fixture(({ repo, path, projectId, nodeId }) => {
    const g = graph(projectId);
    const req = input(g, [{ bindingId: A, target: { investigationNodeId: nodeId }, expectedRevision: null }]);
    const initial = repo.sourceStructureBindings.record(req);
    assert.equal(initial.replayed, false);
    assert.equal(initial.selection.revision, 1);
    assert.equal(initial.bindings[0]?.target.investigationNodeId, nodeId);
    assert.equal(initial.bindings[0]?.identityKey, "canonical:/src/A");
    assert.equal(initial.bindings[0]?.lastSyncActorProvider, actor.provider);
    const replay = repo.sourceStructureBindings.record(req);
    assert.equal(replay.replayed, true);
    assert.equal(replay.bindings[0]?.revision, 1);
    repo.close();
    const reopened = new SqliteQuestBoardRepository(path);
    assert.deepEqual(reopened.sourceStructureBindings.getBinding(projectId, A), initial.bindings[0]);
    assert.deepEqual(reopened.sourceStructureBindings.getSelection(projectId, "selection-alpha"), initial.selection);
    assert.equal(reopened.sourceStructureBindings.record(req).replayed, true);
    // Reindex changed the navigation ID, not the stable binding identity/Flow UUID.
    const updatedGraph = graph(projectId, { sourceId: "code-subsystem:node:reindexed-A" });
    const updated = reopened.sourceStructureBindings.record(input(updatedGraph,
      [{ bindingId: A, expectedRevision: 1 }],
      { expectedSelectionRevision: 1, requestId: "s3-reindex-second-pass" }));
    assert.equal(updated.bindings[0]?.bindingId, A);
    assert.equal(updated.bindings[0]?.sourceId, "code-subsystem:node:reindexed-A");
    assert.equal(updated.bindings[0]?.target.investigationNodeId, nodeId);
    assert.equal(updated.bindings[0]?.firstSyncedAt, stamp);
    reopened.close();
  });
});

test("S3 rejects snapshot mismatches, request reuse, selection CAS and binding CAS, with rollback", async () => {
  await fixture(({ repo, projectId, nodeId }) => {
    const g = graph(projectId);
    const write = [{ bindingId: A, target: { investigationNodeId: nodeId }, expectedRevision: null }];
    reject("snapshot_pin_mismatch", () => repo.sourceStructureBindings.record(
      input(g, write, { currentSnapshotId: "new-live-snapshot" })));
    assert.equal(repo.sourceStructureBindings.getSelection(projectId, "selection-alpha"), undefined);
    const first = repo.sourceStructureBindings.record(input(g, write));
    assert.equal(first.bindings[0]?.revision, 1);
    reject("request_id_conflict", () => repo.sourceStructureBindings.record(
      input(g, write, { recordedAt: "different-input-time" })));
    reject("selection_revision_conflict", () => repo.sourceStructureBindings.record(
      input(g, write, { requestId: "s3-conflicting-selection", expectedSelectionRevision: null })));
    reject("binding_revision_conflict", () => repo.sourceStructureBindings.record(
      input(g, write, { requestId: "s3-conflicting-binding", expectedSelectionRevision: 1 })));
    assert.equal(repo.sourceStructureBindings.getSelection(projectId, "selection-alpha")?.revision, 1);
    assert.equal(repo.sourceStructureBindings.getBinding(projectId, A)?.revision, 1);
  });
});

test("S3 preserves user edits to title, revision and canvas position", async () => {
  await fixture(({ repo, path, projectId, nodeId }) => {
    const g = graph(projectId);
    repo.sourceStructureBindings.record(input(g, [
      { bindingId: A, target: { investigationNodeId: nodeId }, expectedRevision: null },
    ]));
    const sql = new DatabaseSync(path);
    sql.prepare("UPDATE investigation_nodes SET title='User renamed Flow', revision=revision+1 WHERE id = ?")
      .run(nodeId);
    sql.prepare(`INSERT INTO board_positions (project_id, entity_type, entity_id, x, y, updated_by, updated_at)
      VALUES (?, 'investigation_node', ?, 25, 35, 'human', ?)`).run(projectId, nodeId, stamp);
    sql.close();
    assert.deepEqual(repo.sourceStructureBindings.inspectTarget(repo.sourceStructureBindings.getBinding(projectId, A)!),
      { intact: true, manuallyChanged: true });
    reject("manual_edit_conflict", () => repo.sourceStructureBindings.record(
      input(g, [{ bindingId: A, expectedRevision: 1 }],
        { expectedSelectionRevision: 1, requestId: "s3-manual-change-check" })));
    assert.equal(repo.getInvestigationNode(nodeId)?.title, "User renamed Flow");
    assert.equal(repo.sourceStructureBindings.getBinding(projectId, A)?.revision, 1);
  });
});

test("S3 retained node tombstone refuses silent relink after human deletion", async () => {
  await fixture(({ repo, service, projectId, nodeId }) => {
    const g = graph(projectId);
    repo.sourceStructureBindings.record(input(g, [
      { bindingId: A, target: { investigationNodeId: nodeId }, expectedRevision: null },
    ]));
    service.deleteInvestigationNode(nodeId, actor);
    const detached = repo.sourceStructureBindings.getBinding(projectId, A)!;
    assert.equal(detached.state, "detached");
    assert.equal(detached.target.investigationNodeId, null);
    assert.equal(detached.revision, 2);
    assert.equal(detached.identityKey, "canonical:/src/A");
    assert.equal(reconcileSourceStructureBinding(detached, g, false, false).state, "detached");
    const replacement = service.createInvestigationNode({ projectId, title: "Replacement manually created" }, actor);
    reject("target_reassignment_blocked", () => repo.sourceStructureBindings.record(input(g, [
      { bindingId: A, target: { investigationNodeId: replacement.id }, expectedRevision: 2 },
    ], { expectedSelectionRevision: 1, requestId: "s3-delete-rebind-block" })));
    assert.equal(repo.getInvestigationNode(replacement.id)?.title, "Replacement manually created");
  });
});

test("S3 relation item/link tombstone retains raw provenance and protects detached endpoint", async () => {
  await fixture(({ repo, service, projectId, nodeId }) => {
    const to = service.createInvestigationNode({ projectId, title: "Destination" }, actor);
    const item = service.createInvestigationItem({ nodeId, title: "A calls B" }, actor);
    const link = service.createInvestigationItemLink({ fromItemId: item.id, toNodeId: to.id,
      kind: "source-structure/calls", label: "generated" }, actor);
    const g = graph(projectId);
    repo.sourceStructureBindings.record(input(g, [{
      bindingId: R, target: { investigationItemId: item.id, investigationItemLinkId: link.id },
      expectedRevision: null,
    }]));
    assert.equal(repo.sourceStructureBindings.getBinding(projectId, R)?.evidenceCount, 1);
    repo.deleteInvestigationItemLink(link.id);
    const record = repo.sourceStructureBindings.getBinding(projectId, R)!;
    assert.equal(record.state, "detached");
    assert.equal(record.target.investigationItemLinkId, null);
    assert.deepEqual(record.rawRelationIds, ["code:relation:call-1"]);
    const newLink = service.createInvestigationItemLink({ fromItemId: item.id, toNodeId: to.id }, actor);
    reject("target_reassignment_blocked", () => repo.sourceStructureBindings.record(input(g, [{
      bindingId: R, expectedRevision: record.revision,
      target: { investigationItemId: item.id, investigationItemLinkId: newLink.id },
    }], { expectedSelectionRevision: 1, requestId: "s3-detached-link-rebind-block" })));
  });
});

test("S3 rejects targets of another project and targets already claimed by legacy compatibility", async () => {
  await fixture(({ repo, service, path, projectId, nodeId }) => {
    const second = service.createProject({ name: "Other project same titles" }, actor);
    const foreign = service.createInvestigationNode({ projectId: second.id, title: "S3 node" }, actor);
    reject("target_missing", () => repo.sourceStructureBindings.record(input(graph(projectId), [{
      bindingId: A, target: { investigationNodeId: foreign.id }, expectedRevision: null,
    }])));
    const db = new DatabaseSync(path);
    db.prepare(`INSERT INTO code_map_investigation_node_bindings (
      project_id, code_node_id, investigation_node_id, source_kind, source_title,
      source_fingerprint, source_indexed_at, sync_state, first_synced_at, last_synced_at)
      VALUES (?, 'code-map:node:http', ?, 'http_api', 'legacy', 'fingerprint', ?, 'active', ?, ?)`
    ).run(projectId, nodeId, stamp, stamp, stamp);
    db.close();
    reject("legacy_target_collision", () => repo.sourceStructureBindings.record(input(graph(projectId), [{
      bindingId: A, target: { investigationNodeId: nodeId }, expectedRevision: null,
    }], { requestId: "s3-legacy-collision" })));
    assert.equal(repo.sourceStructureBindings.listBindings(projectId).length, 0);
  });
});

test("S3 supports same canonical binding IDs in separate projects and never coalesces them", async () => {
  await fixture(({ repo, service, projectId, nodeId }) => {
    const other = service.createProject({ name: "same symbol names" }, actor);
    const otherNode = service.createInvestigationNode({ projectId: other.id, title: "S3 node",
      kind: "source-structure/synthetic" }, actor);
    const make = (id: string, targetId: string) => input(graph(id), [
      { bindingId: A, target: { investigationNodeId: targetId }, expectedRevision: null },
    ], { requestId: "s3-other-project-" + id });
    repo.sourceStructureBindings.record(make(projectId, nodeId));
    repo.sourceStructureBindings.record(make(other.id, otherNode.id));
    assert.equal(repo.sourceStructureBindings.getBinding(other.id, A)?.target.investigationNodeId, otherNode.id);
    assert.equal(repo.sourceStructureBindings.getBinding(projectId, A)?.target.investigationNodeId, nodeId);
  });
});

test("S3 duplicate target and semantic identity mutation fail closed without losing last-good state", async () => {
  await fixture(({ repo, projectId, nodeId }) => {
    const g = graph(projectId);
    repo.sourceStructureBindings.record(input(g, [
      { bindingId: A, target: { investigationNodeId: nodeId }, expectedRevision: null },
    ]));
    assert.throws(() => repo.sourceStructureBindings.record(input(g, [
      { bindingId: B, target: { investigationNodeId: nodeId }, expectedRevision: null },
    ], { requestId: "s3-double-target", expectedSelectionRevision: 1 })));
    assert.equal(repo.sourceStructureBindings.getBinding(projectId, B), undefined);
    const renamed = graph(projectId);
    (renamed.nodes[0] as { identityKey: string }).identityKey = "canonical:/src/renamed";
    reject("identity_changed", () => repo.sourceStructureBindings.record(input(renamed, [
      { bindingId: A, expectedRevision: 1 },
    ], { requestId: "s3-rename-block", expectedSelectionRevision: 1 })));
    assert.equal(repo.sourceStructureBindings.getBinding(projectId, A)?.identityKey, "canonical:/src/A");
  });
});

test("S3 reconciliation is conservative for evidence, pin drift, selection shrink and blocked edits", async () => {
  await fixture(({ repo, projectId, nodeId }) => {
    const g = graph(projectId);
    const b = repo.sourceStructureBindings.record(input(g, [
      { bindingId: A, target: { investigationNodeId: nodeId }, expectedRevision: null },
    ])).bindings[0]!;
    assert.equal(reconcileSourceStructureBinding(b, g, true, false).state, "active");
    assert.equal(reconcileSourceStructureBinding(b, graph(projectId, { evidence: "v2" }), true, false).state, "evidence_changed");
    assert.equal(reconcileSourceStructureBinding(b, graph(projectId, { snapshot: "reindexed" }), true, false).state, "stale");
    assert.equal(reconcileSourceStructureBinding(b, { ...g, nodes: [] }, true, false).state, "no_longer_selected");
    assert.equal(reconcileSourceStructureBinding(b, g, true, true).state, "blocked");
    assert.equal(reconcileSourceStructureBinding(b, g, true, false).automaticWriteAllowed, false);
  });
});

test("S3 sequential competing writers enforce selection CAS transaction rollback", async () => {
  await fixture(({ repo, path, projectId, nodeId }) => {
    const g = graph(projectId);
    const first = repo.sourceStructureBindings.record(input(g, [
      { bindingId: A, target: { investigationNodeId: nodeId }, expectedRevision: null },
    ]));
    const secondConnection = new SqliteQuestBoardRepository(path);
    const write = (requestId: string) => input(g, [
      { bindingId: A, expectedRevision: 1 },
    ], { requestId, expectedSelectionRevision: first.selection.revision });
    const winner = secondConnection.sourceStructureBindings.record(write("s3-race-winner"));
    assert.equal(winner.bindings[0]?.revision, 2);
    reject("selection_revision_conflict", () => repo.sourceStructureBindings.record(write("s3-race-loser")));
    assert.equal(repo.sourceStructureBindings.getBinding(projectId, A)?.revision, 2);
    assert.equal(repo.sourceStructureBindings.getSelection(projectId, "selection-alpha")?.revision, 2);
    secondConnection.close();
  });
});

test("S3 metadata composes with an outer Flow repository transaction without partial commit", async () => {
  await fixture(({ repo, projectId, nodeId }) => {
    const request = input(graph(projectId), [{
      bindingId: A, target: { investigationNodeId: nodeId }, expectedRevision: null,
    }], { requestId: "s3-nested-transaction" });
    assert.throws(() => repo.runIdempotentMutation(undefined, () => {
      repo.sourceStructureBindings.record(request);
      repo.upsertBoardPosition({ projectId, entityType: "investigation_node", entityId: nodeId,
        x: 40, y: 80, updatedBy: actor.id, updatedAt: stamp });
      throw new Error("synthetic outer Flow apply failure");
    }), /synthetic outer Flow apply failure/);
    assert.equal(repo.sourceStructureBindings.getSelection(projectId, "selection-alpha"), undefined);
    assert.equal(repo.sourceStructureBindings.getBinding(projectId, A), undefined);
    assert.equal(repo.listBoardPositions(projectId).length, 0);
    const success = repo.runIdempotentMutation(undefined, () =>
      repo.sourceStructureBindings.record(request));
    assert.equal(success.value.bindings[0]?.revision, 1);
    assert.equal(repo.sourceStructureBindings.getBinding(projectId, A)?.target.investigationNodeId, nodeId);
  });
});

test("S3 never claims unmarked manually-created Flow and blocks manual kind changes", async () => {
  await fixture(({ repo, service, projectId, nodeId }) => {
    const manual = service.createInvestigationNode({ projectId, title: "Human owned", kind: "manual" }, actor);
    reject("manual_target_protected", () => repo.sourceStructureBindings.record(input(graph(projectId), [{
      bindingId: A, target: { investigationNodeId: manual.id }, expectedRevision: null,
    }])));
    repo.sourceStructureBindings.record(input(graph(projectId), [{
      bindingId: A, target: { investigationNodeId: nodeId }, expectedRevision: null,
    }], { requestId: "s3-generated-owner" }));
    const current = repo.getInvestigationNode(nodeId)!;
    service.updateInvestigationNode(nodeId, { kind: "manual" }, actor);
    assert.equal(repo.getInvestigationNode(nodeId)?.kind, "manual");
    assert.notEqual(repo.getInvestigationNode(nodeId)?.revision, current.revision);
    assert.deepEqual(repo.sourceStructureBindings.inspectTarget(repo.sourceStructureBindings.getBinding(projectId, A)!),
      { intact: true, manuallyChanged: true });
    reject("manual_target_protected", () => repo.sourceStructureBindings.record(input(graph(projectId), [{
      bindingId: A, expectedRevision: 1,
    }], { expectedSelectionRevision: 1, requestId: "s3-manual-kind-change" })));
  });
});

test("S3 evidence and snapshot drift require explicit state, remaining sticky until reviewed", async () => {
  await fixture(({ repo, projectId, nodeId }) => {
    const g = graph(projectId);
    repo.sourceStructureBindings.record(input(g, [{
      bindingId: A, target: { investigationNodeId: nodeId }, expectedRevision: null,
    }]));
    const evidence = graph(projectId, { evidence: "new-evidence" });
    reject("evidence_requires_review", () => repo.sourceStructureBindings.record(input(evidence, [{
      bindingId: A, expectedRevision: 1,
    }], { expectedSelectionRevision: 1, requestId: "s3-unreviewed-evidence" })));
    const updated = repo.sourceStructureBindings.record(input(evidence, [{
      bindingId: A, expectedRevision: 1, state: "evidence_changed",
    }], { expectedSelectionRevision: 1, requestId: "s3-reviewed-evidence" }));
    assert.equal(updated.bindings[0]?.state, "evidence_changed");
    assert.equal(reconcileSourceStructureBinding(updated.bindings[0]!, evidence, true, false).state, "evidence_changed");
    const changedPin = graph(projectId, { snapshot: "later-snapshot", evidence: "new-evidence" });
    reject("stale_requires_review", () => repo.sourceStructureBindings.record(input(changedPin, [{
      bindingId: A, expectedRevision: 2,
    }], { expectedSelectionRevision: 2, requestId: "s3-unreviewed-pin" })));
    const stale = repo.sourceStructureBindings.record(input(changedPin, [{
      bindingId: A, expectedRevision: 2, state: "stale",
    }], { expectedSelectionRevision: 2, requestId: "s3-reviewed-pin" }));
    assert.equal(stale.bindings[0]?.state, "stale");
    assert.equal(reconcileSourceStructureBinding(stale.bindings[0]!, changedPin, true, false).state, "stale");
  });
});
