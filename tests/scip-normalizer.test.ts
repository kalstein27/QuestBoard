import assert from "node:assert/strict";
import test from "node:test";
import { projectCodeArchitecture } from "../src/application/code-map-projection.js";
import { queryCodeGraph } from "../src/application/code-map-query.js";
import { normalizeScipGraph, parseScipJsonIndex } from "../src/adapters/code-intelligence/scip-normalizer.js";

const HTTP = "scip-typescript npm questboard 0.0.0 src/server/http-api.ts/handleRequest().";
const AGENT = "scip-typescript npm questboard 0.0.0 src/adapters/agent-tools.ts/executeQuestBoardAgentTool().";
const SERVICE = "scip-typescript npm questboard 0.0.0 src/application/quest-board-service.ts/QuestBoardService#createTask().";
const CONTRACT = "scip-typescript npm questboard 0.0.0 src/application/quest-board-repository.ts/QuestBoardRepository#";
const SQLITE = "scip-typescript npm questboard 0.0.0 src/storage/sqlite/sqlite-quest-board-repository.ts/SqliteQuestBoardRepository#";

function fixture(): unknown {
  return {
    documents: [
      {
        relativePath: "src/server/http-api.ts",
        language: "typescript",
        symbols: [{ symbol: HTTP, displayName: "handleRequest", kind: "Function" }],
        occurrences: [
          { symbol: HTTP, symbolRoles: 1, range: [4, 9, 22], enclosingRange: [4, 0, 40, 1] },
          { symbol: SERVICE, symbolRoles: 0, range: [20, 12, 22] },
        ],
      },
      {
        relative_path: "src/adapters/agent-tools.ts",
        language: "typescript",
        symbols: [{ symbol: AGENT, display_name: "executeQuestBoardAgentTool", kind: 17 }],
        occurrences: [
          { symbol: AGENT, symbol_roles: 1, range: [10, 16, 44], enclosing_range: [10, 0, 45, 1] },
          { symbol: SERVICE, symbol_roles: 0, range: [30, 8, 18] },
        ],
      },
      {
        relativePath: "src/application/quest-board-service.ts",
        language: "typescript",
        symbols: [{
          symbol: SERVICE,
          displayName: "createTask",
          kind: "Method",
          signatureDocumentation: { language: "typescript", text: "createTask(input: CreateTaskInput): Task" },
        }],
        occurrences: [
          { symbol: SERVICE, symbolRoles: 1, range: [200, 2, 12], enclosingRange: [195, 0, 240, 1] },
          { symbol: CONTRACT, symbolRoles: 0, range: [210, 14, 34] },
        ],
      },
      {
        relativePath: "src/application/quest-board-repository.ts",
        language: "typescript",
        symbols: [{ symbol: CONTRACT, displayName: "QuestBoardRepository", kind: "Interface" }],
        occurrences: [{ symbol: CONTRACT, symbolRoles: 1, range: [20, 17, 37], enclosingRange: [20, 0, 80, 1] }],
      },
      {
        relativePath: "src/storage/sqlite/sqlite-quest-board-repository.ts",
        language: "typescript",
        symbols: [{
          symbol: SQLITE,
          displayName: "SqliteQuestBoardRepository",
          kind: "Class",
          relationships: [{ symbol: CONTRACT, isImplementation: true }],
        }],
        occurrences: [{ symbol: SQLITE, symbolRoles: 1, range: [40, 13, 39], enclosingRange: [40, 0, 500, 1] }],
      },
    ],
    externalSymbols: [],
  };
}

