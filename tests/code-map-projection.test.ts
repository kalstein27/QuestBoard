import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_GRAPH_SCHEMA_VERSION,
  projectCodeArchitecture,
  type CodeGraphSnapshot,
} from "../src/index.js";

function questBoardGraph(): CodeGraphSnapshot {
  return {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId: "questboard",
    rootPath: "/workspace/questboard",
    indexedAt: "2026-09-22T13:00:00.000Z",
    nodes: [
      {
        id: "http",
        kind: "function",
        name: "handleRequest",
        canonicalIdentity: "src/server/http-api.ts#function:handleRequest",
        location: { path: "src/server/http-api.ts", startLine: 1 },
      },
      {
        id: "agent",
        kind: "function",
        name: "executeQuestBoardAgentTool",
        canonicalIdentity: "src/adapters/agent-tools.ts#function:executeQuestBoardAgentTool",
        location: { path: "src/adapters/agent-tools.ts", startLine: 1 },
      },
      {
        id: "service",
        kind: "method",
        name: "createTask",
        canonicalIdentity: "src/application/quest-board-service.ts#method:QuestBoardService.createTask",
        location: { path: "src/application/quest-board-service.ts", startLine: 1 },
      },
      {
        id: "contract",
        kind: "interface",
        name: "QuestBoardRepository",
        canonicalIdentity: "src/application/quest-board-repository.ts#interface:QuestBoardRepository",
        location: { path: "src/application/quest-board-repository.ts", startLine: 1 },
      },
      {
        id: "sqlite-repository",
        kind: "class",
        name: "SqliteQuestBoardRepository",
        canonicalIdentity: "src/storage/sqlite/sqlite-quest-board-repository.ts#class:SqliteQuestBoardRepository",
        location: { path: "src/storage/sqlite/sqlite-quest-board-repository.ts", startLine: 1 },
      },
    ],
    relations: [
      { id: "http-service", from: "http", to: "service", kind: "calls", confidence: 1 },
      { id: "agent-service", from: "agent", to: "service", kind: "calls", confidence: 1 },
      {
        id: "service-contract",
        from: "service",
        to: "contract",
        kind: "references_type",
        confidence: 1,
      },
      {
        id: "sqlite-contract",
        from: "sqlite-repository",
        to: "contract",
        kind: "implements",
        confidence: 1,
      },
    ],
  };
}

test("projects raw code intelligence into the six human-readable architecture nodes", () => {
  const projection = projectCodeArchitecture(questBoardGraph());

  assert.deepEqual(
    projection.nodes.map((node) => [node.kind, node.title]),
    [
      ["http_api", "HTTP API"],
      ["agent_mcp", "Agent / MCP"],
      ["application_service", "Application Service"],
      ["repository_contract", "Repository Contract"],
      ["sqlite_repository", "SQLite Repository"],
      ["sqlite", "SQLite"],
    ],
  );
  assert.deepEqual(
    projection.relations.map((relation) => relation.kind).sort(),
    ["depends_on_contract", "implemented_by", "invokes", "invokes", "persists_to"].sort(),
  );
});

test("architecture projection keeps macro ids stable when raw graph ids change", () => {
  const first = projectCodeArchitecture(questBoardGraph());
  const changed = questBoardGraph();
  changed.nodes = changed.nodes.map((node) => ({ ...node, id: `changed:${node.id}` }));
  changed.relations = changed.relations.map((relation) => ({
    ...relation,
    from: `changed:${relation.from}`,
    to: `changed:${relation.to}`,
  }));
  const second = projectCodeArchitecture(changed);

  assert.deepEqual(
    first.nodes.map((node) => [node.kind, node.id]),
    second.nodes.map((node) => [node.kind, node.id]),
  );
});

test("projection retains raw relation ids as drill-down evidence without showing symbol noise", () => {
  const projection = projectCodeArchitecture(questBoardGraph());
  const implementedBy = projection.relations.find((relation) => relation.kind === "implemented_by");

  assert.ok(implementedBy);
  assert.deepEqual(implementedBy.sourceRelationIds, ["sqlite-contract"]);
  const contract = projection.nodes.find((node) => node.kind === "repository_contract");
  const sqliteRepository = projection.nodes.find((node) => node.kind === "sqlite_repository");
  assert.equal(implementedBy.from, contract?.id);
  assert.equal(implementedBy.to, sqliteRepository?.id);
});
