import assert from "node:assert/strict";
import test from "node:test";
import { projectCodeArchitecture } from "../src/application/code-map-projection.js";
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
  assert.equal(JSON.stringify(graph).includes("scip-typescript npm"), true, "canonical SCIP identity is retained, not a backend row id");
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

test("SCIP reproduces all six macro nodes while conservatively exposing lower invoke-edge coverage", () => {
  const graph = normalizeScipGraph({
    projectId: "questboard",
    rootPath: "/workspace/questboard",
    indexedAt: "2026-09-23T00:00:00.000Z",
    index: parseScipJsonIndex(fixture()),
  });
  const projection = projectCodeArchitecture(graph);

  assert.deepEqual(
    projection.nodes.map((node) => node.kind),
    ["http_api", "agent_mcp", "application_service", "repository_contract", "sqlite_repository", "sqlite"],
  );
  assert.ok(projection.relations.some((relation) => relation.kind === "implemented_by"));
  assert.ok(projection.relations.some((relation) => relation.kind === "depends_on_contract"));
  assert.ok(projection.relations.some((relation) => relation.kind === "persists_to"));
  assert.equal(projection.relations.some((relation) => relation.kind === "invokes"), false);
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
