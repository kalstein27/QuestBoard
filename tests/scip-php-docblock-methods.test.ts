import assert from "node:assert/strict";
import test from "node:test";
import { materializeCodeFileHierarchy } from "../src/application/code-map-hierarchy.js";
import { queryCodeGraph } from "../src/application/code-map-query.js";
import { normalizeScipGraph, parseScipJsonIndex, type ScipPhpLexicalScope } from "../src/adapters/code-intelligence/scip-normalizer.js";

const prefix = "scip-php composer example/app 1.0 ";
const parentClass = prefix + "src/Repository.php/Domain\\Repository#";
const parentSet = parentClass + "set().";
const facadeClass = prefix + "src/OrderDAO.php/Domain\\OrderDAO#";
const facadeSet = facadeClass + "set().";
const callerClass = prefix + "src/Caller.php/Domain\\Caller#";
const callerRun = callerClass + "run().";
const docLine = " * @method static void set(Order $order)";
const facadeLine = "class OrderDAO extends Repository {}";
const baseLine = "class Repository {";
const baseMethodLine = "  public static function set(Order $order): void {}";
const callerMethodLine = "  public static function run(): void {";
const callLine = "    OrderDAO::set($order);";
const callColumn = callLine.indexOf("set");

interface Options {
  annotation?: boolean;
  realImplementation?: boolean;
  publicImplementation?: boolean;
  staticImplementation?: boolean;
  fakePosition?: boolean;
}

function fixture(options: Options = {}) {
  const {
    annotation = true, realImplementation = true,
    publicImplementation = true, staticImplementation = true,
    fakePosition = false,
  } = options;
  const parentSource = ["<?php", baseLine, baseMethodLine, "}"].join("\n");
  const facadeSource = ["<?php", "/**", docLine, " */", facadeLine].join("\n");
  const callerSource = [
    "<?php", "class Caller {", callerMethodLine,
    ...Array(45).fill(callLine), "  }", "}",
  ].join("\n");
  const docStart = docLine.indexOf("set");
  const facadeDefinitionColumn = docStart + (fakePosition ? 1 : 0);
  const scopes = new Map<string, ScipPhpLexicalScope[]>([
    ["src/Repository.php", [
      { type: "class", className: "Domain\\Repository", range: [1, 0, 3, 1],
        nameRange: [1, 6, 1, 16], ancestors: [] },
      ...(realImplementation ? [{
        type: "method" as const, className: "Domain\\Repository",
        name: "set", range: [2, 0, 2, baseMethodLine.length] as const,
        nameRange: [2, baseMethodLine.indexOf("set"), 2, baseMethodLine.indexOf("set") + 3] as const,
        isStatic: staticImplementation, isConcretePublic: publicImplementation,
      }] : []),
    ]],
    ["src/OrderDAO.php", [
      { type: "class", className: "Domain\\OrderDAO", range: [4, 0, 4, facadeLine.length],
        nameRange: [4, 6, 4, 14],
        ancestors: [{ relation: "extends", className: "Domain\\Repository" }],
        docMethods: annotation
          ? [{ name: "set", nameRange: [2, docStart, 2, docStart + 3], isStatic: true }] : [] },
    ]],
    ["src/Caller.php", [
      { type: "class", className: "Domain\\Caller", range: [1, 0, 49, 1],
        nameRange: [1, 6, 1, 12], ancestors: [] },
      { type: "method", className: "Domain\\Caller", name: "run",
        range: [2, 0, 48, 3],
        nameRange: [2, callerMethodLine.indexOf("run"), 2, callerMethodLine.indexOf("run") + 3],
        isStatic: true, isConcretePublic: true },
    ]],
  ]);
  const range = (line: number, column: number, length: number) => [line, column, column + length];
  const index = parseScipJsonIndex({
    documents: [
      {
        relativePath: "src/Repository.php", language: "php",
        symbols: [
          { symbol: parentClass, kind: "Class", displayName: "Repository" },
          ...(realImplementation ? [{ symbol: parentSet, kind: "Method", displayName: "set" }] : []),
        ],
        occurrences: [
          { symbol: parentClass, symbolRoles: 1, range: range(1, 6, 10) },
          ...(realImplementation ? [{ symbol: parentSet, symbolRoles: 1,
            range: range(2, baseMethodLine.indexOf("set"), 3) }] : []),
        ],
      },
      {
        relativePath: "src/OrderDAO.php", language: "php",
        symbols: [
          { symbol: facadeClass, kind: "Class", displayName: "OrderDAO" },
          { symbol: facadeSet, kind: "Method", displayName: "set" },
        ],
        occurrences: [
          { symbol: facadeClass, symbolRoles: 1, range: range(4, 6, 8) },
          { symbol: facadeSet, symbolRoles: 1, range: range(2, facadeDefinitionColumn, 3) },
        ],
      },
      {
        relativePath: "src/Caller.php", language: "php",
        symbols: [
          { symbol: callerClass, kind: "Class", displayName: "Caller" },
          { symbol: callerRun, kind: "Method", displayName: "run" },
        ],
        occurrences: [
          { symbol: callerClass, symbolRoles: 1, range: range(1, 6, 6) },
          { symbol: callerRun, symbolRoles: 1,
            range: range(2, callerMethodLine.indexOf("run"), 3) },
          ...Array.from({ length: 45 }, (_, i) => ({
            symbol: facadeSet, symbolRoles: 0, range: range(i + 3, callColumn, 3),
          })),
        ],
      },
    ],
  });
  const graph = normalizeScipGraph({
    projectId: "php-doc-method", rootPath: "/tmp/php-doc-method",
    indexedAt: "2026-11-03T00:00:00Z", index,
    providerId: "scip-php", phpLexicalScopes: scopes,
    sourceTextByPath: new Map([
      ["src/Repository.php", parentSource],
      ["src/OrderDAO.php", facadeSource],
      ["src/Caller.php", callerSource],
    ]),
  });
  return materializeCodeFileHierarchy(graph, [
    { path: "src/Repository.php" }, { path: "src/OrderDAO.php" }, { path: "src/Caller.php" },
  ]);
}

