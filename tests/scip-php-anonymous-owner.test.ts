import assert from "node:assert/strict";
import test from "node:test";
import { normalizeScipGraph, parseScipJsonIndex, type ScipPhpLexicalScope } from "../src/adapters/code-intelligence/scip-normalizer.js";
import { materializeCodeFileHierarchy } from "../src/application/code-map-hierarchy.js";

const prefix = "scip-php composer demo/pkg 1.0 ";
const target = prefix + "src/Order.php/Domain\\Order#save().";
const outer = prefix + "src/Service.php/Domain\\Service#run().";

function fixture() {
  const scopes = new Map<string, readonly ScipPhpLexicalScope[]>([
    ["src/Order.php", [
      { type: "method", name: "save", className: "Domain\\Order",
        range: [1, 0, 1, 36], nameRange: [1, 20, 1, 24] },
    ]],
    ["src/Service.php", [
      { type: "method", name: "run", className: "Domain\\Service",
        range: [1, 0, 7, 1], nameRange: [1, 20, 1, 23] },
      { type: "anonymous", range: [2, 4, 4, 2], calls: [
        { className: "Domain\\Order", name: "save", nameRange: [3, 18, 3, 22] },
      ], unresolvedCalls: [
        { name: "unknown", nameRange: [3, 26, 3, 33] },
      ] },
      { type: "anonymous", range: [5, 4, 5, 44], calls: [
        { className: "Domain\\Order", name: "save", nameRange: [5, 30, 5, 34] },
      ] },
    ]],
  ]);
  const index = parseScipJsonIndex({ documents: [
    { relativePath: "src/Order.php", language: "php",
      symbols: [{ symbol: target, displayName: "save", kind: "Method" }],
      occurrences: [{ symbol: target, symbolRoles: 1, range: [1, 20, 24] }] },
    { relativePath: "src/Service.php", language: "php",
      symbols: [{ symbol: outer, displayName: "run", kind: "Method" }],
      occurrences: [
        { symbol: outer, symbolRoles: 1, range: [1, 20, 23] },
        { symbol: target, symbolRoles: 0, range: [3, 18, 22] },
        { symbol: target, symbolRoles: 0, range: [5, 30, 34] },
      ] },
  ] });
  const result = normalizeScipGraph({
    projectId: "php-anonymous-owner", rootPath: "/tmp/php-anonymous-owner",
    indexedAt: "2026-11-03T00:00:00Z", providerId: "scip-php",
    index, phpLexicalScopes: scopes,
  });
  return materializeCodeFileHierarchy(result, [
    { path: "src/Order.php" }, { path: "src/Service.php" },
  ]);
}

test("C1: closure and arrow calls belong only to their own lexical function nodes", () => {
  const graph = fixture();
  const method = graph.nodes.find((node) => node.name === "run")!;
  const save = graph.nodes.find((node) => node.name === "save")!;
  const anonymous = graph.nodes.filter((node) => node.canonicalIdentity.startsWith("php-anonymous:"));
  assert.equal(anonymous.length, 2);
  assert.notEqual(anonymous[0]?.id, anonymous[1]?.id);
  assert.ok(anonymous.every((node) => node.kind === "function" && node.location?.path === "src/Service.php"));
  for (const node of anonymous) {
    assert.ok(graph.relations.some((relation) =>
      relation.kind === "contains" && relation.from === method.id && relation.to === node.id));
    const calls = graph.relations.filter((relation) =>
      relation.kind === "calls" && relation.from === node.id && relation.to === save.id);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.evidence?.length, 1);
  }
  assert.ok(!graph.relations.some((relation) =>
    relation.kind === "calls" && relation.from === method.id && relation.to === save.id));
  assert.deepEqual(graph.unresolvedPhpMethodCalls?.filter((item) => item.name === "unknown"),
    [{ name: "unknown", count: 1 }]);
});

test("C1: AST-backed anonymous node identities remain stable across equivalent reindexes", () => {
  const first = fixture();
  const second = fixture();
  assert.deepEqual(
    first.nodes.filter((node) => node.canonicalIdentity.startsWith("php-anonymous:")).map((node) => node.id),
    second.nodes.filter((node) => node.canonicalIdentity.startsWith("php-anonymous:")).map((node) => node.id),
  );
});
