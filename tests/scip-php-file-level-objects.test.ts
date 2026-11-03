import assert from "node:assert/strict";
import test from "node:test";
import { normalizeScipGraph, parseScipJsonIndex, type ScipPhpLexicalScope } from "../src/adapters/code-intelligence/scip-normalizer.js";
import { materializeCodeFileHierarchy } from "../src/application/code-map-hierarchy.js";

const prefix = "scip-php composer demo/pkg 1.0 ";
const klass = prefix + "src/Worker.php/Domain\\Worker#";
const method = klass + "start().";

function fixture() {
  const instantiations = Array.from({ length: 7 }, (_, i) => ({
    className: "Domain\\Worker",
    nameRange: [i + 1, 12, i + 1, 18] as const,
  }));
  const calls = Array.from({ length: 7 }, (_, i) => ({
    className: "Domain\\Worker", name: "start",
    nameRange: [i + 1, 23, i + 1, 28] as const,
    callStyle: "object" as const,
  }));
  const scopes = new Map<string, readonly ScipPhpLexicalScope[]>([
    ["src/Worker.php", [
      { type: "class", className: "Domain\\Worker",
        range: [1, 0, 4, 1], nameRange: [1, 6, 1, 12], ancestors: [] },
      { type: "method", name: "start", className: "Domain\\Worker",
        range: [2, 0, 2, 38], nameRange: [2, 18, 2, 23] },
    ]],
    ["src/bootstrap.php", [
      { type: "file", range: [0, 0, 9, 1],
        instantiations, calls,
        unresolvedCalls: [
          { name: "start", nameRange: [8, 12, 8, 17] },
        ] },
    ]],
  ]);
  const index = parseScipJsonIndex({ documents: [
    { relativePath: "src/Worker.php", language: "php",
      symbols: [
        { symbol: klass, displayName: "Worker", kind: "Class" },
        { symbol: method, displayName: "start", kind: "Method" },
      ],
      occurrences: [
        { symbol: klass, symbolRoles: 1, range: [1, 6, 12] },
        { symbol: method, symbolRoles: 1, range: [2, 18, 23] },
      ] },
    { relativePath: "src/bootstrap.php", language: "php", symbols: [], occurrences: [] },
  ] });
  const graph = normalizeScipGraph({
    projectId: "php-file-level", rootPath: "/tmp/php-file-level",
    indexedAt: "2026-11-03T00:00:00Z",
    providerId: "scip-php", index, phpLexicalScopes: scopes,
  });
  return materializeCodeFileHierarchy(graph, [
    { path: "src/Worker.php" }, { path: "src/bootstrap.php" },
  ]);
}

test("C2: seven file-level new occurrences and typed object calls preserve exact evidence", () => {
  const graph = fixture();
  const file = graph.nodes.find((node) => node.canonicalIdentity === "file:src/bootstrap.php")!;
  const worker = graph.nodes.find((node) => node.name === "Worker")!;
  const start = graph.nodes.find((node) => node.name === "start")!;
  assert.ok(file && worker && start);
  const instantiated = graph.relations.filter((relation) =>
    relation.kind === "instantiates" && relation.from === file.id && relation.to === worker.id);
  assert.equal(instantiated.length, 1);
  assert.equal(instantiated[0]?.evidence?.length, 7);
  const called = graph.relations.filter((relation) =>
    relation.kind === "calls" && relation.from === file.id && relation.to === start.id);
  assert.equal(called.length, 1);
  assert.equal(called[0]?.evidence?.length, 7);
  assert.ok(called[0]?.evidence?.every((item) =>
    item.receiverClass === "Domain\\Worker" && item.label?.includes("typed object call")));
  assert.deepEqual(graph.unresolvedPhpMethodCalls?.filter((item) => item.name === "start"),
    [{ name: "start", count: 1 }]);
});

test("C2: unindexed class instantiations are not fabricated", () => {
  const graph = fixture();
  assert.equal(graph.relations.filter((relation) =>
    relation.kind === "instantiates" && graph.nodes.some((node) =>
      node.id === relation.to && node.canonicalIdentity.startsWith("scip-external:"))).length, 0);
});
