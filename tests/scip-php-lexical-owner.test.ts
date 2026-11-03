import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeScipGraph,
  parseScipJsonIndex,
  type ScipPhpLexicalScope,
} from "../src/adapters/code-intelligence/scip-normalizer.js";

const caller = "scip-php composer test/example 1.0.0 src/Main.php/caller().";
const callee = "scip-php composer test/example 1.0.0 src/Main.php/callee().";
const widget = "scip-php composer test/example 1.0.0 src/Main.php/Widget#";
const source = [
  "<?php",
  "function caller() {",
  "  callee();",
  "  $fn = function() {",
  "     callee();",
  "  };",
  "  new Widget();",
  "}",
  "function callee() {}",
  "class Widget {}",
].join("\n");

const scopes: ScipPhpLexicalScope[] = [
  { type: "function", name: "caller", nameRange: [1, 9, 1, 15], range: [1, 0, 7, 1] },
  { type: "anonymous", range: [3, 8, 5, 4] },
  { type: "function", name: "callee", nameRange: [8, 9, 8, 15], range: [8, 0, 8, 20] },
];

function phpIndex() {
  return parseScipJsonIndex({
    documents: [{
      relativePath: "src/Main.php",
      language: "php",
      symbols: [
        { symbol: caller, kind: "Function", displayName: "caller" },
        { symbol: callee, kind: "Function", displayName: "callee" },
        { symbol: widget, kind: "Class", displayName: "Widget" },
      ],
      occurrences: [
        { symbol: caller, symbolRoles: 1, range: [1, 9, 15] },
        { symbol: callee, symbolRoles: 0, range: [2, 2, 8] },
        { symbol: callee, symbolRoles: 0, range: [4, 5, 11] },
        { symbol: widget, symbolRoles: 0, range: [6, 6, 12] },
        { symbol: callee, symbolRoles: 1, range: [8, 9, 15] },
        { symbol: widget, symbolRoles: 1, range: [9, 6, 12] },
      ],
    }],
  });
}

function normalize(phpScopes?: ScipPhpLexicalScope[], sourceOverride = source) {
  return normalizeScipGraph({
    projectId: "php-lexical-verified",
    rootPath: "/isolated/php-fixture",
    indexedAt: "2026-10-30T00:00:00.000Z",
    providerId: "scip-php",
    index: phpIndex(),
    sourceTextByPath: new Map([["src/Main.php", sourceOverride]]),
    ...(phpScopes ? { phpLexicalScopes: new Map([["src/Main.php", phpScopes]]) } : {}),
  });
}

test("PHP AST native-name-aligned owner restores one direct call and one instantiation", () => {
  const graph = normalize(scopes);
  const node = (sym: string) => {
    const stable = sym.replace(/^(scip-php\s+composer\s+\S+)\s+\S+\s+/, "$1 ");
    return graph.nodes.find(n => n.canonicalIdentity === "scip:" + sym
      || n.canonicalIdentity.endsWith(":" + stable))?.id;
  };
  assert.ok(node(caller) && node(callee) && node(widget));
  const calls = graph.relations.filter(r => r.kind === "calls");
  const constructions = graph.relations.filter(r => r.kind === "instantiates");
  assert.equal(calls.length, 2, "anonymous callback has its own verified lexical owner");
  assert.equal(constructions.length, 1);
  const direct = calls.find(r => r.from === node(caller));
  const anonymous = graph.nodes.find(n => n.canonicalIdentity.startsWith("php-anonymous:"));
  assert.ok(anonymous, "PHP AST anonymous owner must be preserved");
  const inside = calls.find(r => r.from === anonymous.id);
  assert.ok(direct && inside);
  assert.equal(direct.to, node(callee));
  assert.equal(inside.to, node(callee));
  assert.equal(calls.filter(r => r.from === node(caller)).length, 1,
    "anonymous callback must not be attributed to outer caller");
  assert.equal(constructions[0]?.from, node(caller));
  assert.equal(constructions[0]?.to, node(widget));
  assert.equal(direct.evidence?.[0]?.location.path, "src/Main.php");
  assert.equal(direct.provenance?.[0]?.providerId, "scip-php");
});

test("PHP graph never guesses calls without an AST owner", () => {
  const noScope = normalize();
  assert.equal(noScope.relations.filter(r => r.kind === "calls").length, 0);
  const wrongName = normalize(scopes.map(scope => scope.name === "caller"
    ? { ...scope, name: "differentFunction" } : scope));
  const anonymous = wrongName.nodes.find(n => n.canonicalIdentity.startsWith("php-anonymous:"));
  assert.ok(anonymous);
  assert.equal(wrongName.relations.filter(r => r.kind === "calls").length, 1);
  assert.ok(wrongName.relations.some(r => r.kind === "calls" && r.from === anonymous.id),
    "verified anonymous owner survives a missing outer named owner");
  assert.equal(wrongName.relations.filter(r => r.kind === "instantiates").length, 0);
});

test("PHP scopes with unknown named ownership block outer lexical attribution", () => {
  const nestedUnknown: ScipPhpLexicalScope[] = [
    scopes[0]!,
    { type: "function", name: "nonexistent", nameRange: [2, 2, 2, 8], range: [2, 0, 2, 11] },
    scopes[1]!,
    scopes[2]!,
  ];
  const graph = normalize(nestedUnknown);
  const anonymous = graph.nodes.find(n => n.canonicalIdentity.startsWith("php-anonymous:"));
  assert.ok(anonymous);
  assert.equal(graph.relations.filter(r => r.kind === "calls").length, 1);
  assert.ok(graph.relations.some(r => r.kind === "calls" && r.from === anonymous.id),
    "unknown nested named owner must still block its own call without suppressing the verified closure");
  assert.equal(graph.relations.filter(r => r.kind === "instantiates").length, 1);
});


test("new without constructor parentheses still yields instantiates only for verified new keyword", () => {
  const graph = normalize(scopes, source.replace("new Widget();", "new Widget;"));
  assert.equal(graph.relations.filter((edge) => edge.kind === "instantiates").length, 1);
  const negative = normalize(scopes, source.replace("new Widget();", "use Widget();"));
  assert.equal(negative.relations.filter((edge) => edge.kind === "instantiates").length, 0);
});
