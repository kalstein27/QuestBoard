import assert from "node:assert/strict";
import test from "node:test";
import { normalizeScipGraph, parseScipJsonIndex, type ScipPhpLexicalScope } from "../src/adapters/code-intelligence/scip-normalizer.js";

const symbol = (owner: string, method: string) => "scip-php composer example/app 1.0.0 src/" + owner + ".php/" + owner + "#" + method + "().";
const caller = symbol("EditHandler", "afterWorks");
const setter = symbol("ScoutSchedule", "setScoutVersion");
const otherSetter = symbol("OtherSchedule", "setScoutVersion");
const nativeSetter = symbol("ScoutSchedule", "getScoutVersion");
const methodScope = (name: string, range: [number, number, number, number], nameRange: [number, number, number, number],
  className: string, calls: ScipPhpLexicalScope["calls"] = []): ScipPhpLexicalScope =>
  ({ type: "method", name, range, nameRange, className, calls });
const index = parseScipJsonIndex({
  documents: [
    { relativePath: "src/EditHandler.php", language: "php",
      symbols: [{ symbol: caller, kind: "Method", displayName: "afterWorks" }],
      occurrences: [{ symbol: caller, symbolRoles: 1, range: [2, 18, 28] }],
    },
    { relativePath: "src/ScoutSchedule.php", language: "php",
      symbols: [
        { symbol: setter, kind: "Method", displayName: "setScoutVersion" },
        { symbol: nativeSetter, kind: "Method", displayName: "getScoutVersion" },
      ],
      occurrences: [
        { symbol: setter, symbolRoles: 1, range: [2, 18, 33] },
        { symbol: nativeSetter, symbolRoles: 1, range: [3, 18, 33] },
      ],
    },
    { relativePath: "src/OtherSchedule.php", language: "php",
      symbols: [{ symbol: otherSetter, kind: "Method", displayName: "setScoutVersion" }],
      occurrences: [{ symbol: otherSetter, symbolRoles: 1, range: [2, 18, 33] }],
    },
  ],
});
const targetScopes = new Map<string, ScipPhpLexicalScope[]>([
  ["src/ScoutSchedule.php", [
    methodScope("setScoutVersion", [2, 0, 2, 55], [2, 18, 2, 33], "App\\Model\\ScoutSchedule"),
    methodScope("getScoutVersion", [3, 0, 3, 55], [3, 18, 3, 33], "App\\Model\\ScoutSchedule"),
  ]],
  ["src/OtherSchedule.php", [
    methodScope("setScoutVersion", [2, 0, 2, 55], [2, 18, 2, 33], "App\\Model\\OtherSchedule"),
  ]],
]);
const build = (calls: ScipPhpLexicalScope["calls"], ownerName = "afterWorks",
  nestedAnonymous = false) => {
  const ownerScope = methodScope(ownerName, [2, 0, 13, 1], [2, 18, 2, 28], "App\\Handler\\EditHandler", calls);
  return normalizeScipGraph({
    projectId: "typed-call-recovery",
    rootPath: "/tmp/typed-call-fixture",
    indexedAt: "2026-11-02T00:00:00Z",
    providerId: "scip-php",
    index,
    phpLexicalScopes: new Map([...targetScopes,
      ["src/EditHandler.php", [ownerScope, ...(nestedAnonymous ? [
        { type: "anonymous" as const, range: [8, 0, 10, 1] as const },
      ] : [])]]]),
  });
};
const scipId = (graph: ReturnType<typeof build>, sym: string) =>
  graph.nodes.find(node => node.canonicalIdentity === "scip:" + sym)?.id;
const sample = (className: string, name: string, line: number) =>
  ({ className, name, nameRange: [line, 7, line, 7 + name.length] as const });

test("typed object calls recover two exact call sites, not another class with the same method name", () => {
  const graph = build([
    sample("App\\Model\\ScoutSchedule", "setScoutVersion", 5),
    sample("App\\Model\\ScoutSchedule", "setScoutVersion", 6),
  ]);
  const edges = graph.relations.filter(edge => edge.kind === "calls");
  assert.equal(edges.length, 1);
  assert.equal(edges[0]?.from, scipId(graph, caller));
  assert.equal(edges[0]?.to, scipId(graph, setter));
  assert.notEqual(edges[0]?.to, scipId(graph, otherSetter));
  assert.deepEqual(edges[0]?.evidence?.map(item => item.location.startLine), [6, 7]);
  assert.deepEqual(edges[0]?.provenance, [
    { providerId: "questboard-php-ast", fidelity: "syntax", freshness: "fresh" },
  ]);
});

test("unresolved target, misaligned caller and anonymous ownership never manufacture calls", () => {
  assert.equal(build([sample("App\\Model\\UnknownSchedule", "setScoutVersion", 5)])
    .relations.filter(edge => edge.kind === "calls").length, 0);
  assert.equal(build([sample("App\\Model\\ScoutSchedule", "setScoutVersion", 5)], "unknownOwner")
    .relations.filter(edge => edge.kind === "calls").length, 0);
  assert.equal(build([sample("App\\Model\\ScoutSchedule", "setScoutVersion", 9)], "afterWorks", true)
    .relations.filter(edge => edge.kind === "calls").length, 0);
});

test("method case differences are allowed only with one exact class-qualified SCIP definition", () => {
  const graph = build([sample("app\\MODEL\\scoutschedule", "setscoutversion", 5)]);
  assert.equal(graph.relations.filter(edge => edge.kind === "calls")[0]?.to, scipId(graph, setter));
});
