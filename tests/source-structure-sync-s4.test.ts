import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CODE_GRAPH_SCHEMA_VERSION, projectCodeArchitecture, queryCodeSourceSubsystems,
  SourceStructureFlowSyncService, SourceStructureBindingConflict,
  QuestBoardService, SqliteQuestBoardRepository,
  type CodeGraphSnapshot, type SourceStructureSelection, type SourceStructureApplyInput,
  type SourceStructureTrustedSource,
} from "../src/index.js";

const actor = { id: "agent:s4-synthetic", provider: "synthetic" };
const indexedAt = "2026-10-19T00:00:00.000Z";
const pin = "s4-synthetic-pinned-snapshot";
function raw(projectId: string, edges = true, lang = "php"): CodeGraphSnapshot {
  const ext = lang === "php" ? "php" : "ts";
  const method = (id: string, path: string) => ({
    id: "code:node:" + id, kind: "method" as const, name: id, language: lang,
    canonicalIdentity: lang + ":synthetic:" + path + "#" + id,
    location: { path, startLine: 1 },
  });
  return {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION, projectId, rootPath: "/synthetic/s4", indexedAt,
    nodes: [
      method("handle", "src/Application/Handler." + ext),
      method("load", "src/Service/Loader." + ext),
      method("save", "src/Storage/Writer." + ext),
    ],
    relations: edges ? [
      { id: "code:relation:call-1", from: "code:node:handle", to: "code:node:load",
        kind: "calls", confidence: .99, evidence: [{ location: {
          path: "src/Application/Handler." + ext, startLine: 7 }, label: "synthetic call" }] },
      { id: "code:relation:call-2", from: "code:node:load", to: "code:node:save",
        kind: "calls", confidence: .95, evidence: [{ location: {
          path: "src/Service/Loader." + ext, startLine: 8 }, label: "synthetic call" }] },
    ] : [],
  };
}
function chosen(graph: CodeGraphSnapshot, names: string[] = ["Application", "Service", "Storage"]): SourceStructureSelection {
  const page = queryCodeSourceSubsystems(graph, projectCodeArchitecture(graph),
    { operation: "list_subsystems", offset: 0, limit: 12 }, undefined, pin);
  assert.equal(page.operation, "list_subsystems");
  if (page.operation !== "list_subsystems") throw new Error("Unexpected relation page");
  return { subsystemPage: page, selectedSubsystemIds: page.nodes
    .filter((node) => names.some((part) => node.pathPrefix.includes(part))).map((node) => node.id),
    expectedSourceIndexedAt: indexedAt, expectedSnapshotId: pin };
}
function input(preview: ReturnType<SourceStructureFlowSyncService["preview"]>,
  selection: SourceStructureSelection, requestId: string): SourceStructureApplyInput {
  return { projectId: preview.projectId, selectionKey: preview.selectionKey,
    selection, expectedSnapshotId: preview.snapshotId, expectedSourceIndexedAt: preview.sourceIndexedAt,
    expectedSelectionFingerprint: preview.selectionFingerprint,
    expectedSelectionRevision: preview.expectedSelectionRevision,
    actor, requestId, approved: true };
}
function rejects(code: string, fn: () => unknown): void {
  assert.throws(fn, (e: unknown) => e instanceof SourceStructureBindingConflict && e.code === code);
}
async function fixture(run: (ctx: {
  repo: SqliteQuestBoardRepository; service: QuestBoardService; sync: SourceStructureFlowSyncService;
  current: { graph: CodeGraphSnapshot; snapshotId: string }; selection: SourceStructureSelection;
  projectId: string;
}) => void | Promise<void>, edges = true, lang = "php") {
  const directory = await mkdtemp(join(tmpdir(), "questboard-s4-synthetic-"));
  const repo = new SqliteQuestBoardRepository(join(directory, "isolated.sqlite"));
  const service = new QuestBoardService(repo);
  const projectId = service.createProject({ name: "S4 isolated synthetic" }, actor).id;
  const current = { graph: raw(projectId, edges, lang), snapshotId: pin };
  const source: SourceStructureTrustedSource = { read: (p) => {
    assert.equal(p, projectId); return current;
  } };
  const sync = new SourceStructureFlowSyncService(repo, source, () => indexedAt);
  const selection = chosen(current.graph);
  try { await run({ repo, service, sync, current, selection, projectId }); }
  finally { repo.close(); await rm(directory, { recursive: true, force: true }); }
}
test("S4 preview stays read-only and reports real directed evidence and selection", async () => {
  await fixture(({ repo, sync, selection, projectId }) => {
    const beforeNodes = repo.listInvestigationNodes(projectId).length;
    const preview = sync.preview(projectId, "s4-alpha", selection);
    assert.equal(preview.counts.create, 5);
    assert.equal(preview.nodes.length, 3);
    assert.equal(preview.relations.length, 2);
    assert.equal(preview.relations[0]!.relationKind, "calls");
    assert.equal(preview.relations.flatMap((r) => r.rawRelationIds).length, 2);
    assert.equal(preview.destructiveActions, 0);
    assert.equal(repo.listInvestigationNodes(projectId).length, beforeNodes);
    assert.equal(repo.sourceStructureBindings.getSelection(projectId, "s4-alpha"), undefined);
  });
});
test("S4 apply creates exactly source owned nodes/directed relation items and links atomically", async () => {
  await fixture(({ repo, sync, selection, projectId }) => {
    const preview = sync.preview(projectId, "alpha", selection);
    const result = sync.apply(input(preview, selection, "s4-apply-success-a"));
    assert.equal(result.createdNodes, 3);
    assert.equal(result.createdRelationItems, 2);
    assert.equal(result.createdRelationLinks, 2);
    assert.equal(repo.listInvestigationNodes(projectId).length, 3);
    assert.equal(repo.listInvestigationItems(projectId).length, 2);
    assert.equal(repo.listInvestigationItemLinks(projectId).length, 2);
    assert.ok(repo.listInvestigationNodes(projectId).every((n) => n.kind?.startsWith("source-structure/")));
    assert.ok(repo.listInvestigationItemLinks(projectId).every((l) =>
      l.kind === "source-structure/calls" && l.label === "calls"));
    assert.deepEqual(repo.sourceStructureBindings.listBindings(projectId)
      .filter((b) => b.entityType === "relation").map((b) => b.rawRelationIds).flat().sort(),
      ["code:relation:call-1", "code:relation:call-2"]);
    assert.equal(repo.sourceStructureBindings.getSelection(projectId, "alpha")?.revision, 1);
  });
});
test("S4 exact retry replays and a second approved request does not duplicate Flow", async () => {
  await fixture(({ repo, sync, selection, projectId }) => {
    const preview = sync.preview(projectId, "alpha", selection);
    const first = sync.apply(input(preview, selection, "s4-replay-a"));
    const replay = sync.apply(input(preview, selection, "s4-replay-a"));
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.nodeIds, first.nodeIds);
    const secondPreview = sync.preview(projectId, "alpha", selection);
    assert.equal(secondPreview.counts.unchanged, 5);
    const second = sync.apply(input(secondPreview, selection, "s4-replay-b"));
    assert.equal(second.createdNodes, 0);
    assert.equal(second.createdRelationLinks, 0);
    assert.equal(repo.listInvestigationNodes(projectId).length, 3);
    assert.equal(repo.listInvestigationItemLinks(projectId).length, 2);
  });
});
test("S4 stale selection revision and distinct payload replay are rejected", async () => {
  await fixture(({ sync, selection, projectId }) => {
    const p = sync.preview(projectId, "alpha", selection);
    sync.apply(input(p, selection, "s4-cas-first"));
    rejects("selection_revision_conflict", () => sync.apply(input(p, selection, "s4-cas-old")));
    const next = sync.preview(projectId, "alpha", selection);
    assert.throws(() => sync.apply({ ...input(next, selection, "s4-cas-first"), selectionKey: "other" }));
  });
});
test("S4 missing approval or mismatched preview pin fails with zero Flow writes", async () => {
  await fixture(({ repo, sync, selection, projectId }) => {
    const p = sync.preview(projectId, "alpha", selection);
    rejects("explicit_approval_required", () => sync.apply({ ...input(p, selection, "s4-no-approval"), approved: false as true }));
    rejects("preview_stale", () => sync.apply({ ...input(p, selection, "s4-preview-stale"), expectedSelectionFingerprint: "wrong" }));
    rejects("snapshot_pin_mismatch", () => sync.apply({ ...input(p, selection, "s4-mismatched-pin"), expectedSnapshotId: "different" }));
    assert.equal(repo.listInvestigationNodes(projectId).length, 0);
  });
});
test("S4 manual title and position edits remain untouched, without silent relinking", async () => {
  await fixture(({ repo, service, sync, selection, projectId }) => {
    const p = sync.preview(projectId, "alpha", selection);
    const applied = sync.apply(input(p, selection, "s4-manual-first"));
    const nodeId = applied.nodeIds[0]!;
    service.updateInvestigationNode(nodeId, { title: "Human renamed" }, actor);
    const fresh = sync.preview(projectId, "alpha", selection);
    assert.equal(fresh.counts.blocked >= 1, true);
    rejects("protected_binding_conflict", () => sync.apply(input(fresh, selection, "s4-manual-second")));
    assert.equal(service.getInvestigationNode(nodeId).title, "Human renamed");
    repo.upsertBoardPosition({ projectId, entityType: "investigation_node",
      entityId: applied.nodeIds[1]!, x: 40, y: 80, updatedAt: indexedAt, updatedBy: actor.id });
    assert.equal(sync.preview(projectId, "alpha", selection).counts.blocked >= 2, true);
  });
});
test("S4 removed bound target is detached; recreation and accidental reuse are blocked", async () => {
  await fixture(({ repo, service, sync, selection, projectId }) => {
    const p = sync.preview(projectId, "alpha", selection);
    const applied = sync.apply(input(p, selection, "s4-detach-first"));
    service.deleteInvestigationNode(applied.nodeIds[0]!, actor);
    const fresh = sync.preview(projectId, "alpha", selection);
    assert.equal(fresh.counts.detached >= 1, true);
    rejects("protected_binding_conflict", () => sync.apply(input(fresh, selection, "s4-detach-repeat")));
    assert.equal(repo.listInvestigationNodes(projectId).length, 2);
  });
});
test("S4 current trusted snapshot drift rejects apply without writes", async () => {
  await fixture(({ sync, current, selection, repo, projectId }) => {
    const p = sync.preview(projectId, "alpha", selection);
    current.snapshotId = "changed-after-preview";
    assert.throws(() => sync.apply(input(p, selection, "s4-snapshot-changed")));
    assert.equal(repo.listInvestigationNodes(projectId).length, 0);
  });
});
test("S4 transaction failure rolls back Flow nodes, links, bindings and selection receipt", async () => {
  await fixture(({ repo, sync, selection, projectId }) => {
    const p = sync.preview(projectId, "alpha", selection);
    const original = repo.createInvestigationItemLink.bind(repo);
    repo.createInvestigationItemLink = () => { throw new Error("injected isolated link failure"); };
    try {
      assert.throws(() => sync.apply(input(p, selection, "s4-rollback")));
    } finally { repo.createInvestigationItemLink = original; }
    assert.equal(repo.listInvestigationNodes(projectId).length, 0);
    assert.equal(repo.listInvestigationItems(projectId).length, 0);
    assert.equal(repo.sourceStructureBindings.listBindings(projectId).length, 0);
    assert.equal(repo.sourceStructureBindings.getSelection(projectId, "alpha"), undefined);
  });
});
test("S4 zero raw edges is not invented as a new Flow link", async () => {
  await fixture(({ repo, sync, selection, projectId }) => {
    const p = sync.preview(projectId, "alpha", selection);
    assert.equal(p.relations.length, 0);
    assert.match(p.warnings.join(" "), /No selected raw-evidence-backed relations/);
    const applied = sync.apply(input(p, selection, "s4-empty-edges"));
    assert.equal(applied.createdNodes, 3);
    assert.equal(applied.createdRelationLinks, 0);
    assert.equal(repo.listInvestigationItemLinks(projectId).length, 0);
  }, false);
});
test("S4 partial selection and mixed TS/PHP snapshots never link out-of-scope nodes", async () => {
  for (const language of ["php", "typescript"]) {
    await fixture(({ repo, sync, current, projectId }) => {
      const selection = chosen(current.graph, ["Application", "Service"]);
      const p = sync.preview(projectId, "alpha", selection);
      assert.equal(p.nodes.length, 2);
      assert.equal(p.relations.length, 1);
      const r = sync.apply(input(p, selection, "s4-partial-" + language));
      assert.equal(r.createdNodes, 2);
      assert.equal(repo.listInvestigationItemLinks(projectId).length, 1);
    }, true, language);
  }
});
test("S4 cross-project selection cannot mutate another project", async () => {
  await fixture(({ repo, service, sync, selection, projectId }) => {
    const other = service.createProject({ name: "S4 other" }, actor);
    assert.throws(() => sync.preview(other.id, "alpha", selection));
    assert.equal(repo.listInvestigationNodes(projectId).length, 0);
    assert.equal(repo.listInvestigationNodes(other.id).length, 0);
  });
});
test("S4 same-file raw anchor relation requires both explicitly selected owners", async () => {
  await fixture(({ repo, sync, current, projectId }) => {
    const helper = { ...current.graph.nodes[0]!,
      id: "code:node:helper", name: "helper",
      canonicalIdentity: "php:synthetic:src/Application/Handler.php#helper" };
    current.graph = { ...current.graph,
      nodes: [...current.graph.nodes, helper],
      relations: [...current.graph.relations, {
        id: "code:relation:same-file", from: "code:node:handle",
        to: "code:node:helper", kind: "calls" as const, confidence: 0.98,
      }] };
    const selection = { ...chosen(current.graph, ["Application"]),
      selectedRawAnchorIds: ["code:node:handle", "code:node:helper"] };
    const p = sync.preview(projectId, "same-file", selection);
    assert.equal(p.nodes.length, 3);
    assert.equal(p.relations.length, 1);
    assert.deepEqual(p.relations[0]?.rawRelationIds, ["code:relation:same-file"]);
    const result = sync.apply(input(p, selection, "s4-same-file"));
    assert.equal(result.createdRelationLinks, 1);
    const relationBinding = repo.sourceStructureBindings.listBindings(projectId)
      .find((binding) => binding.entityType === "relation")!;
    const item = repo.getInvestigationItem(relationBinding.target.investigationItemId!);
    const link = repo.listInvestigationItemLinks(projectId)[0]!;
    const fromNode = repo.sourceStructureBindings.getBinding(projectId, relationBinding.fromBindingId!)!;
    const toNode = repo.sourceStructureBindings.getBinding(projectId, relationBinding.toBindingId!)!;
    assert.equal(item?.nodeId, fromNode.target.investigationNodeId);
    assert.equal(link.toNodeId, toNode.target.investigationNodeId);
  });
});
test("S4 manual deletion of a bound Flow link becomes detached rather than re-created", async () => {
  await fixture(({ repo, sync, selection, projectId }) => {
    const p = sync.preview(projectId, "alpha", selection);
    const applied = sync.apply(input(p, selection, "s4-link-first"));
    repo.deleteInvestigationItemLink(applied.linkIds[0]!);
    const fresh = sync.preview(projectId, "alpha", selection);
    assert.equal(fresh.counts.detached >= 1, true);
    rejects("protected_binding_conflict", () => sync.apply(input(fresh, selection, "s4-link-second")));
    assert.equal(repo.listInvestigationItemLinks(projectId).length, 1);
  });
});
test("S4 rollback after S3 metadata recording removes both Flow and metadata", async () => {
  await fixture(({ repo, sync, selection, projectId }) => {
    const p = sync.preview(projectId, "alpha", selection);
    const store = repo.sourceStructureBindings;
    const original = store.record.bind(store);
    store.record = (request) => {
      original(request);
      throw new Error("after S3 record injected rollback");
    };
    try { assert.throws(() => sync.apply(input(p, selection, "s4-after-record-rollback"))); }
    finally { store.record = original; }
    assert.equal(repo.listInvestigationNodes(projectId).length, 0);
    assert.equal(repo.listInvestigationItems(projectId).length, 0);
    assert.equal(repo.sourceStructureBindings.listBindings(projectId).length, 0);
    assert.equal(repo.sourceStructureBindings.getSelection(projectId, "alpha"), undefined);
  });
});
test("S4 changed raw evidence is previewed but never silently re-applied", async () => {
  await fixture(({ repo, sync, current, selection, projectId }) => {
    const p = sync.preview(projectId, "alpha", selection);
    sync.apply(input(p, selection, "s4-evidence-first"));
    const prior = repo.sourceStructureBindings.listBindings(projectId);
    current.graph = { ...current.graph,
      relations: current.graph.relations.map((relation) =>
        relation.id === "code:relation:call-1" ? { ...relation, confidence: 0.5 } : relation) };
    const changed = sync.preview(projectId, "alpha", selection);
    assert.equal(changed.counts.evidence_changed, 3);
    assert.equal(changed.counts.blocked, 2); // Both relation endpoints require reviewed source nodes.
    rejects("protected_binding_conflict", () => sync.apply(input(changed, selection, "s4-evidence-second")));
    assert.deepEqual(repo.sourceStructureBindings.listBindings(projectId), prior);
    assert.equal(repo.listInvestigationNodes(projectId).length, 3);
  });
});
