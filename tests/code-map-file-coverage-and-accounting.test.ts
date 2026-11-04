import assert from "node:assert/strict";
import test from "node:test";
import { CODE_GRAPH_SCHEMA_VERSION, queryCodeGraph, deriveCodeSourceSubsystems,
  type CodeGraphSnapshot, type CodeNode, type CodeRelation } from "../src/index.js";

const t = "2026-11-04T12:00:00.000Z";
const file = (id: string, path: string, language?: string): CodeNode => ({
  id, kind: "file", name: path.split("/").at(-1)!, canonicalIdentity: "file:" + path,
  ...(language ? { language } : {}), location: { path },
  provenance: [{ providerId: "questboard:file-inventory", fidelity: "file-only", freshness: "fresh" }],
});
const graph: CodeGraphSnapshot = {
  schemaVersion: CODE_GRAPH_SCHEMA_VERSION, projectId: "coverage", rootPath: "/tmp/coverage",
  indexedAt: t,
  nodes: [
    file("ts-native", "src/a.ts", "typescript"),
    file("ts-excluded", "src/outside.ts", "typescript"),
    file("ps", "scripts/run.ps1", "powershell"),
    file("doc", "README.md"),
    { id: "ts-symbol", kind: "function", name: "a", canonicalIdentity: "scip:a",
      language: "typescript", location: { path: "src/a.ts", startLine: 1 },
      provenance: [{ providerId: "scip-typescript", fidelity: "semantic-reference", freshness: "fresh" }] },
    { id: "ps-symbol", kind: "function", name: "Run", canonicalIdentity: "syntax:Run",
      language: "powershell", location: { path: "scripts/run.ps1", startLine: 2 },
      provenance: [{ providerId: "local-syntax", fidelity: "syntax", freshness: "fresh" }] },
  ],
  relations: [],
  coverage: { degraded: false, providers: [],
    languages: [{ language: "typescript", fileCount: 2,
      semanticEligibleFileCount: 1, semanticIndexedFileCount: 1,
      semanticExcludedFileCount: 1, semanticExclusionReason: "provider_project_scope",
      fidelity: "semantic-reference", providerIds: ["scip-typescript"], degraded: false }],
  },
};

test("bounded list_files preserves exact evidence level, scope exclusions, and unknown file types", () => {
  const first = queryCodeGraph(graph, "composite", { operation: "list_files", limit: 2 });
  if (first.operation !== "list_files") throw Error("wrong operation");
  assert.equal(first.matchedCount, 4);
  assert.deepEqual(first.counts, { semantic: 1, structural: 1, fileOnly: 2, excluded: 1, failed: 0 });
  assert.equal(first.nextOffset, 2);
  assert.equal(first.files.find((entry) => entry.path === "README.md")?.fileType, "documentation");
  const second = queryCodeGraph(graph, "composite", { operation: "list_files", limit: 3,
    offset: 2, expectedSnapshotId: "snapshot-1", expectedSourceIndexedAt: t });
  if (second.operation !== "list_files") throw Error("wrong operation");
  const combined = [...first.files, ...second.files];
  assert.equal(combined.find((entry) => entry.path === "src/a.ts")?.analysisLevel, "semantic");
  assert.deepEqual(combined.find((entry) => entry.path === "src/outside.ts")?.analysisState, "excluded");
  assert.equal(combined.find((entry) => entry.path === "src/outside.ts")?.reason, "provider_project_scope");
  assert.equal(combined.find((entry) => entry.path === "scripts/run.ps1")?.analysisLevel, "structural");
  assert.throws(() => queryCodeGraph(graph, "composite", { operation: "list_files", offset: 1 }),
    /exact snapshot/);
  assert.throws(() => queryCodeGraph(graph, "composite", { operation: "list_files",
    offset: 1, expectedSnapshotId: "snapshot-1", expectedSourceIndexedAt: "stale" }), /exact snapshot/);
});

test("scope excluded path cannot be assigned when native paths do not reconcile", () => {
  const altered = structuredClone(graph);
  altered.coverage!.languages = [{ ...altered.coverage!.languages[0]!, semanticIndexedFileCount: 2,
    semanticEligibleFileCount: 2, semanticExcludedFileCount: 0 }];
  const result = queryCodeGraph(altered, "composite", { operation: "list_files" });
  if (result.operation !== "list_files") throw Error("wrong operation");
  assert.equal(result.files.find((entry) => entry.path === "src/outside.ts")?.analysisState, "included");
});

test("source subsystem accounting reconciles every raw fact without manufacturing a call", () => {
  const nodes: CodeNode[] = [
    { id: "a", kind: "function", name: "a", canonicalIdentity: "scip:a",
      location: { path: "src/a/start.ts", startLine: 1 } },
    { id: "b", kind: "function", name: "b", canonicalIdentity: "scip:b",
      location: { path: "src/b/end.ts", startLine: 1 } },
    { id: "local", kind: "function", name: "local", canonicalIdentity: "scip:local",
      location: { path: "src/a/other.ts", startLine: 1 } },
    { id: "external", kind: "function", name: "external",
      canonicalIdentity: "scip-external:a" },
  ];
  const edge = (id: string, from: string, to: string, kind: CodeRelation["kind"]): CodeRelation =>
    ({ id, from, to, kind, confidence: 1 });
  const source: CodeGraphSnapshot = { schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId: "accounting", rootPath: "/tmp/accounting", indexedAt: t, nodes,
    relations: [edge("cross", "a", "b", "calls"), edge("same", "a", "local", "calls"),
      edge("external", "a", "external", "calls"), edge("contains", "a", "local", "contains")] };
  const result = deriveCodeSourceSubsystems(source);
  const q = result.relationAccounting;
  assert.equal(q.rawRelationCount, 4);
  assert.equal(q.unsupportedKindCount, 1);
  assert.equal(q.unmappedEndpointCount, 1);
  assert.equal(q.sameSubsystemCount, 1);
  assert.equal(q.crossSubsystemCount, 1);
  assert.equal(q.visibleRelationEvidenceCount, 1);
  assert.equal(q.omittedBySubsystemCapCount + q.omittedByRelationCapCount, 0);
  assert.equal(q.rawRelationCount,
    q.unsupportedKindCount + q.unmappedEndpointCount + q.sameSubsystemCount + q.crossSubsystemCount);
  assert.deepEqual(result.relations.map((relation) => relation.sourceRelationIds), [["cross"]]);
});
