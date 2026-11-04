import assert from "node:assert/strict";
import test from "node:test";
import { normalizeScipGraph, parseScipJsonIndex, type ScipPhpLexicalScope } from "../src/adapters/code-intelligence/scip-normalizer.js";

const migration = "database/migrations/2026_create_table.php";
const route = "routes/web.php";
const native = "routes/native.php";
const scopes = new Map<string, ScipPhpLexicalScope[]>([
  [migration, [
    { type: "anonymous_class", range: [0, 0, 24, 1] },
    { type: "method", name: "up", nameRange: [3, 18, 3, 20], range: [3, 2, 12, 3] },
    { type: "anonymous", range: [6, 10, 9, 2] },
    { type: "method", name: "down", nameRange: [13, 18, 13, 22], range: [13, 2, 20, 3] },
  ]],
  [route, [{ type: "anonymous", range: [1, 10, 5, 2] }]],
  [native, [{ type: "anonymous", range: [1, 10, 5, 2] }]],
  ["bootstrap/app.php", [{ type: "anonymous", range: [1, 10, 5, 2] }]],
  ["public/index.php", [{ type: "anonymous", range: [1, 10, 5, 2] }]],
  ["lang/ko.php", [{ type: "anonymous", range: [1, 10, 5, 2] }]],
]);

function graph(indexedAt = "2026-11-04T00:00:00Z") {
  return normalizeScipGraph({
    projectId: "php-syntax-only", rootPath: "/tmp/fixture", indexedAt,
    providerId: "scip-php",
    index: parseScipJsonIndex({ documents: [
      { relativePath: native, language: "php", symbols: [], occurrences: [] },
    ] }),
    phpEligibleFilePaths: [native, migration, route, "bootstrap/app.php", "public/index.php"],
    phpSyntaxOnlyScopes: scopes,
  });
}

test("unindexed executable PHP scopes add stable AST containment without semantic calls", () => {
  const first = graph();
  const second = graph("2026-11-05T00:00:00Z");
  const syntax = first.nodes.filter(node => node.canonicalIdentity.startsWith("php-syntax:"));
  assert.equal(syntax.length, 7);
  assert.equal(first.nodes.filter(node => node.location?.path === native).length, 0);
  assert.equal(first.nodes.filter(node => node.location?.path === "lang/ko.php").length, 0);
  assert.equal(first.relations.filter(edge => edge.kind === "calls").length, 0);
  assert.equal(first.relations.filter(edge => edge.kind === "contains").length, 7);
  assert.ok(syntax.every(node => node.provenance?.[0]?.fidelity === "syntax"));
  assert.deepEqual(syntax.map(node => node.id), second.nodes.filter(node => node.canonicalIdentity.startsWith("php-syntax:")).map(node => node.id));
  const file = first.nodes.find(node => node.canonicalIdentity === `file:${migration}`)!;
  const namedClass = syntax.find(node => node.name.startsWith("anonymous-class@"))!;
  const up = syntax.find(node => node.name === "up")!;
  const down = syntax.find(node => node.name === "down")!;
  const closure = syntax.find(node => node.name.startsWith("closure@") && node.location?.path === migration)!;
  const contains = (from: string, to: string) => first.relations.some(edge => edge.kind === "contains" && edge.from === from && edge.to === to);
  assert.ok(contains(file.id, namedClass.id));
  assert.ok(contains(namedClass.id, up.id));
  assert.ok(contains(namedClass.id, down.id));
  assert.ok(contains(up.id, closure.id));
  const php = first.coverage?.languages.find(item => item.language === "php");
  assert.equal(php?.semanticEligibleFileCount, 5);
  assert.equal(php?.semanticIndexedFileCount, 1);
});

test("dev PHP scopes remain syntax-only; config PHP scopes stay excluded", () => {
  const index = parseScipJsonIndex({ documents: [] });
  const result = normalizeScipGraph({
    projectId: "php-syntax-only", rootPath: "/tmp/fixture", indexedAt: "2026-11-04T00:00:00Z",
    providerId: "scip-php", index,
    phpEligibleFilePaths: ["dev/diagnostic.php", "app/Config/custom.php"],
    phpSyntaxOnlyScopes: new Map<string, ScipPhpLexicalScope[]>([
      ["dev/diagnostic.php", [{ type: "anonymous", range: [0, 0, 2, 1] }]],
      ["app/Config/custom.php", [{ type: "anonymous", range: [0, 0, 2, 1] }]],
    ]),
  });
  assert.equal(result.nodes.filter(node => node.canonicalIdentity.startsWith("php-syntax:")).length, 1);
  assert.equal(result.nodes.filter(node => node.location?.path === "app/Config/custom.php").length, 0);
  assert.equal(result.relations.filter(edge => edge.kind === "contains").length, 1);
  assert.equal(result.relations.filter(edge => edge.kind === "calls").length, 0);
});

test("unindexed PHP AST call hints never become semantic edges", () => {
  const result = normalizeScipGraph({
    projectId: "php-syntax-only", rootPath: "/tmp/fixture", indexedAt: "2026-11-04T00:00:00Z",
    providerId: "scip-php", index: parseScipJsonIndex({ documents: [] }),
    phpEligibleFilePaths: ["routes/api.php"],
    phpSyntaxOnlyScopes: new Map<string, ScipPhpLexicalScope[]>([["routes/api.php", [
      { type: "anonymous", range: [0, 0, 6, 1],
        calls: [{ className: "App\\Service", name: "run", nameRange: [2, 2, 2, 5] }],
        unresolvedCalls: [{ name: "dynamic", nameRange: [3, 2, 3, 9] }] },
    ]]]),
  });
  assert.equal(result.nodes.filter(node => node.canonicalIdentity.startsWith("php-syntax:")).length, 1);
  assert.equal(result.relations.filter(edge => edge.kind === "contains").length, 1);
  assert.equal(result.relations.filter(edge => edge.kind === "calls" || edge.kind === "depends_on").length, 0);
});