test("normalizes SCIP definitions, references, and implementation relationships without inventing calls", () => {
  const graph = normalizeScipGraph({
    projectId: "questboard",
    rootPath: "/workspace/questboard",
    indexedAt: "2026-09-23T00:00:00.000Z",
    index: parseScipJsonIndex(fixture()),
  });

  assert.equal(graph.nodes.length, 5);
  assert.deepEqual(
    graph.nodes.map((node) => node.name).sort(),
    ["QuestBoardRepository", "SqliteQuestBoardRepository", "createTask", "executeQuestBoardAgentTool", "handleRequest"].sort(),
  );
  assert.equal(graph.relations.some((relation) => relation.kind === "calls"), false);
  assert.ok(graph.relations.some((relation) => relation.kind === "implements"));
  assert.ok(graph.relations.some((relation) => relation.kind === "depends_on" || relation.kind === "reads"));
  const typescriptCoverage = graph.coverage?.languages.find((entry) => entry.language === "typescript");
  assert.equal(typescriptCoverage?.semanticEligibleFileCount, 5);
  assert.equal(typescriptCoverage?.semanticIndexedFileCount, 5);
  assert.equal(JSON.stringify(graph).includes("scip-typescript npm"), true, "canonical SCIP identity is retained, not a backend row id");
});

test("SCIP coverage infers document language from path when the index omits it", () => {
  const graph = normalizeScipGraph({
    projectId: "questboard",
    rootPath: "/workspace/questboard",
    indexedAt: "2026-09-23T00:00:00.000Z",
    index: parseScipJsonIndex({
      documents: [{ relativePath: "src/empty.ts", symbols: [], occurrences: [] }],
      externalSymbols: [],
    }),
  });

  const typescriptCoverage = graph.coverage?.languages.find((entry) => entry.language === "typescript");
  assert.equal(typescriptCoverage?.semanticEligibleFileCount, 1);
  assert.equal(typescriptCoverage?.semanticIndexedFileCount, 1);
  assert.equal(graph.coverage?.languages.some((entry) => entry.language === "unknown"), false);
});

test("SCIP source supplement promotes only syntactic call occurrences to calls", () => {
  const caller = "scip-typescript npm questboard 0.0.0 src/server/http-api.ts/handleRequest().";
  const callee = "scip-typescript npm questboard 0.0.0 src/application/quest-board-service.ts/QuestBoardService#createTask().";
  const property = "scip-typescript npm questboard 0.0.0 src/application/quest-board-service.ts/QuestBoardService#repository.";
  const index = parseScipJsonIndex({
    documents: [
      {
        relativePath: "src/server/http-api.ts",
        language: "typescript",
        symbols: [{ symbol: caller, displayName: "handleRequest", kind: "Function" }],
        occurrences: [
          { symbol: caller, symbolRoles: 1, range: [0, 9, 22], enclosingRange: [0, 0, 3, 1] },
          { symbol: callee, symbolRoles: 0, range: [1, 10, 20] },
          { symbol: property, symbolRoles: 0, range: [2, 10, 20] },
        ],
      },
      {
        relativePath: "src/application/quest-board-service.ts",
        language: "typescript",
        symbols: [
          { symbol: callee, displayName: "createTask", kind: "Method" },
          { symbol: property, displayName: "repository", kind: "Property" },
        ],
        occurrences: [
          { symbol: callee, symbolRoles: 1, range: [0, 2, 12], enclosingRange: [0, 0, 1, 1] },
          { symbol: property, symbolRoles: 1, range: [2, 2, 12] },
        ],
      },
    ],
  });
  const graph = normalizeScipGraph({
    projectId: "questboard",
    rootPath: "/workspace/questboard",
    indexedAt: "2026-09-23T00:00:00.000Z",
    index,
    sourceTextByPath: new Map([
      ["src/server/http-api.ts", "function handleRequest() {\n  service.createTask();\n  service.repository;\n}\n"],
    ]),
  });
  const byIdentity = new Map(graph.nodes.map((node) => [node.canonicalIdentity, node]));
  const callerId = byIdentity.get(`scip:${caller}`)?.id;
  const calleeId = byIdentity.get(`scip:${callee}`)?.id;
  const propertyId = byIdentity.get(`scip:${property}`)?.id;

  assert.ok(callerId && calleeId && propertyId);
  assert.ok(graph.relations.some((relation) => relation.from === callerId && relation.to === calleeId && relation.kind === "calls"));
  assert.equal(graph.relations.some((relation) => relation.from === callerId && relation.to === propertyId && relation.kind === "calls"), false);
  assert.ok(graph.relations.some((relation) => relation.from === callerId && relation.to === propertyId && relation.kind === "depends_on"));
});

