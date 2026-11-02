import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_GRAPH_SCHEMA_VERSION,
  createCodeSourceSubsystemRead,
  projectCodeArchitecture,
  queryCodeSourceSubsystems,
  type CodeGraphSnapshot,
  type CodeNode,
  type CodeRelation,
} from "../src/index.js";
import {
  deriveSourceStructureSyncGraph,
  SOURCE_STRUCTURE_SYNC_BINDING_PREFIX,
  SOURCE_STRUCTURE_SYNC_LIMITS,
  SourceStructureSelectionError,
} from "../src/application/source-structure-sync-graph.js";

const stamp = "2026-10-14T00:00:00.000Z";
const pin = "synthetic-s2-snapshot";
function node(id: string, name: string, path: string, language = "php", kind: CodeNode["kind"] = "method"): CodeNode {
  return { id: "code:node:" + id, kind, name, language,
    canonicalIdentity: language + ":synthetic:" + path + "#" + name,
    location: { path, startLine: 5 } };
}
function relation(id: string, from: string, to: string, kind: CodeRelation["kind"] = "calls"): CodeRelation {
  return { id: "code:relation:" + id, from: "code:node:" + from, to: "code:node:" + to,
    kind, confidence: 0.97, evidence: [{ location: {
      path: "src/Application/BatchHandler.php", startLine: 9,
    }, label: "synthetic SCIP-style relation" }],
    provenance: [{ providerId: "synthetic-normalized-scip", fidelity: "semantic-call", freshness: "fresh" }] };
}
function fixture(language = "php"): CodeGraphSnapshot {
  const ext = language === "php" ? "php" : language === "typescript" ? "ts" : "js";
  const handler = "src/Application/BatchHandler." + ext;
  const service = "src/Service/InvoiceService." + ext;
  const dao = "src/DAO/InvoiceDao." + ext;
  return { schemaVersion: CODE_GRAPH_SCHEMA_VERSION, projectId: "s2-synthetic",
    rootPath: "/synthetic/s2", indexedAt: stamp, nodes: [
      node("handler", "BatchHandler", handler, language, "class"),
      node("handle", "handle", handler, language),
      node("service", "InvoiceService", service, language, "class"),
      node("load", "load", service, language),
      node("dao", "InvoiceDao", dao, language, "class"),
      node("find", "find", dao, language),
      node("http", "HttpGateway", "src/Transport/HttpGateway." + ext, language, "class"),
      node("external", "External", "", language, "class"),
      { ...node("local", "localHelper", handler, language), canonicalIdentity: "synthetic:local helper" },
    ], relations: [
      relation("owner-handler", "handler", "handle", "contains"),
      relation("owner-service", "service", "load", "contains"),
      relation("owner-dao", "dao", "find", "contains"),
      relation("call-h-s", "handle", "load"),
      relation("call-s-d", "load", "find"),
      relation("broad", "handle", "find", "depends_on"),
      relation("external", "handle", "external"),
      relation("local", "local", "find"),
    ] };
}
function pageFor(graph: CodeGraphSnapshot, offset = 0, limit = 12, currentPin = pin) {
  const page = queryCodeSourceSubsystems(graph, projectCodeArchitecture(graph),
    { operation: "list_subsystems", offset, limit,
      ...(offset ? { expectedSnapshotId: currentPin, expectedSourceIndexedAt: stamp } : {}) },
    undefined, currentPin);
  assert.equal(page.operation, "list_subsystems");
  if (page.operation !== "list_subsystems") throw new Error("expected subgroup page");
  return page;
}
function chosen(graph: CodeGraphSnapshot, paths: readonly string[], extras: {
  anchors?: readonly string[]; relations?: readonly string[]; offset?: number; limit?: number;
} = {}) {
  const page = pageFor(graph, extras.offset, extras.limit);
  const ids = page.nodes.filter((group) => paths.includes(group.pathPrefix)).map((group) => group.id);
  return { subsystemPage: page, selectedSubsystemIds: ids,
    ...(extras.anchors !== undefined ? { selectedRawAnchorIds: extras.anchors } : {}),
    ...(extras.relations !== undefined ? { selectedRelationIds: extras.relations } : {}),
    expectedSourceIndexedAt: stamp, expectedSnapshotId: pin };
}
function rejectCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (e: unknown) => e instanceof SourceStructureSelectionError && e.code === code);
}

