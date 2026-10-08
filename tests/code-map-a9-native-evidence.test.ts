import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CODE_GRAPH_SCHEMA_VERSION,
  CodeMapService,
  type CodeGraphSnapshot,
  type CodeIntelligenceProvider,
  type CodeMapPersistedSnapshotStore,
} from "../src/index.js";
import { normalizeScipGraph, parseScipJsonIndex } from "../src/adapters/code-intelligence/scip-normalizer.js";
import { computeCodeMapSnapshotIdentity } from "../src/application/code-map-snapshot-identity.js";
import { CompositeCodeIntelligenceProvider } from "../src/application/composite-code-intelligence-provider.js";

const OWNER = "scip ts example 0 owner/registerTools().";
const TARGET = "scip ts example 0 owner/wrapper().";
const UNUSED = "scip ts example 0 owner/unused().";
const INDEXED_AT = "2026-10-08T00:00:00.000Z";
const NATIVE_SHA = "b".repeat(64);
const source = "function registerTools() {\n  wrapper();\n  wrapper();\n}\nfunction wrapper() {}\nfunction unused() {}\n";

function nativeGraph(): CodeGraphSnapshot {
  return normalizeScipGraph({
    projectId: "project-1",
    rootPath: "/workspace/project-1",
    indexedAt: INDEXED_AT,
    providerId: "scip-typescript",
    indexArtifactSha256: NATIVE_SHA,
    sourceTextByPath: new Map([["src/owner.ts", source]]),
    index: parseScipJsonIndex({
      documents: [{
        relativePath: "src/owner.ts",
        language: "typescript",
        symbols: [
          { symbol: OWNER, displayName: "registerTools", kind: "Function" },
          { symbol: TARGET, displayName: "wrapper", kind: "Function" },
          { symbol: UNUSED, displayName: "unused", kind: "Function" },
        ],
        occurrences: [
          { symbol: OWNER, symbolRoles: 1, range: [0, 9, 22], enclosingRange: [0, 0, 3, 1] },
          { symbol: TARGET, symbolRoles: 1, range: [4, 9, 16], enclosingRange: [4, 0, 4, 21] },
          { symbol: UNUSED, symbolRoles: 1, range: [5, 9, 15], enclosingRange: [5, 0, 5, 20] },
          { symbol: TARGET, symbolRoles: 0, range: [1, 2, 9] },
          { symbol: TARGET, symbolRoles: 0, range: [2, 2, 9] },
          // A native reference with no range must count even though it is not a relation.
          { symbol: TARGET, symbolRoles: 0 },
        ],
      }],
      externalSymbols: [],
    }),
  });
}

test("A9: provider-native lexical extent and all raw callsites survive dedupe without inventing owner edges", () => {
  const graph = nativeGraph();
  const owner = graph.nodes.find((node) => node.name === "registerTools")!;
  const target = graph.nodes.find((node) => node.name === "wrapper")!;
  assert.deepEqual(owner.location, { path: "src/owner.ts", startLine: 1, startColumn: 10, endLine: 1, endColumn: 23 });
  assert.deepEqual(owner.lexicalExtent, { path: "src/owner.ts", startLine: 1, startColumn: 1, endLine: 4, endColumn: 2 });
  const outgoing = graph.relations.filter((relation) => relation.from === owner.id && relation.to === target.id && relation.kind === "calls");
  assert.equal(outgoing.length, 1);
  assert.deepEqual(outgoing[0]!.evidence?.map((item) => item.location.startLine), [2, 3]);
  assert.deepEqual(outgoing[0]!.evidence?.map((item) => item.location.startColumn), [3, 3]);
  assert.equal(outgoing[0]!.confidence, 1);
  assert.equal(outgoing[0]!.provenance?.[0]?.providerId, "scip-typescript");
  assert.equal(graph.relations.some((relation) => relation.from === target.id && relation.to === owner.id && relation.kind === "calls"), false);
  const run = graph.providerRuns?.[0]!;
  assert.equal(run.nativeArtifactSha256, NATIVE_SHA);
  assert.equal(run.fingerprint, createHash("sha256").update(JSON.stringify([run.providerId, NATIVE_SHA, INDEXED_AT])).digest("hex"));
  assert.equal(run.nativeReferences.find((item) => item.canonicalIdentity === target.canonicalIdentity)?.referenceOccurrenceCount, 3);
  assert.equal(run.nativeReferences.find((item) => item.canonicalIdentity === graph.nodes.find((node) => node.name === "unused")?.canonicalIdentity)?.referenceOccurrenceCount, 0);
});

function persistence(store: CodeMapPersistedSnapshotStore, providerFingerprint = "fixture-v1", rootPath = "/workspace/project-1") {
  return {
    store,
    providerConfigFingerprint: providerFingerprint,
    sourceState: {
      rootIdentity: (path: string) => `root:${path}`,
      sourceManifestFingerprint: () => "manifest-v1",
    },
    rootPathForProject: (id: string) => id === "project-1" ? rootPath : undefined,
    now: () => INDEXED_AT,
  };
}

