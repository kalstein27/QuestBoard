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

function foreignLayoutGraph(): CodeGraphSnapshot {
  return {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId: "foreign-layout",
    rootPath: "/workspace/foreign-layout",
    indexedAt: "2026-10-01T00:00:00.000Z",
    nodes: [
      { id: "http", kind: "function", name: "createHttpServer", canonicalIdentity: "pkg:transport/createHttpServer", location: { path: "lib/transport/http.ts", startLine: 10 } },
      { id: "mcp", kind: "function", name: "dispatchModernMcpRequest", canonicalIdentity: "pkg:protocol/dispatchModernMcpRequest", location: { path: "lib/protocol/modern.ts", startLine: 20 } },
      { id: "core", kind: "function", name: "runOperation", canonicalIdentity: "pkg:execution/runOperation", location: { path: "lib/execution/background.ts", startLine: 30 } },
      { id: "same-file-helper", kind: "function", name: "sendResponse", canonicalIdentity: "pkg:transport/sendResponse", location: { path: "lib/transport/http.ts", startLine: 40 } },
    ],
    relations: [
      { id: "http-core", from: "http", to: "core", kind: "calls", confidence: 1 },
      { id: "mcp-core", from: "mcp", to: "core", kind: "calls", confidence: 1 },
      { id: "http-helper", from: "http", to: "same-file-helper", kind: "calls", confidence: 1 },
    ],
  };
}

function sparseProjectionGraph(): CodeGraphSnapshot {
  return {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId: "sparse-layout",
    rootPath: "/workspace/sparse-layout",
    indexedAt: "2026-10-01T00:30:00.000Z",
    nodes: [
      { id: "http", kind: "function", name: "createHttpServer", canonicalIdentity: "pkg:createHttpServer", location: { path: "lib/http.ts", startLine: 10 } },
      { id: "worker", kind: "function", name: "runWorker", canonicalIdentity: "pkg:runWorker", location: { path: "lib/worker.ts", startLine: 20 } },
    ],
    relations: [],
  };
}

test("projects only raw-evidence-backed human-readable architecture nodes", () => {
  const projection = projectCodeArchitecture(questBoardGraph());

  assert.deepEqual(projection.quality, { status: "useful", groupCount: 5, relationCount: 4 });

  assert.deepEqual(
    projection.nodes.map((node) => [node.kind, node.title]),
    [
      ["http_api", "HTTP API"],
      ["agent_mcp", "Agent / MCP"],
      ["application_service", "Application Service"],
      ["repository_contract", "Repository Contract"],
      ["sqlite_repository", "SQLite Repository"],
    ],
  );
  assert.deepEqual(
    projection.relations.map((relation) => relation.kind).sort(),
    ["depends_on_contract", "implemented_by", "invokes", "invokes"].sort(),
  );
  assert.equal(projection.relations.every((relation) => relation.sourceRelationIds.length > 0), true);
});

