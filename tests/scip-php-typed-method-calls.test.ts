import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPhpLexicalScopes } from "../src/adapters/code-intelligence/php-lexical-scopes.js";
import { queryCodeGraph } from "../src/application/code-map-query.js";
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
const scipId = (graph: ReturnType<typeof build>, sym: string) => {
  const stableDescriptor = sym.replace(/^(scip-php\s+composer\s+\S+)\s+\S+\s+/, "$1 ");
  return graph.nodes.find(node => node.canonicalIdentity === "scip:" + sym
    || node.canonicalIdentity.endsWith(":" + stableDescriptor))?.id;
};
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

test("MCP callers query distinguishes zero verified calls from same-name unresolved PHP sites", () => {
  const graph = build([sample("App\\Model\\ScoutSchedule", "setScoutVersion", 5)]);
  graph.unresolvedPhpMethodCalls = [{ name: "setscoutversion", count: 3 }];
  const result = queryCodeGraph(graph, "scip-php", {
    operation: "relations", semantic: "callers", nodeId: scipId(graph, otherSetter)!,
  });
  assert.equal(result.operation, "relations");
  assert.equal(result.entries.length, 0);
  assert.equal(result.unresolvedSameNameCallSiteCount, 3);
  assert.equal(result.callersMayBeIncomplete, true);
});

const orderSources: Record<string, string> = {
  "src/Entity.php": [
    "<?php", "namespace Domain;",
    "abstract class Entity { public function setCreatedAt(int $t): static { return $this; } }",
  ].join("\n"),
  "src/Order.php": [
    "<?php", "namespace Domain;",
    "final class Order extends Entity {",
    "public int $version = 0;",
    "public function setVersion(int $v): Order { return $this; }",
    "public function setStatus(int $s): static { return $this; }", "}",
  ].join("\n"),
  "src/OtherOrder.php": [
    "<?php", "namespace Domain;",
    "final class OtherOrder {",
    "public function setVersion(int $v): OtherOrder { return $this; }", "}",
  ].join("\n"),
  "src/OrderRepository.php": [
    "<?php", "namespace Domain;",
    "final class OrderRepository {",
    "public static function findById(int $id): ?Order { return null; }",
    "/** @return Order[] */",
    "public static function findOpen(): array { return []; }",
    "/** @return array<Order> */",
    "public static function findMore(): array { return []; }",
    "/** @return list<Order> */",
    "public static function findList(): array { return []; }",
    "public static function ambiguous(): Order|OtherOrder { return new Order(); }",
    "}",
  ].join("\n"),
  "src/OrderService.php": [
    "<?php", "namespace Domain;",
    "final class OrderService {",
    "public static function bump(int $id): void {",
    "$order = OrderRepository::findById($id);",
    "if ($order instanceof Order) { $order->setVersion(2); }",
    "}",
    "public static function bumpAll(): void {",
    "$openOrders = OrderRepository::findOpen();",
    "foreach ($openOrders as $order) { $order->setVersion(2); }",
    "}",
    "public static function reset(Order $order): void {",
    "$order->setVersion(0)->setStatus(0);",
    "}",
    "public static function bumpMore(): void {",
    "foreach (OrderRepository::findMore() as $order) { $order->setVersion(3); }",
    "}",
    "public static function bumpList(): void {",
    "$orders = OrderRepository::findList();",
    "foreach ($orders as $order) { $order->setVersion(4); }",
    "}",
    "public static function bumpVar(): void {",
    "/** @var Order[] $orders */",
    "$orders = getOrdersFromUnknownSource();",
    "foreach ($orders as $order) { $order->setVersion(5); }",
    "}",
    "public static function inherit(Order $order): void { $order->setCreatedAt(1); }",
    "public static function propRead(Order $order): int { return $order->version + 1; }",
    "public static function propWrite(Order $order): void { $order->version = 3; }",
    "public static function propUnknown(object $value): void { $value->version = 3; }",
    "/** @param Order[] $orders */",
    "public static function touchAll(array $orders): void {",
    "foreach ($orders as $order) { $order->setVersion(6); }",
    "}",
    "public static function closureCall(): void {",
    "$ids = [1];",
    "array_walk($ids, function (int $id) { OrderRepository::findById($id); });",
    "$f = fn(Order $o) => $o->setStatus(0);",
    "}",
    "public static function skipUnknown(object $unknown): void {",
    "$unknown->setVersion(1);",
    "}",
    "public static function skipUnion(): void {",
    "$order = OrderRepository::ambiguous();",
    "$order->setVersion(1);",
    "}",
    "public static function skipAfterBranch(): void {",
    "if (true) { $order = new Order(); }",
    "$order->setVersion(1);",
    "}",
    "public static function skipAfterLoop(): void {",
    "foreach ([new Order()] as $order) { $order->setVersion(1); }",
    "$order->setVersion(2);",
    "}",
    "}",
    "OrderService::reset(new Order());",
  ].join("\n"),
};