function ids(graph: ReturnType<typeof fixture>) {
  const find = (part: string) => graph.nodes.find((node) =>
    node.canonicalIdentity.includes(part))?.id;
  const parent = find("Repository#set().");
  const virtual = find("OrderDAO#set().");
  const facade = find("OrderDAO#");
  const caller = find("Caller#run().");
  assert.ok(parent && virtual && facade && caller);
  return { parent, virtual, facade, caller };
}

test("PHPDoc @method belongs to class and 45 native facade calls target a verified real parent implementation", () => {
  const graph = fixture();
  const { parent, virtual, facade, caller } = ids(graph);
  assert.ok(graph.relations.some((rel) =>
    rel.kind === "contains" && rel.from === facade && rel.to === virtual));
  assert.ok(!graph.relations.some((rel) => rel.kind === "contains"
    && graph.nodes.find((node) => node.id === rel.from)?.kind === "file" && rel.to === virtual));
  const virtualNode = graph.nodes.find((node) => node.id === virtual);
  assert.match(virtualNode?.signature ?? "", /PHPDoc @method virtual declaration/);
  assert.ok(graph.relations.some((rel) =>
    rel.kind === "depends_on" && rel.from === virtual && rel.to === parent));
  const callers = graph.relations.filter((rel) => rel.kind === "calls" && rel.from === caller);
  assert.equal(callers.length, 1);
  assert.equal(callers[0]?.to, parent);
  assert.equal(callers[0]?.evidence?.length, 45);
  assert.ok(callers[0]?.evidence?.every((e) =>
    e.label?.includes("PHPDoc facade resolved to verified executable method")));
  assert.equal(graph.relations.filter((rel) => rel.kind === "calls" && rel.to === virtual).length, 0);
  const query = queryCodeGraph(graph, "scip-php", {
    operation: "relations", semantic: "callers", nodeId: parent,
  });
  assert.equal(query.operation, "relations");
  assert.equal(query.entries.filter((entry) => entry.relation.kind === "calls").length, 1);
});

test("PHPDoc facade is not redirected without a concrete public static parent implementation", () => {
  for (const options of [
    { realImplementation: false }, { publicImplementation: false },
    { staticImplementation: false },
  ]) {
    const graph = fixture(options);
    const virtual = graph.nodes.find((node) => node.canonicalIdentity.includes("OrderDAO#set()."))!;
    assert.equal(graph.relations.some((rel) =>
      rel.kind === "calls" && rel.to !== virtual.id), false, JSON.stringify(options));
    assert.equal(graph.relations.some((rel) =>
      rel.kind === "depends_on" && rel.from === virtual.id), false, JSON.stringify(options));
    assert.equal(graph.relations.filter((rel) => rel.kind === "calls" && rel.to === virtual.id)
      .flatMap((rel) => rel.evidence ?? []).length, 45);
  }
});

test("PHPDoc annotation or token mismatch never fabricates class ownership or redirects a call", () => {
  for (const options of [{ annotation: false }, { fakePosition: true }]) {
    const graph = fixture(options);
    const virtual = graph.nodes.find((node) => node.canonicalIdentity.includes("OrderDAO#set()."))!;
    const facade = graph.nodes.find((node) => node.canonicalIdentity.endsWith("OrderDAO#"))!;
    assert.ok(!graph.relations.some((rel) =>
      rel.kind === "contains" && rel.from === facade.id && rel.to === virtual.id));
    assert.equal(graph.relations.some((rel) => rel.kind === "calls"
      && rel.to !== virtual.id), false);
  }
});