test("SCIP materializes referenced external symbols and promotes only new-expression occurrences to instantiates", () => {
  const owner = "scip-typescript npm questboard 0.0.0 src/storage/sqlite.ts/SqliteRepository#constructor().";
  const databaseSync = "scip-typescript npm @types/node 0.0.0 node:sqlite/DatabaseSync#";
  const index = parseScipJsonIndex({
    externalSymbols: [{ symbol: databaseSync, displayName: "DatabaseSync", kind: "Class" }],
    documents: [{
      relativePath: "src/storage/sqlite.ts",
      language: "typescript",
      symbols: [{ symbol: owner, displayName: "constructor", kind: "Constructor" }],
      occurrences: [
        { symbol: owner, symbolRoles: 1, range: [1, 2, 13], enclosingRange: [1, 0, 5, 1] },
        { symbol: databaseSync, symbolRoles: 2, range: [0, 9, 21] },
        { symbol: databaseSync, symbolRoles: 0, range: [2, 12, 24] },
        { symbol: databaseSync, symbolRoles: 0, range: [3, 8, 20] },
        { symbol: databaseSync, symbolRoles: 0, range: [4, 2, 14] },
      ],
    }],
  });
  const graph = normalizeScipGraph({
    projectId: "questboard",
    rootPath: "/workspace/questboard",
    indexedAt: "2026-10-02T00:00:00.000Z",
    index,
    sourceTextByPath: new Map([["src/storage/sqlite.ts", [
      'import { DatabaseSync } from "node:sqlite";',
      "constructor() {",
      "  const db: DatabaseSync =",
      "    new DatabaseSync(path);",
      "  DatabaseSync;",
      "}",
    ].join("\n")]]),
  });
  const external = graph.nodes.find((node) => node.canonicalIdentity === `scip-external:${databaseSync}`);
  const ownerNode = graph.nodes.find((node) => node.canonicalIdentity === `scip:${owner}`);
  assert.ok(external && ownerNode);
  assert.equal(external.name, "DatabaseSync");
  assert.equal(external.location, undefined);
  assert.deepEqual(external.provenance, [{ providerId: "scip-typescript", fidelity: "semantic-reference", freshness: "fresh" }]);
  const ownerToExternal = graph.relations.filter((relation) => relation.from === ownerNode.id && relation.to === external.id);
  assert.equal(ownerToExternal.filter((relation) => relation.kind === "instantiates").length, 1);
  assert.equal(ownerToExternal.filter((relation) => relation.kind === "calls").length, 0);
});

test("SCIP projects only macro nodes and relations backed by raw evidence", () => {
  const graph = normalizeScipGraph({
    projectId: "questboard",
    rootPath: "/workspace/questboard",
    indexedAt: "2026-09-23T00:00:00.000Z",
    index: parseScipJsonIndex(fixture()),
  });
  const projection = projectCodeArchitecture(graph);

  assert.deepEqual(
    projection.nodes.map((node) => node.kind),
    ["http_api", "agent_mcp", "application_service", "repository_contract", "sqlite_repository"],
  );
  assert.ok(projection.relations.some((relation) => relation.kind === "implemented_by"));
  assert.ok(projection.relations.some((relation) => relation.kind === "depends_on_contract"));
  assert.equal(projection.relations.some((relation) => relation.kind === "persists_to"), false);
  assert.equal(projection.relations.some((relation) => relation.kind === "invokes"), false);
  assert.equal(projection.relations.every((relation) => relation.sourceRelationIds.length > 0), true);
});