test("A9: exact graph/snapshot/run identity pins persisted read and rejects tampering", async () => {
  const graph = nativeGraph();
  const holder: { saved?: unknown } = {};
  const store: CodeMapPersistedSnapshotStore = {
    load: () => holder.saved,
    save: (_id, value) => { holder.saved = structuredClone(value); },
  };
  const provider: CodeIntelligenceProvider = {
    providerId: "scip-typescript",
    capabilities: { incrementalIndexing: false, impactAnalysis: false, callTrace: false },
    indexProject: async () => graph,
  };
  const service = new CodeMapService(provider, undefined, undefined, undefined, persistence(store));
  await service.refresh({ projectId: "project-1", rootPath: "/workspace/project-1" });
  const identity = service.snapshotIdentity("project-1")!;
  assert.match(identity.graphDigest, /^[a-f0-9]{64}$/);
  assert.match(identity.snapshotId, /^[a-f0-9]{64}$/);
  assert.match(identity.providerRunFingerprint!, /^[a-f0-9]{64}$/);
  const envelope = holder.saved as Record<string, unknown>;
  assert.equal(envelope.snapshotId, identity.snapshotId);
  assert.equal(envelope.graphDigest, identity.graphDigest);
  assert.equal(envelope.providerRunFingerprint, identity.providerRunFingerprint);
  const independent = computeCodeMapSnapshotIdentity({
    graph, projectId: "project-1", rootIdentity: "root:/workspace/project-1",
    providerConfigFingerprint: "fixture-v1", sourceManifestFingerprint: "manifest-v1",
  });
  assert.deepEqual(identity, independent);
  const restored = new CodeMapService(provider, undefined, undefined, undefined, persistence(store));
  assert.equal(restored.snapshotIdentity("project-1")?.snapshotId, identity.snapshotId);
  assert.equal(restored.query("project-1", { operation: "find_nodes", query: "wrapper", expectedSnapshotId: identity.snapshotId }).snapshotId, identity.snapshotId);
  assert.throws(() => restored.query("project-1", { operation: "find_nodes", expectedSnapshotId: "a".repeat(64) }),
    (error: unknown) => (error as { code?: string }).code === "code_map_snapshot_changed");

  const original = structuredClone(holder.saved);
  const assertRejected = (modified: unknown, expected: string, config = persistence(store)) => {
    holder.saved = modified;
    const candidate = new CodeMapService(provider, undefined, undefined, undefined, config);
    assert.equal(candidate.getCached("project-1"), undefined);
    assert.equal(candidate.hydrationDiagnostic("project-1")?.hydrationRejectReason, expected);
  };
  const tamperedGraph = structuredClone(original) as { graph: CodeGraphSnapshot };
  tamperedGraph.graph.indexedAt = "2026-10-08T01:00:00.000Z";
  assertRejected(tamperedGraph, "identity_invalid");
  assertRejected({ ...(original as object), snapshotId: "a".repeat(64) }, "identity_invalid");
  assertRejected({ ...(original as object), graphDigest: undefined }, "identity_invalid");
  const changedRun = structuredClone(original) as { graph: { providerRuns: Array<{ fingerprint: string }> } };
  changedRun.graph.providerRuns[0]!.fingerprint = "a".repeat(64);
  assertRejected(changedRun, "identity_invalid");
  assertRejected(original, "provider_changed", persistence(store, "wrong-provider"));
  assertRejected(original, "root_changed", persistence(store, "fixture-v1", "/workspace/wrong"));
});

test("A9: composite keeps only non-conflicting native extents and preserves run evidence", async () => {
  const graph = nativeGraph();
  const altered = structuredClone(graph);
  const originalOwner = graph.nodes.find((node) => node.name === "registerTools")!;
  altered.nodes = altered.nodes.map((node) => node.id === originalOwner.id
    ? { ...node, lexicalExtent: { path: "src/owner.ts", startLine: 1, startColumn: 1, endLine: 3, endColumn: 1 } }
    : node);
  delete altered.providerRuns;
  const asProvider = (id: string, data: CodeGraphSnapshot): CodeIntelligenceProvider => ({
    providerId: id,
    fidelity: "semantic-call",
    capabilities: { incrementalIndexing: false, impactAnalysis: false, callTrace: false },
    indexProject: async () => data,
  });
  const composite = new CompositeCodeIntelligenceProvider(
    [asProvider("scip-typescript", graph), asProvider("second-provider", altered)],
    { listFiles: async () => [{ path: "src/owner.ts" }] },
  );
  const merged = await composite.indexProject({ projectId: "project-1", rootPath: "/workspace/project-1" });
  assert.equal(merged.nodes.find((node) => node.name === "registerTools")?.lexicalExtent, undefined);
  assert.equal(merged.providerRuns?.length, 1);
  assert.equal(merged.providerRuns?.[0]?.nativeArtifactSha256, NATIVE_SHA);
  assert.equal(merged.relations.filter((relation) => relation.from === originalOwner.id && relation.kind === "calls").length, 1);
});
