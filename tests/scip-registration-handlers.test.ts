import assert from "node:assert/strict";
import test from "node:test";
import { normalizeScipGraph, parseScipJsonIndex } from "../src/adapters/code-intelligence/scip-normalizer.js";
import { queryCodeGraph } from "../src/application/code-map-query.js";

const FILE = "src/server/tools.ts";
const ROOT = "/workspace/registration-fixture";
const TARGETS = {
  mapping: "scip-typescript npm external 1.0.0 util.ts/withErrorMapping().",
  status: "scip-typescript npm external 1.0.0 util.ts/logStatus().",
  worker: "scip-typescript npm external 1.0.0 util.ts/Worker#",
  nested: "scip-typescript npm external 1.0.0 util.ts/nestedTarget().",
  anonymous: "scip-typescript npm external 1.0.0 util.ts/anonymousTarget().",
};

function at(source: string, token: string, nth = 0): [number, number, number] {
  let offset = -1;
  for (let i = 0; i <= nth; i += 1) {
    offset = source.indexOf(token, offset + 1);
    assert.ok(offset >= 0, `Missing source token ${token} (${nth})`);
  }
  const preceding = source.slice(0, offset);
  const line = preceding.split("\n").length - 1;
  const column = offset - (preceding.lastIndexOf("\n") + 1);
  return [line, column, column + token.length];
}

function graphFor(
  source: string,
  refs: Array<{ symbol: string; token: string; nth?: number }>,
  definitions: Array<{ symbol: string; name: string; token: string; enclosingRange: number[] }> = [],
) {
  const symbols = definitions.map(({ symbol, name }) => ({
    symbol, displayName: name, kind: "Function",
  }));
  const occurrences = [
    ...definitions.map(({ symbol, token, enclosingRange }) => ({
      symbol, symbolRoles: 1, range: at(source, token), enclosingRange,
    })),
    ...refs.map(({ symbol, token, nth }) => ({
      symbol, symbolRoles: 0, range: at(source, token, nth),
    })),
  ];
  return normalizeScipGraph({
    projectId: "registration-fixture",
    rootPath: ROOT,
    indexedAt: "2026-10-07T00:00:00.000Z",
    index: parseScipJsonIndex({
      documents: [{ relativePath: FILE, language: "typescript", symbols, occurrences }],
      externalSymbols: Object.entries(TARGETS).map(([key, symbol]) => ({
        symbol,
        displayName: ({ mapping: "withErrorMapping", status: "logStatus", worker: "Worker",
          nested: "nestedTarget", anonymous: "anonymousTarget" } as Record<string, string>)[key],
        kind: key === "worker" ? "Class" : "Function",
      })),
    }),
    sourceTextByPath: new Map([[FILE, source]]),
  });
}

function registrationId(graph: ReturnType<typeof graphFor>, name: string) {
  const node = graph.nodes.find((candidate) =>
    candidate.canonicalIdentity.startsWith(`source-registration:${FILE}:registerTool:${name}:`));
  assert.ok(node, `Registration node for ${name} must exist`);
  return node.id;
}
function externalId(graph: ReturnType<typeof graphFor>, symbol: string) {
  const node = graph.nodes.find((candidate) => candidate.canonicalIdentity === `scip-external:${symbol}`);
  assert.ok(node, `External SCIP reference for ${symbol} must resolve`);
  return node.id;
}

test("two real registerTool callbacks get only their direct SCIP-resolved calls without cross-registration leakage", () => {
  const source = [
    "// registerTool('comment_fake', {}, async () => logStatus());",
    "const fakeString = `registerTool('string_fake', {}, async () => logStatus())`;",
    "registerTool(",
    '  "managed_mcp_update",',
    "  { title: \"Update\", meta: { nested: true } },",
    "  async (input, extra) => {",
    "    await withErrorMapping(input);",
    "    const referenceOnly = withErrorMapping;",
    "    function child() { nestedTarget(); }",
    "    const later = () => anonymousTarget();",
    "    new Worker();",
    "    missingUnresolved();",
    "    return input;",
    "  },",
    ");",
    "registerTool(",
    '  "operation_status",',
    "  { title: \"Status\" },",
    "  async input => logStatus(input),",
    ");",
  ].join("\n");
  const graph = graphFor(source, [
    { symbol: TARGETS.mapping, token: "withErrorMapping", nth: 0 },
    { symbol: TARGETS.mapping, token: "withErrorMapping", nth: 1 },
    { symbol: TARGETS.nested, token: "nestedTarget" },
    { symbol: TARGETS.anonymous, token: "anonymousTarget" },
    { symbol: TARGETS.worker, token: "Worker" },
    // Both the comment and template string mention logStatus; only occurrence in real handler is indexed.
    { symbol: TARGETS.status, token: "logStatus", nth: 2 },
  ]);
  const a = registrationId(graph, "managed_mcp_update");
  const b = registrationId(graph, "operation_status");
  const mapping = externalId(graph, TARGETS.mapping);
  const status = externalId(graph, TARGETS.status);
  const worker = externalId(graph, TARGETS.worker);
  const nested = externalId(graph, TARGETS.nested);
  const anonymous = externalId(graph, TARGETS.anonymous);
  assert.equal(graph.nodes.filter((node) => node.canonicalIdentity.startsWith("source-registration:")).length, 2);
  assert.ok(graph.relations.some((edge) => edge.from === a && edge.to === mapping && edge.kind === "calls"));
  assert.ok(graph.relations.some((edge) => edge.from === a && edge.to === worker && edge.kind === "instantiates"));
  assert.ok(graph.relations.some((edge) => edge.from === b && edge.to === status && edge.kind === "calls"));
  assert.ok(graph.relations.every((edge) => !(edge.from === a && (edge.to === nested || edge.to === anonymous || edge.to === status))));
  assert.ok(graph.relations.every((edge) => !(edge.from === b && (edge.to === mapping || edge.to === worker))));
  const edge = graph.relations.find((item) => item.from === a && item.to === mapping && item.kind === "calls");
  assert.equal(edge?.confidence, 1);
  assert.deepEqual(edge?.provenance, [{ providerId: "scip-typescript", fidelity: "semantic-call", freshness: "fresh" }]);
  assert.equal(edge?.evidence?.[0]?.location.startLine, 7);
  assert.equal(edge?.evidence?.[0]?.location.path, FILE);
  assert.equal(edge?.evidence?.[0]?.location.startColumn, at(source, "withErrorMapping")[1] + 1);
});