test("S2 PHP source-call chain is evidence-backed even where six-role graph drops both edges", () => {
  const raw = fixture();
  const before = projectCodeArchitecture(raw);
  assert.equal(before.relations.length, 0);
  const selection = chosen(raw, ["src/Application", "src/Service", "src/DAO"]);
  const result = deriveSourceStructureSyncGraph(raw, selection, pin);
  assert.equal(result.nodes.length, 3);
  assert.equal(result.relations.length, 2);
  assert.deepEqual(result.relations.map((r) => r.kind), ["calls", "calls"]);
  assert.deepEqual(result.relations.flatMap((r) => r.rawRelationIds).sort(),
    ["code:relation:call-h-s", "code:relation:call-s-d"]);
  assert.ok(result.relations.every((r) => r.evidence.every((e) => e.confidence === 0.97
    && e.sourceLocation?.startLine === 9
    && e.provenance?.[0]?.providerId === "synthetic-normalized-scip")));
  assert.ok(result.nodes.every((n) => n.id.startsWith(SOURCE_STRUCTURE_SYNC_BINDING_PREFIX)
    && !n.id.startsWith("code-map:") && !n.id.startsWith("code-subsystem:")));
  assert.equal(result.diagnostics.compatibilityOmittedCallEvidenceCount, 2);
  assert.equal(result.selection.notFullGraphSync, true);
  assert.deepEqual(projectCodeArchitecture(raw), before);
});

test("S2 raw method anchors retain exact contains owner and never infer Handler-to-DAO shortcut", () => {
  const raw = fixture();
  const result = deriveSourceStructureSyncGraph(raw, chosen(raw,
    ["src/Application", "src/Service", "src/DAO"],
    { anchors: ["code:node:handle", "code:node:load", "code:node:find"] }), pin);
  const handle = result.nodes.find((n) => n.sourceId === "code:node:handle");
  assert.deepEqual(handle?.ownerContainment, ["code:node:handler"]);
  assert.equal(handle?.rawOwnerNodeId, "code:node:handler");
  assert.equal(result.nodes.length, 6);
  assert.equal(result.relations.length, 4);
  assert.equal(result.relations.filter((r) =>
    r.sourceId.startsWith("source-structure-sync:raw-relation:v1:")).length, 2);
  assert.equal(result.relations.some((r) => r.rawRelationIds.includes("code:relation:broad")), false);
  assert.equal(result.relations.some((r) => r.rawRelationIds.includes("code:relation:external")), false);
  assert.equal(result.relations.some((r) => r.rawRelationIds.includes("code:relation:local")), false);
  rejectCode(() => deriveSourceStructureSyncGraph(raw, chosen(raw, ["src/Application"],
    { anchors: ["code:node:local"] }), pin), "invalid_raw_anchor");
});

test("S2 TypeScript and JavaScript normalized facts use the same semantic edge rules", () => {
  for (const language of ["php", "typescript", "javascript"]) {
    const raw = fixture(language);
    const result = deriveSourceStructureSyncGraph(raw, chosen(raw,
      ["src/Application", "src/Service", "src/DAO"]), pin);
    assert.equal(result.relations.length, 2);
    assert.equal(result.relations.every((r) => r.kind === "calls"), true);
  }
});

test("S2 no raw evidence versus outside-selection zero relation diagnostics", () => {
  const raw = fixture();
  const empty = { ...raw, relations: raw.relations.filter((r) => r.kind === "contains") };
  const none = deriveSourceStructureSyncGraph(empty, chosen(empty, ["src/Application", "src/DAO"]), pin);
  assert.equal(none.relations.length, 0);
  assert.equal(none.diagnostics.noSelectedRelationsReason, "raw_evidence_absent");
  const outside = deriveSourceStructureSyncGraph(raw, chosen(raw, ["src/Transport", "src/DAO"]), pin);
  assert.equal(outside.relations.length, 0);
  assert.equal(outside.diagnostics.noSelectedRelationsReason, "outside_selection");
  const base = deriveSourceStructureSyncGraph(raw, chosen(raw, ["src/Application", "src/Service"]), pin);
  const filtered = deriveSourceStructureSyncGraph(raw, chosen(raw, ["src/Application", "src/Service"],
    { relations: [] }), pin);
  assert.equal(base.relations.length, 1);
  assert.equal(filtered.diagnostics.noSelectedRelationsReason, "relation_filter");
  assert.equal(filtered.selection.omittedEligibleRelationCount, 1);
});