test("projects SQLite persistence only when a sqlite repository instantiates an external SQLite symbol", () => {
  const graph = questBoardGraph();
  graph.nodes = [
    ...graph.nodes,
    {
      id: "external-database-sync",
      kind: "class",
      name: "DatabaseSync",
      canonicalIdentity: "scip-external:scip-typescript npm @types/node 0.0.0 node:sqlite/DatabaseSync#",
      provenance: [{ providerId: "scip-typescript", fidelity: "semantic-reference", freshness: "fresh" }],
    },
  ];
  graph.relations = [
    ...graph.relations,
    { id: "sqlite-database", from: "sqlite-repository", to: "external-database-sync", kind: "instantiates", confidence: 1 },
  ];

  const projection = projectCodeArchitecture(graph);
  assert.deepEqual(projection.quality, { status: "useful", groupCount: 6, relationCount: 5 });
  assert.equal(projection.nodes.some((node) => node.kind === "sqlite"), true);
  const persistsTo = projection.relations.find((relation) => relation.kind === "persists_to");
  assert.ok(persistsTo);
  assert.deepEqual(persistsTo.sourceRelationIds, ["sqlite-database"]);
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

test("architecture projection recovers entrypoint-to-core structure outside QuestBoard folder conventions", () => {
  const projection = projectCodeArchitecture(foreignLayoutGraph());

  assert.deepEqual(projection.quality, { status: "useful", groupCount: 3, relationCount: 2 });

  assert.deepEqual(
    projection.nodes.map((node) => node.kind),
    ["http_api", "agent_mcp", "application_service"],
  );
  const service = projection.nodes.find((node) => node.kind === "application_service");
  assert.deepEqual(service?.memberNodeIds, ["core"]);
  const invokes = projection.relations.filter((relation) => relation.kind === "invokes");
  assert.equal(invokes.length, 2);
  assert.deepEqual(
    invokes.flatMap((relation) => relation.sourceRelationIds).sort(),
    ["http-core", "mcp-core"],
  );
  assert.equal(invokes.some((relation) => relation.sourceRelationIds.includes("http-helper")), false);
});

test("architecture projection marks a deliberately sparse one-group lens explicitly", () => {
  const projection = projectCodeArchitecture(sparseProjectionGraph());

  assert.deepEqual(projection.nodes.map((node) => node.kind), ["http_api"]);
  assert.equal(projection.relations.length, 0);
  assert.deepEqual(projection.quality, {
    status: "sparse",
    reason: "single_group",
    groupCount: 1,
    relationCount: 0,
  });
});

test("large role-only architecture projection reports overcompression and bounded source subsystems", () => {
  const graph = questBoardGraph();
  graph.nodes = graph.nodes.filter((node) => node.id !== "sqlite-repository");
  graph.relations = graph.relations.filter((relation) => relation.id !== "sqlite-contract");
  const roleBaseline = projectCodeArchitecture(graph);
  const prefixes = [
    "src/server", "src/runtime", "src/exec", "src/bridge",
    "src/workflows", "src/providers", "src/adapters", "src/operations",
    "src/transport", "src/control", "src/security", "src/core",
    "src/infrastructure", "src/shared",
  ];
  const symbols = Array.from({ length: 2932 }, (_, index) => ({
    id: `symbol-${index}`,
    kind: "function" as const,
    name: `helper${index}`,
    canonicalIdentity: `scip:helper${index}().`,
    language: "typescript",
    location: { path: `${prefixes[index % prefixes.length]}/unit-${Math.floor(index / prefixes.length) % 12}.ts`, startLine: index + 1 },
  }));
  graph.nodes = [...graph.nodes, ...symbols];
  graph.relations = [
    ...graph.relations,
    ...Array.from({ length: 320 }, (_, index) => ({
      id: `subsystem-call-${index}`,
      from: symbols[index]!.id,
      to: symbols[index + 1]!.id,
      kind: "calls" as const,
      confidence: 1,
    })),
  ];

  const projection = projectCodeArchitecture(graph);
  assert.equal(graph.nodes.length, 2936);
  assert.equal(projection.nodes.length, 4, "stable macro role taxonomy must not be redefined");
  assert.equal(projection.relations.length, 3);
  assert.deepEqual(
    projection.nodes.map((node) => [node.id, node.kind]),
    roleBaseline.nodes.map((node) => [node.id, node.kind]),
    "derived role IDs must remain compatible with Investigation sync",
  );
  assert.equal(projection.quality.status, "sparse");
  assert.equal(projection.quality.reason, "overcompressed");
  const quality = projection.quality.diagnostics!;
  assert.equal(quality.sourceSymbolCount, 2936);
  assert.equal(quality.representedSymbolCount, 4);
  assert.equal(quality.sourceRelationCount, 323);
  assert.equal(quality.evidencedRelationCount, 3);
  assert.equal(quality.symbolsPerGroup, 734);
  assert.ok(quality.symbolCoverageRatio < 0.01);
  assert.ok(quality.relationEvidenceRatio < 0.01);

  const subsystems = projection.subsystems!;
  assert.equal(subsystems.nodes.length, 12);
  assert.equal(subsystems.truncated, true);
  assert.ok(subsystems.nodes.some((node) => node.pathPrefix === "src/runtime"));
  assert.ok(subsystems.relations.length > 0 && subsystems.relations.length <= 24);
  const rawIds = new Set(graph.nodes.map((node) => node.id));
  const rawRelationIds = new Set(graph.relations.map((relation) => relation.id));
  assert.ok(subsystems.nodes.every((node) => node.sampleNodeIds.length <= 5
    && node.sampleNodeIds.every((id) => rawIds.has(id))));
  assert.ok(subsystems.relations.every((relation) => relation.kind === "calls"
    && relation.sourceRelationIds.length <= 16
    && relation.sourceRelationIds.every((id) => rawRelationIds.has(id))));
  assert.equal(graph.nodes.length, 2936, "derived subsystem grouping must not mutate the canonical graph");
});