test("a true AST callback owner takes precedence over the enclosing ordinary SCIP function", () => {
  const source = [
    "function install() {",
    '  registerTool("managed_mcp_update", {}, async () => withErrorMapping());',
    "  logStatus();",
    "}",
  ].join("\n");
  const OWNER = "scip-typescript npm app 1.0.0 tools.ts/install().";
  const graph = graphFor(source, [
    { symbol: TARGETS.mapping, token: "withErrorMapping" },
    { symbol: TARGETS.status, token: "logStatus" },
  ], [{ symbol: OWNER, name: "install", token: "install", enclosingRange: [0, 0, 3, 1] }]);
  const handler = registrationId(graph, "managed_mcp_update");
  const install = graph.nodes.find((node) => node.canonicalIdentity === `scip:${OWNER}`);
  const mapping = externalId(graph, TARGETS.mapping);
  const status = externalId(graph, TARGETS.status);
  assert.ok(install);
  assert.ok(graph.relations.some((edge) => edge.from === handler && edge.to === mapping && edge.kind === "calls"));
  assert.equal(graph.relations.some((edge) => edge.from === install.id && edge.to === mapping), false);
  assert.ok(graph.relations.some((edge) => edge.from === install.id && edge.to === status && edge.kind === "calls"));
});

test("unknown and non-call SCIP references, computed registration names, and fake syntax create no call edges", () => {
  const source = [
    "const other = withErrorMapping;",
    'registerTool("operation_status", {}, async () => {',
    "  const later = withErrorMapping;",
    "  // withErrorMapping();",
    "  const ignored = 'withErrorMapping()';",
    "  unresolved();",
    "});",
    'registerTool(prefix + "_computed", {}, async () => withErrorMapping());',
  ].join("\n");
  const graph = graphFor(source, [
    { symbol: TARGETS.mapping, token: "withErrorMapping", nth: 0 },
    { symbol: TARGETS.mapping, token: "withErrorMapping", nth: 1 },
  ]);
  const handler = registrationId(graph, "operation_status");
  assert.equal(graph.nodes.filter((node) => node.canonicalIdentity.startsWith("source-registration:")).length, 1);
  assert.equal(graph.relations.some((edge) => edge.from === handler && (edge.kind === "calls" || edge.kind === "instantiates")), false);
});

test("a callback in a class or nested function is not assigned to its outer registration handler", () => {
  const source = [
    'registerTool("operation_status", {}, async () => {',
    "  class WorkerWrapper { run() { nestedTarget(); } }",
    "  const object = { method() { anonymousTarget(); } };",
    "  function nested() { logStatus(); }",
    "  return withErrorMapping();",
    "});",
  ].join("\n");
  const graph = graphFor(source, [
    { symbol: TARGETS.nested, token: "nestedTarget" },
    { symbol: TARGETS.anonymous, token: "anonymousTarget" },
    { symbol: TARGETS.status, token: "logStatus" },
    { symbol: TARGETS.mapping, token: "withErrorMapping" },
  ]);
  const id = registrationId(graph, "operation_status");
  const out = graph.relations.filter((edge) => edge.from === id && edge.kind === "calls");
  assert.equal(out.length, 1);
  assert.equal(out[0]?.to, externalId(graph, TARGETS.mapping));
});