test("SCIP parser accepts typed camelCase ranges and snake_case fields", () => {
  const parsed = parseScipJsonIndex({
    documents: [{
      relative_path: "src/a.ts",
      occurrences: [{
        symbol: "local symbol",
        symbol_roles: 1,
        singleLineRange: { startLine: 2, startCharacter: 3, endCharacter: 7 },
        multi_line_enclosing_range: { start_line: 1, start_character: 0, end_line: 4, end_character: 1 },
      }],
      symbols: [],
    }],
  });

  assert.equal(parsed.documents[0]?.relativePath, "src/a.ts");
  assert.deepEqual(parsed.documents[0]?.occurrences[0]?.range, {
    startLine: 2,
    startCharacter: 3,
    endLine: 2,
    endCharacter: 7,
  });
});

test("SCIP keeps document-local symbols isolated across files", () => {
  const A_OWNER = "scip-typescript npm questboard 0.0.0 src/a.ts/aOwner().";
  const B_OWNER = "scip-typescript npm questboard 0.0.0 src/b.ts/bOwner().";
  const graph = normalizeScipGraph({
    projectId: "questboard",
    rootPath: "/workspace/questboard",
    indexedAt: "2026-09-30T00:00:00.000Z",
    index: parseScipJsonIndex({
      documents: [
        {
          relativePath: "src/a.ts",
          language: "typescript",
          symbols: [
            { symbol: A_OWNER, displayName: "aOwner", kind: "Function" },
            { symbol: "local 0", displayName: "aLocal", kind: "Function" },
          ],
          occurrences: [
            { symbol: A_OWNER, symbolRoles: 1, range: [0, 9, 15], enclosingRange: [0, 0, 3, 1] },
            { symbol: "local 0", symbolRoles: 1, range: [1, 11, 17] },
            { symbol: "local 0", symbolRoles: 0, range: [2, 2, 8] },
          ],
        },
        {
          relativePath: "src/b.ts",
          language: "typescript",
          symbols: [
            { symbol: B_OWNER, displayName: "bOwner", kind: "Function" },
            { symbol: "local 0", displayName: "bLocal", kind: "Function" },
          ],
          occurrences: [
            { symbol: B_OWNER, symbolRoles: 1, range: [0, 9, 15], enclosingRange: [0, 0, 3, 1] },
            { symbol: "local 0", symbolRoles: 1, range: [1, 11, 17] },
            { symbol: "local 0", symbolRoles: 0, range: [2, 2, 8] },
          ],
        },
      ],
    }),
    sourceTextByPath: new Map([
      ["src/a.ts", "function aOwner() {\n  function aLocal() {}\n  aLocal();\n}\n"],
      ["src/b.ts", "function bOwner() {\n  function bLocal() {}\n  bLocal();\n}\n"],
    ]),
  });

  const aLocal = graph.nodes.find((node) => node.canonicalIdentity === "scip:src/a.ts:local 0")!;
  const bLocal = graph.nodes.find((node) => node.canonicalIdentity === "scip:src/b.ts:local 0")!;
  const aOwner = graph.nodes.find((node) => node.canonicalIdentity === `scip:${A_OWNER}`)!;
  const bOwner = graph.nodes.find((node) => node.canonicalIdentity === `scip:${B_OWNER}`)!;

  assert.equal(graph.nodes.length, 4);
  assert.notEqual(aLocal.id, bLocal.id);
  assert.ok(graph.relations.some((relation) => relation.from === aOwner.id && relation.to === aLocal.id && relation.kind === "calls"));
  assert.ok(graph.relations.some((relation) => relation.from === bOwner.id && relation.to === bLocal.id && relation.kind === "calls"));
  assert.equal(graph.relations.some((relation) => relation.from === aOwner.id && relation.to === bLocal.id), false);
  assert.equal(graph.relations.some((relation) => relation.from === bOwner.id && relation.to === aLocal.id), false);
});