test("real PHP AST: cross-file nullable native returns, docblock foreach and self/static fluent chains remain exact", async (t) => {
  const autoload = process.env.QUESTBOARD_TEST_PHP_PARSER_AUTOLOAD;
  if (!autoload) { t.skip("Set QUESTBOARD_TEST_PHP_PARSER_AUTOLOAD to a trusted installed PHP Parser 5 autoload.php"); return; }
  const root = mkdtempSync(join(tmpdir(), "questboard-php-order-patterns-"));
  try {
    mkdirSync(join(root, "src")); mkdirSync(join(root, "vendor"));
    writeFileSync(join(root, "vendor/autoload.php"), "<?php require " + JSON.stringify(autoload) + ";");
    for (const [relative, source] of Object.entries(orderSources)) writeFileSync(join(root, relative), source);
    const phpScopes = await extractPhpLexicalScopes(root, Object.keys(orderSources));
    const documents = [...phpScopes].map(([relativePath, scopes]) => ({
      relativePath,
      language: "php",
      symbols: scopes.filter((scope) => (scope.type === "method" || scope.type === "class") && scope.nameRange)
        .map((scope) => ({
          symbol: "scip-php composer example/app 1.0.0 " + relativePath + "/" + scope.className + "#"
            + (scope.type === "method" ? scope.name + "()." : ""),
          kind: scope.type === "class" ? "Class" : "Method",
          displayName: scope.type === "class" ? scope.className!.split("\\").at(-1) : scope.name,
        })).concat(scopes.filter((scope) => scope.type === "class")
          .flatMap((scope) => (scope.propertyDefinitions ?? []).map((property) => ({
            symbol: "scip-php composer example/app 1.0.0 " + relativePath + "/" + scope.className + "#$" + property.name + ".",
            kind: "Property", displayName: "$" + property.name,
          })))),
      occurrences: scopes.filter((scope) => (scope.type === "method" || scope.type === "class") && scope.nameRange)
        .map((scope) => ({
          symbol: "scip-php composer example/app 1.0.0 " + relativePath + "/" + scope.className + "#"
            + (scope.type === "method" ? scope.name + "()." : ""),
          symbolRoles: 1,
          range: [scope.nameRange![0], scope.nameRange![1], scope.nameRange![3]],
        })).concat(scopes.filter((scope) => scope.type === "class")
          .flatMap((scope) => (scope.propertyDefinitions ?? []).map((property) => ({
            symbol: "scip-php composer example/app 1.0.0 " + relativePath + "/" + scope.className + "#$" + property.name + ".",
            symbolRoles: 1,
            range: [property.nameRange[0], property.nameRange[1], property.nameRange[3]],
          })))),
    }));
    const graph = normalizeScipGraph({
      projectId: "order-patterns",
      rootPath: root,
      indexedAt: "2026-11-02T00:00:00Z",
      providerId: "scip-php",
      index: parseScipJsonIndex({ documents }),
      phpLexicalScopes: phpScopes,
    });
    const get = (className: string, methodName: string) => graph.nodes.find((node) =>
      node.kind === "method" && node.name === methodName
      && node.canonicalIdentity.includes(className + "#" + methodName));
    const target = get("Domain\\Order", "setVersion");
    const status = get("Domain\\Order", "setStatus");
    const createdAt = get("Domain\\Entity", "setCreatedAt");
    assert.ok(target && status && createdAt);
    const version = graph.nodes.find((node) => node.kind === "property" && node.name === "$version");
    assert.ok(version);
    for (const [kind, owner] of [["reads", "propRead"], ["writes", "propWrite"]] as const) {
      assert.ok(graph.relations.some((edge) => edge.kind === kind && edge.to === version.id
        && graph.nodes.find((node) => node.id === edge.from)?.name === owner), "B2 " + kind);
    }
    assert.ok(!graph.relations.some((edge) => edge.kind === "writes" && edge.to === version.id
      && graph.nodes.find((node) => node.id === edge.from)?.name === "propUnknown"), "B2 untyped exclusion");
    const callOwners = (id: string) => graph.relations.filter((edge) =>
      edge.kind === "calls" && edge.to === id).map((edge) => ({
        name: graph.nodes.find((node) => node.id === edge.from)?.name,
        label: edge.evidence?.[0]?.label,
      }));
    const owners = callOwners(target.id);
    for (const expected of ["bump", "bumpAll", "reset", "bumpMore", "bumpList", "bumpVar"]) {
      assert.ok(owners.some((entry) => entry.name === expected), "missing " + expected);
    }
    assert.ok(callOwners(status.id).some((entry) => entry.name === "reset"), "native static fluent return");
    assert.ok(callOwners(createdAt.id).some((entry) => entry.name === "inherit"), "A3 inherited method call");
    assert.ok(owners.some((entry) => entry.name === "touchAll" && entry.label?.includes("docblock")), "B3 @param array");
    assert.ok(graph.relations.some((edge) => edge.kind === "extends"
      && graph.nodes.find((node) => node.id === edge.from)?.name === "Order"
      && graph.nodes.find((node) => node.id === edge.to)?.name === "Entity"), "B1 extends");
    assert.ok(graph.relations.some((edge) => edge.kind === "calls"
      && graph.nodes.find((node) => node.id === edge.from)?.kind === "file"
      && graph.nodes.find((node) => node.id === edge.to)?.name === "reset"), "A2 file top-level call");
    assert.ok(graph.unresolvedPhpMethodCalls?.some((entry) => entry.name === "setstatus" && entry.count > 0),
      "A1 closure arrow call must be flagged");
    for (const excluded of ["skipUnknown", "skipUnion", "skipAfterBranch", "skipAfterLoop"]) {
      assert.ok(!owners.some((entry) => entry.name === excluded), "incorrect inferred call from " + excluded);
    }
    assert.ok(owners.some((entry) => entry.name === "bumpAll" && entry.label?.includes("docblock")));
    assert.ok(graph.unresolvedPhpMethodCalls?.some((entry) => entry.name === "setversion" && entry.count >= 2));
    const callers = queryCodeGraph(graph, "scip-php", { operation: "relations", semantic: "callers", nodeId: target.id });
    assert.equal(callers.operation, "relations");
    assert.ok((callers.unresolvedSameNameCallSiteCount ?? 0) >= 2);
    assert.equal(callers.callersMayBeIncomplete, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
