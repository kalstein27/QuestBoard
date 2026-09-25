import assert from "node:assert/strict";
import test from "node:test";
import { projectCodeArchitecture } from "../src/application/code-map-projection.js";
import { normalizeGitNexusGraph } from "../src/adapters/code-intelligence/gitnexus-normalizer.js";
import { normalizeScipGraph, parseScipJsonIndex } from "../src/adapters/code-intelligence/scip-normalizer.js";

const base = {
  projectId: "questboard",
  rootPath: "/workspace/questboard",
  indexedAt: "2026-09-23T00:00:00.000Z",
} as const;

const symbols = {
  http: "scip ts qb 0 http/handleRequest().",
  agent: "scip ts qb 0 agent/executeQuestBoardAgentTool().",
  service: "scip ts qb 0 service/QuestBoardService#createTask().",
  contract: "scip ts qb 0 repository/QuestBoardRepository#",
  sqlite: "scip ts qb 0 sqlite/SqliteQuestBoardRepository#",
};

function scipProjection() {
  const index = parseScipJsonIndex({
    documents: [
      {
        relativePath: "src/server/http-api.ts",
        symbols: [{ symbol: symbols.http, displayName: "handleRequest", kind: "Function" }],
        occurrences: [
          { symbol: symbols.http, symbolRoles: 1, range: [1, 0, 13], enclosingRange: [1, 0, 30, 1] },
          { symbol: symbols.service, symbolRoles: 0, range: [10, 4, 14] },
        ],
      },
      {
        relativePath: "src/adapters/agent-tools.ts",
        symbols: [{ symbol: symbols.agent, displayName: "executeQuestBoardAgentTool", kind: "Function" }],
        occurrences: [
          { symbol: symbols.agent, symbolRoles: 1, range: [1, 0, 28], enclosingRange: [1, 0, 30, 1] },
          { symbol: symbols.service, symbolRoles: 0, range: [10, 4, 14] },
        ],
      },
      {
        relativePath: "src/application/quest-board-service.ts",
        symbols: [{ symbol: symbols.service, displayName: "createTask", kind: "Method" }],
        occurrences: [
          { symbol: symbols.service, symbolRoles: 1, range: [20, 2, 12], enclosingRange: [20, 0, 50, 1] },
          { symbol: symbols.contract, symbolRoles: 0, range: [30, 4, 24] },
        ],
      },
      {
        relativePath: "src/application/quest-board-repository.ts",
        symbols: [{ symbol: symbols.contract, displayName: "QuestBoardRepository", kind: "Interface" }],
        occurrences: [{ symbol: symbols.contract, symbolRoles: 1, range: [1, 10, 30], enclosingRange: [1, 0, 30, 1] }],
      },
      {
        relativePath: "src/storage/sqlite/sqlite-quest-board-repository.ts",
        symbols: [{
          symbol: symbols.sqlite,
          displayName: "SqliteQuestBoardRepository",
          kind: "Class",
          relationships: [{ symbol: symbols.contract, isImplementation: true }],
        }],
        occurrences: [{ symbol: symbols.sqlite, symbolRoles: 1, range: [1, 6, 32], enclosingRange: [1, 0, 100, 1] }],
      },
    ],
  });
  const sourceWithCreateTaskCall = Array.from({ length: 31 }, (_, line) => line === 10 ? "    createTask();" : "").join("\n");
  return projectCodeArchitecture(normalizeScipGraph({
    ...base,
    index,
    sourceTextByPath: new Map([
      ["src/server/http-api.ts", sourceWithCreateTaskCall],
      ["src/adapters/agent-tools.ts", sourceWithCreateTaskCall],
    ]),
  }));
}

function gitNexusProjection() {
  return projectCodeArchitecture(normalizeGitNexusGraph({
    ...base,
    nodes: [
      { uid: "http", kind: "Function", name: "handleRequest", filePath: "src/server/http-api.ts", startLine: 1 },
      { uid: "agent", kind: "Function", name: "executeQuestBoardAgentTool", filePath: "src/adapters/agent-tools.ts", startLine: 1 },
      { uid: "service", kind: "Method", name: "createTask", filePath: "src/application/quest-board-service.ts", startLine: 20 },
      { uid: "contract", kind: "Interface", name: "QuestBoardRepository", filePath: "src/application/quest-board-repository.ts", startLine: 1 },
      { uid: "sqlite", kind: "Class", name: "SqliteQuestBoardRepository", filePath: "src/storage/sqlite/sqlite-quest-board-repository.ts", startLine: 1 },
    ],
    relations: [
      { fromUid: "http", toUid: "service", type: "CALLS" },
      { fromUid: "agent", toUid: "service", type: "CALLS" },
      { fromUid: "service", toUid: "contract", type: "TYPE_REF" },
      { fromUid: "sqlite", toUid: "contract", type: "IMPLEMENTS" },
    ],
  }));
}

test("SCIP and GitNexus agree on macro nodes and invoke edges when SCIP has source call evidence", () => {
  const scip = scipProjection();
  const gitNexus = gitNexusProjection();

  assert.deepEqual(
    scip.nodes.map((node) => node.kind),
    gitNexus.nodes.map((node) => node.kind),
    "both providers should recover the same six human architecture nodes",
  );
  assert.deepEqual(
    gitNexus.relations.map((relation) => relation.kind).sort(),
    ["depends_on_contract", "implemented_by", "invokes", "invokes", "persists_to"].sort(),
  );
  assert.deepEqual(
    scip.relations.map((relation) => relation.kind).sort(),
    ["depends_on_contract", "implemented_by", "invokes", "invokes", "persists_to"].sort(),
    "SCIP promotes only references backed by source call syntax",
  );
});