test("SCIP infers stable kinds and names from scip print documentation when kind/displayName are omitted", () => {
  const MODULE = "scip-typescript npm questboard 0.0.0 src/`sample.ts`/";
  const SERVICE = `${MODULE}Service#`;
  const PROPERTY = `${MODULE}Service#value.`;
  const METHOD = `${MODULE}Service#run().`;
  const PARAMETER = `${MODULE}Service#run().(input)`;
  const TYPE_PARAMETER = `${MODULE}Service#run().[T]`;
  const CONSTRUCTOR = `${MODULE}Service#\`<constructor>\`().`;

  const parsed = parseScipJsonIndex({
    documents: [{
      relativePath: "src/sample.ts",
      language: "typescript",
      symbols: [
        { symbol: MODULE, documentation: ["```ts\nmodule \"sample.ts\"\n```"] },
        { symbol: SERVICE, documentation: ["```ts\nclass Service\n```"] },
        { symbol: PROPERTY, documentation: ["```ts\n(property) value: string\n```"] },
        { symbol: METHOD, documentation: ["```ts\n(method) run(input: T): void\n```"] },
        { symbol: PARAMETER, documentation: ["```ts\n(parameter) input: T\n```"] },
        { symbol: TYPE_PARAMETER, documentation: ["```ts\nT: T\n```"] },
        { symbol: CONSTRUCTOR, documentation: ["```ts\nconstructor(): Service\n```"] },
      ],
      occurrences: [
        { symbol: MODULE, symbolRoles: 1, range: [0, 0, 6] },
        { symbol: SERVICE, symbolRoles: 1, range: [1, 6, 13] },
        { symbol: PROPERTY, symbolRoles: 1, range: [2, 2, 7] },
        { symbol: METHOD, symbolRoles: 1, range: [3, 2, 5] },
        { symbol: PARAMETER, symbolRoles: 1, range: [3, 6, 11] },
        { symbol: TYPE_PARAMETER, symbolRoles: 1, range: [3, 12, 13] },
        { symbol: CONSTRUCTOR, symbolRoles: 1, range: [4, 2, 13] },
      ],
    }],
  });

  const graph = normalizeScipGraph({
    projectId: "questboard",
    rootPath: "/workspace/questboard",
    indexedAt: "2026-09-23T00:00:00.000Z",
    index: parsed,
  });
  const byIdentity = new Map(graph.nodes.map((node) => [node.canonicalIdentity, node]));

  assert.deepEqual(
    [MODULE, SERVICE, PROPERTY, METHOD, PARAMETER, TYPE_PARAMETER, CONSTRUCTOR].map((symbol) => byIdentity.get(`scip:${symbol}`)?.kind),
    ["module", "class", "property", "method", "variable", "type", "constructor"],
  );
  assert.deepEqual(
    [MODULE, SERVICE, PROPERTY, METHOD, PARAMETER, TYPE_PARAMETER, CONSTRUCTOR].map((symbol) => byIdentity.get(`scip:${symbol}`)?.name),
    ["sample.ts", "Service", "value", "run", "input", "T", "constructor"],
  );
});

test("SCIP preserves enclosingSymbol as symbol containment", () => {
  const SERVICE = "scip-typescript npm questboard 0.0.0 src/sample.ts/Service#";
  const METHOD = `${SERVICE}run().`;
  const graph = normalizeScipGraph({
    projectId: "questboard",
    rootPath: "/workspace/questboard",
    indexedAt: "2026-09-23T00:00:00.000Z",
    index: parseScipJsonIndex({
      documents: [{
        relativePath: "src/sample.ts",
        language: "typescript",
        symbols: [
          { symbol: SERVICE, displayName: "Service", kind: "Class" },
          { symbol: METHOD, displayName: "run", kind: "Method", enclosingSymbol: SERVICE },
        ],
        occurrences: [
          { symbol: SERVICE, symbolRoles: 1, range: [0, 6, 13], enclosingRange: [0, 0, 4, 1] },
          { symbol: METHOD, symbolRoles: 1, range: [1, 2, 5], enclosingRange: [1, 2, 3, 3] },
        ],
      }],
    }),
  });
  const byIdentity = new Map(graph.nodes.map((node) => [node.canonicalIdentity, node]));
  const service = byIdentity.get(`scip:${SERVICE}`)!;
  const method = byIdentity.get(`scip:${METHOD}`)!;

  assert.ok(graph.relations.some((relation) =>
    relation.kind === "contains" && relation.from === service.id && relation.to === method.id,
  ));
});