test("S2 explicit selection is page-bound, bounded and snapshot-pinned", () => {
  const raw = fixture();
  const select = chosen(raw, ["src/Application", "src/Service"]);
  rejectCode(() => deriveSourceStructureSyncGraph(raw,
    { ...select, expectedSnapshotId: "wrong" }, pin), "source_structure_snapshot_stale");
  rejectCode(() => deriveSourceStructureSyncGraph(raw,
    { ...select, expectedSourceIndexedAt: "stale" }, pin), "source_structure_snapshot_stale");
  rejectCode(() => deriveSourceStructureSyncGraph(raw,
    { ...select, selectedSubsystemIds: [...select.selectedSubsystemIds, ...select.selectedSubsystemIds] }, pin),
    "duplicate_selection");
  rejectCode(() => deriveSourceStructureSyncGraph(raw,
    { ...select, selectedSubsystemIds: ["code-map:node:fake"] }, pin), "selected_outside_page");
  rejectCode(() => deriveSourceStructureSyncGraph(raw,
    { ...select, selectedRelationIds: ["code:relation:not-selected"] }, pin),
    "unknown_selected_relation");
  const page = pageFor(raw, 0, 1);
  rejectCode(() => deriveSourceStructureSyncGraph(raw,
    { ...select, subsystemPage: page }, pin), "selected_outside_page");
  rejectCode(() => deriveSourceStructureSyncGraph(raw,
    { ...select, subsystemPage: { ...select.subsystemPage, offset: 1 } }, pin),
    "invalid_pinned_page");
  rejectCode(() => deriveSourceStructureSyncGraph(raw,
    { ...select, subsystemPage: { ...select.subsystemPage, candidateCount: 999 } }, pin),
    "invalid_pinned_page");
  const drift = { ...raw, indexedAt: stamp + "-changed" };
  rejectCode(() => deriveSourceStructureSyncGraph(drift, select, pin), "source_structure_snapshot_stale");
});

test("S2 reordering leaves identities/fingerprints stable, rename changes raw binding identity", () => {
  const raw = fixture();
  const selected = chosen(raw, ["src/Application", "src/Service"], { anchors: ["code:node:handle"] });
  const first = deriveSourceStructureSyncGraph(raw, selected, pin);
  const shuffled = { ...raw, nodes: [...raw.nodes].reverse(), relations: [...raw.relations].reverse() };
  const second = deriveSourceStructureSyncGraph(shuffled, selected, pin);
  assert.equal(first.selectionFingerprint, second.selectionFingerprint);
  assert.deepEqual(first.nodes, second.nodes);
  assert.deepEqual(first.relations, second.relations);
  const changed = { ...raw, nodes: raw.nodes.map((n) => n.id === "code:node:handle"
    ? { ...n, canonicalIdentity: n.canonicalIdentity + ":renamed" } : n) };
  const third = deriveSourceStructureSyncGraph(changed, selected, pin);
  assert.notEqual(first.nodes.find((n) => n.sourceId === "code:node:handle")?.id,
    third.nodes.find((n) => n.sourceId === "code:node:handle")?.id);
  assert.notEqual(first.evidenceFingerprint, third.evidenceFingerprint);
  assert.notEqual(first.selectionFingerprint, third.selectionFingerprint);
});

test("S2 5k+ synthetic nodes remain explicitly bounded, page drift and cap do not silently sync all", () => {
  const raw = fixture();
  const bulk = Array.from({ length: 5100 }, (_, i) =>
    node("bulk-" + i, "func_" + i, "src/Area" + (i % 30) + "/File" + i + ".php"));
  const large = { ...raw, nodes: [...raw.nodes, ...bulk] };
  const firstPage = pageFor(large, 0, SOURCE_STRUCTURE_SYNC_LIMITS.nodes);
  assert.ok(firstPage.candidateCount > SOURCE_STRUCTURE_SYNC_LIMITS.nodes);
  assert.equal(firstPage.hasMore, true);
  const selected = {
    subsystemPage: firstPage,
    selectedSubsystemIds: firstPage.nodes.slice(0, 3).map((entry) => entry.id),
    expectedSourceIndexedAt: stamp, expectedSnapshotId: pin,
  };
  const result = deriveSourceStructureSyncGraph(large, selected, pin);
  assert.equal(result.nodes.length, 3);
  assert.equal(result.selection.subsystemPage.truncated, true);
  assert.ok(result.diagnostics.structureCandidateCount > 12);
  assert.ok(result.relations.length <= SOURCE_STRUCTURE_SYNC_LIMITS.relations);
  const nextPage = pageFor(large, 12, 12);
  assert.equal(nextPage.offset, 12);
  assert.equal(nextPage.snapshotId, pin);
  rejectCode(() => deriveSourceStructureSyncGraph(large,
    { ...selected, selectedSubsystemIds: firstPage.nodes.map((n) => n.id).concat(["extra"]) }, pin),
  "selection_node_cap");
});