test("ten SCIP-resolved nested callback calls retain their true lexical owner and zero synthetic parent calls", () => {
  const names = [
    "planStep", "checkStep", "startStep", "readStep", "saveStep",
    "finishStep", "reportStep", "auditStep", "notifyStep", "releaseStep",
  ];
  const symbol = (name: string) => `scip-typescript npm external 1.0.0 util.ts/${name}().`;
  const source = [
    'registerTool("command_run", {}, async () => {',
    "  return withErrorMapping(ctx, async () => {",
    ...names.map((name) => `    ${name}();`),
    "    const deferred = () => anonymousTarget();",
    "    return withErrorMapping(ctx, async () => nestedTarget());",
    "  });",
    "});",
    'registerTool("operation_status", {}, async () => logStatus());',
  ].join("\n");
  const graph = graphFor(source, [
    { symbol: TARGETS.mapping, token: "withErrorMapping", nth: 0 },
    { symbol: TARGETS.mapping, token: "withErrorMapping", nth: 1 },
    ...names.map((name) => ({ symbol: symbol(name), token: name })),
    { symbol: TARGETS.nested, token: "nestedTarget" },
    { symbol: TARGETS.anonymous, token: "anonymousTarget" },
    { symbol: TARGETS.status, token: "logStatus" },
  ]);
  const handler = registrationId(graph, "command_run");
  const other = registrationId(graph, "operation_status");
  const childrenOf = (id: string) => graph.relations.filter((edge) => edge.from === id && edge.kind === "contains");
  const first = childrenOf(handler);
  assert.equal(first.length, 1, "only the inline argument callback is a direct lexical child");
  const inner = first[0]!.to;
  const second = childrenOf(inner);
  assert.equal(second.length, 1, "a second-level argument callback has its own lexical owner");
  const deeper = second[0]!.to;
  const hierarchy = queryCodeGraph(graph, "scip-typescript", {
    operation: "hierarchy", nodeId: handler, direction: "children", limit: 10,
  });
  assert.equal(hierarchy.operation, "hierarchy");
  assert.deepEqual(hierarchy.entries.map((entry) => entry.node.id), [inner]);
  const nestedHierarchy = queryCodeGraph(graph, "scip-typescript", {
    operation: "hierarchy", nodeId: inner, direction: "children", limit: 10,
  });
  assert.equal(nestedHierarchy.operation, "hierarchy");
  assert.ok(nestedHierarchy.entries.some((entry) => entry.node.id === deeper));
  const queriedCallees = queryCodeGraph(graph, "scip-typescript", {
    operation: "relations", nodeId: inner, semantic: "callees", limit: 30,
  });
  assert.equal(queriedCallees.operation, "relations");
  assert.ok(queriedCallees.entries.some((entry) => entry.node.id === externalId(graph, symbol("planStep"))));
  assert.ok(queriedCallees.entries.some((entry) => entry.node.id === externalId(graph, symbol("releaseStep"))));
  const rootCallees = queryCodeGraph(graph, "scip-typescript", {
    operation: "relations", nodeId: handler, semantic: "callees", limit: 30,
  });
  assert.equal(rootCallees.operation, "relations");
  assert.ok(rootCallees.entries.every((entry) => !names.some((name) => entry.node.id === externalId(graph, symbol(name)))));
  assert.ok(graph.nodes.some((node) => node.id === inner
    && node.canonicalIdentity.startsWith("source-registration-callback:")
    && node.canonicalIdentity.includes(":local ")
    && node.provenance?.[0]?.fidelity === "syntax"));

  const nestedCalls = graph.relations.filter((edge) => edge.from === inner && edge.kind === "calls");
  for (const name of names) {
    const target = externalId(graph, symbol(name));
    const edge = nestedCalls.find((item) => item.to === target);
    assert.ok(edge, `SCIP-resolved ${name} should belong to the inline callback`);
    assert.equal(edge.confidence, 1);
    assert.equal(edge.evidence?.[0]?.location.path, FILE);
    assert.deepEqual(edge.provenance, [
      { providerId: "scip-typescript", fidelity: "semantic-call", freshness: "fresh" },
    ]);
    assert.equal(graph.relations.some((item) => item.from === handler && item.to === target), false,
      `handler must not claim ${name} as a direct call`);
    assert.equal(graph.relations.some((item) => item.from === other && item.to === target), false,
      `unrelated handler must not inherit ${name}`);
  }
  assert.ok(graph.relations.some((edge) => edge.from === deeper
    && edge.to === externalId(graph, TARGETS.nested) && edge.kind === "calls"));
  assert.equal(graph.relations.some((edge) => edge.from === inner
    && edge.to === externalId(graph, TARGETS.nested) && edge.kind === "calls"), false);
  assert.equal(graph.relations.some((edge) => edge.to === externalId(graph, TARGETS.anonymous)
    && edge.kind === "calls"), false, "assigned but uninvoked callbacks are not represented as direct calls");
  assert.ok(graph.relations.some((edge) => edge.from === other
    && edge.to === externalId(graph, TARGETS.status) && edge.kind === "calls"));
  assert.equal(graph.nodes.filter((node) => node.canonicalIdentity.startsWith("source-registration:")).length, 2);
  assert.equal(graph.nodes.filter((node) => node.canonicalIdentity.startsWith("source-registration-callback:")).length, 2);
});