test("SCIP adds bounded registerTool source-registration fallback nodes behind semantic symbols", () => {
  const PROPERTY = "scip-typescript npm chatgpt2codex 0.2.0 src/server/capability-preflight.ts/managed_mcp_update.";
  const graph = normalizeScipGraph({
    projectId: "chatgpt2codex",
    rootPath: "/workspace/chatgpt2codex",
    indexedAt: "2026-10-07T00:00:00.000Z",
    index: parseScipJsonIndex({
      documents: [
        {
          relativePath: "src/server/tools.ts",
          language: "typescript",
          symbols: [],
          occurrences: [],
        },
        {
          relativePath: "src/server/capability-preflight.ts",
          language: "typescript",
          symbols: [{ symbol: PROPERTY, displayName: "managed_mcp_update", kind: "Property" }],
          occurrences: [{ symbol: PROPERTY, symbolRoles: 1, range: [10, 2, 20] }],
        },
      ],
    }),
    sourceTextByPath: new Map([
      ["src/server/tools.ts", [
        "registerTool(",
        "  \"managed_mcp_update\",",
        "  { title: \"Update managed MCP server\" },",
        "  async () => undefined,",
        ");",
        "const unrelated = \"managed_mcp_update\";",
      ].join("\n")],
    ]),
  });

  const fallback = graph.nodes.find((node) =>
    node.canonicalIdentity.startsWith("source-registration:src/server/tools.ts:registerTool:managed_mcp_update:"));
  assert.ok(fallback);
  assert.equal(fallback.kind, "function");
  assert.equal(fallback.location?.startLine, 2);
  assert.deepEqual(fallback.provenance, [{
    providerId: "scip-typescript",
    fidelity: "syntax",
    freshness: "fresh",
  }]);
  assert.equal(
    graph.nodes.filter((node) => node.name === "managed_mcp_update").length,
    2,
    "only the semantic property and the bounded registerTool fallback should be materialized",
  );

  const found = queryCodeGraph(graph, "scip-typescript", {
    operation: "find_nodes",
    query: "managed_mcp_update",
    limit: 10,
  });
  assert.equal(found.operation, "find_nodes");
  assert.equal(found.nodes[0]?.id, fallback.id);
  assert.equal(found.nodes[1]?.kind, "property");
});

test("SCIP does not add a registerTool fallback when a named semantic implementation already exists", () => {
  const HANDLER = "scip-typescript npm app 1.0.0 src/tools.ts/operation_status().";
  const graph = normalizeScipGraph({
    projectId: "app",
    rootPath: "/workspace/app",
    indexedAt: "2026-10-07T00:00:00.000Z",
    index: parseScipJsonIndex({
      documents: [{
        relativePath: "src/tools.ts",
        language: "typescript",
        symbols: [{ symbol: HANDLER, displayName: "operation_status", kind: "Function" }],
        occurrences: [{ symbol: HANDLER, symbolRoles: 1, range: [0, 9, 25] }],
      }],
    }),
    sourceTextByPath: new Map([[
      "src/tools.ts",
      'function operation_status() {}\nregisterTool("operation_status", {}, operation_status);\n',
    ]]),
  });

  assert.equal(graph.nodes.filter((node) => node.name === "operation_status").length, 1);
  assert.equal(
    graph.nodes.some((node) => node.canonicalIdentity.startsWith("source-registration:")),
    false,
  );
});