test("S2 auxiliary types are preserved, unrelated source changes stale the evidence fingerprint", () => {
  const raw = fixture();
  const withAux = { ...raw, relations: [...raw.relations,
    relation("new-implements", "find", "handle", "implements"),
    relation("new-instantiates", "handle", "find", "instantiates")] };
  const selection = chosen(withAux, ["src/Application", "src/DAO"]);
  const result = deriveSourceStructureSyncGraph(withAux, selection, pin);
  assert.deepEqual(result.relations.map((r) => r.kind), ["implements", "instantiates"]);
  const changed = { ...withAux, relations: withAux.relations.map((r) => r.id === "code:relation:call-h-s"
    ? { ...r, confidence: 0.75 } : r) };
  const changedProjection = deriveSourceStructureSyncGraph(changed, selection, pin);
  assert.notEqual(result.evidenceFingerprint, changedProjection.evidenceFingerprint);
});

test("S2 explicit same-file raw calls are visible only when both exact anchors are selected", () => {
  const raw = fixture();
  const second = node("helper", "helper", "src/Application/BatchHandler.php");
  const augmented = { ...raw, nodes: [...raw.nodes, second],
    relations: [...raw.relations, relation("same-file", "handle", "helper")] };
  const selected = deriveSourceStructureSyncGraph(augmented,
    chosen(augmented, ["src/Application"], { anchors: ["code:node:handle", "code:node:helper"] }), pin);
  assert.equal(selected.relations.length, 1);
  assert.deepEqual(selected.relations[0]?.rawRelationIds, ["code:relation:same-file"]);
  assert.equal(selected.relations[0]?.kind, "calls");
  const unselected = deriveSourceStructureSyncGraph(augmented,
    chosen(augmented, ["src/Application"]), pin);
  assert.equal(unselected.relations.length, 0);
});

test("S2 exact filtered pagination and stable raw binding across reindex raw-id churn", () => {
  const raw = fixture();
  const filter = "src/Application";
  const filtered = queryCodeSourceSubsystems(raw, projectCodeArchitecture(raw),
    { operation: "list_subsystems", pathPrefix: filter }, undefined, pin);
  if (filtered.operation !== "list_subsystems") throw new Error("unexpected relation page");
  const selected = { subsystemPage: filtered, pathPrefixFilter: filter,
    selectedSubsystemIds: filtered.nodes.map((item) => item.id),
    selectedRawAnchorIds: ["code:node:handle"],
    expectedSourceIndexedAt: stamp, expectedSnapshotId: pin };
  const before = deriveSourceStructureSyncGraph(raw, selected, pin);
  rejectCode(() => deriveSourceStructureSyncGraph(raw,
    { ...selected, pathPrefixFilter: "src/Service" }, pin), "invalid_pinned_page");
  const reindexed = { ...raw, nodes: raw.nodes.map((entry) =>
    entry.id === "code:node:handle" ? { ...entry, id: "code:node:new-handle" } : entry),
    relations: raw.relations.map((entry) => ({
      ...entry,
      from: entry.from === "code:node:handle" ? "code:node:new-handle" : entry.from,
      to: entry.to === "code:node:handle" ? "code:node:new-handle" : entry.to,
    })) };
  const after = deriveSourceStructureSyncGraph(reindexed,
    { ...selected, selectedRawAnchorIds: ["code:node:new-handle"] }, pin);
  assert.equal(before.nodes.find((n) => n.sourceType === "raw_anchor")?.id,
    after.nodes.find((n) => n.sourceType === "raw_anchor")?.id);
  assert.notEqual(before.evidenceFingerprint, after.evidenceFingerprint);
});

test("S2 refuses over-24 relation fanout rather than silently projecting a partial graph", () => {
  const members = Array.from({ length: 6 }, (_, i) =>
    node("g" + i, "Group" + i, "src/Group" + i + "/Entry.php"));
  const links: CodeRelation[] = [];
  for (let i = 0; i < members.length; i += 1) {
    for (let j = 0; j < members.length; j += 1) {
      if (i === j) continue;
      links.push(relation("g" + i + "-g" + j, "g" + i, "g" + j));
    }
  }
  const raw: CodeGraphSnapshot = {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION, projectId: "s2-synthetic",
    rootPath: "/synthetic/s2", indexedAt: stamp, nodes: members, relations: links,
  };
  const projection = createCodeSourceSubsystemRead(raw, projectCodeArchitecture(raw), undefined,
    { unbounded: true });
  assert.equal(projection.relations.length, 30);
  const page = pageFor(raw);
  const selection = { subsystemPage: page,
    selectedSubsystemIds: page.nodes.map((entry) => entry.id),
    expectedSourceIndexedAt: stamp, expectedSnapshotId: pin };
  rejectCode(() => deriveSourceStructureSyncGraph(raw, selection, pin), "selection_relation_cap");
  const limited = deriveSourceStructureSyncGraph(raw,
    { ...selection, selectedRelationIds: projection.relations.slice(0, 24).map((r) => r.id) }, pin);
  assert.equal(limited.relations.length, 24);
  assert.equal(limited.selection.omittedEligibleRelationCount, 6);
});