test("SCIP source-registration fallback surfaces anonymous operation_status registration as an implementation candidate", () => {
  const METADATA = "scip-typescript npm app 1.0.0 src/runtime/activity.ts/operation_status.";
  const graph = normalizeScipGraph({
    projectId: "app",
    rootPath: "/workspace/app",
    indexedAt: "2026-10-07T00:00:00.000Z",
    index: parseScipJsonIndex({
      documents: [
        {
          relativePath: "src/server/tools.ts",
          language: "typescript",
          symbols: [],
          occurrences: [],
        },
        {
          relativePath: "src/runtime/activity.ts",
          language: "typescript",
          symbols: [{ symbol: METADATA, displayName: "operation_status", kind: "Property" }],
          occurrences: [{ symbol: METADATA, symbolRoles: 1, range: [3, 2, 18] }],
        },
      ],
    }),
    sourceTextByPath: new Map([[
      "src/server/tools.ts",
      [
        "registerTool(",
        '  "operation_status",',
        "  { title: 'Check background operation' },",
        "  async (input) => ({ state: input.operationId }),",
        ");",
      ].join("\n"),
    ]]),
  });

  const result = queryCodeGraph(graph, "scip-typescript", {
    operation: "find_nodes",
    query: "operation_status",
    limit: 10,
  });
  assert.equal(result.operation, "find_nodes");
  assert.equal(result.nodes[0]?.kind, "function");
  assert.equal(result.nodes[0]?.location?.path, "src/server/tools.ts");
  assert.match(result.nodes[0]?.canonicalIdentity ?? "", /^source-registration:.*:registerTool:operation_status:/);
  assert.equal(result.nodes[1]?.kind, "property");
});

test("SCIP source-registration fallback is bounded per document", () => {
  const registrations = Array.from(
    { length: 105 },
    (_, index) => `registerTool("tool_${index}", {}, async () => undefined);`,
  ).join("\n");
  const graph = normalizeScipGraph({
    projectId: "app",
    rootPath: "/workspace/app",
    indexedAt: "2026-10-07T00:00:00.000Z",
    index: parseScipJsonIndex({
      documents: [{
        relativePath: "src/tools.ts",
        language: "typescript",
        symbols: [],
        occurrences: [],
      }],
    }),
    sourceTextByPath: new Map([["src/tools.ts", registrations]]),
  });

  const registrationsOnly = graph.nodes.filter((node) =>
    node.canonicalIdentity.startsWith("source-registration:src/tools.ts:registerTool:"));
  assert.equal(registrationsOnly.length, 100);
  assert.equal(graph.coverage?.providers[0]?.nodeCount, 100);
});

test("SCIP falls back to narrow enclosing definition ranges when explicit symbol ownership is absent", () => {
  const OUTER = "scip-typescript npm questboard 0.0.0 src/sample.ts/outer().";
  const INNER = "scip-typescript npm questboard 0.0.0 src/sample.ts/outer().inner().";
  const graph = normalizeScipGraph({
    projectId: "questboard",
    rootPath: "/workspace/questboard",
    indexedAt: "2026-09-23T00:00:00.000Z",
    index: parseScipJsonIndex({
      documents: [{
        relativePath: "src/sample.ts",
        language: "typescript",
        symbols: [
          { symbol: OUTER, displayName: "outer", kind: "Function" },
          { symbol: INNER, displayName: "inner", kind: "Function" },
        ],
        occurrences: [
          { symbol: OUTER, symbolRoles: 1, range: [0, 9, 14], enclosingRange: [0, 0, 5, 1] },
          { symbol: INNER, symbolRoles: 1, range: [1, 11, 16], enclosingRange: [1, 2, 3, 3] },
        ],
      }],
    }),
  });
  const byIdentity = new Map(graph.nodes.map((node) => [node.canonicalIdentity, node]));

  assert.ok(graph.relations.some((relation) =>
    relation.kind === "contains"
      && relation.from === byIdentity.get(`scip:${OUTER}`)?.id
      && relation.to === byIdentity.get(`scip:${INNER}`)?.id,
  ));
});
