import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  CODE_GRAPH_SCHEMA_VERSION,
  CODE_MAP_QUERY_MAX_LIMIT,
  CodeMapQueryError,
  CodeMapService,
  createQuestBoardHttpServer,
  queryCodeGraph,
  QuestBoardService,
  SqliteQuestBoardRepository,
  type ActorRef,
  type CodeGraphSnapshot,
  type CodeIndexRequest,
  type CodeIntelligenceProvider,
} from "../src/index.js";

const actor: ActorRef = { id: "agent:code-query-test", provider: "test" };

function fixtureGraph(projectId = "questboard", rootPath = "/workspace/questboard"): CodeGraphSnapshot {
  return {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId,
    rootPath,
    indexedAt: "2026-09-28T13:00:00.000Z",
    nodes: [
      { id: "file-service", kind: "file", name: "service.ts", canonicalIdentity: "file:src/service.ts", language: "typescript", location: { path: "src/service.ts" } },
      { id: "class-service", kind: "class", name: "Service", canonicalIdentity: "scip:Service#", language: "typescript", location: { path: "src/service.ts", startLine: 1, endLine: 20 } },
      { id: "method-run", kind: "method", name: "run", canonicalIdentity: "scip:Service#run().", language: "typescript", location: { path: "src/service.ts", startLine: 4, endLine: 8 }, signature: "run(): void" },
      { id: "method-helper", kind: "method", name: "helper", canonicalIdentity: "scip:Service#helper().", language: "typescript", location: { path: "src/service.ts", startLine: 10, endLine: 12 } },
      { id: "file-caller", kind: "file", name: "caller.ts", canonicalIdentity: "file:src/caller.ts", language: "typescript", location: { path: "src/caller.ts" } },
      { id: "function-caller", kind: "function", name: "invokeService", canonicalIdentity: "scip:invokeService().", language: "typescript", location: { path: "src/caller.ts", startLine: 1, endLine: 5 } },
      { id: "config", kind: "variable", name: "config", canonicalIdentity: "scip:config.", language: "typescript", location: { path: "src/service.ts", startLine: 14 } },
      { id: "file-readme", kind: "file", name: "README.md", canonicalIdentity: "file:README.md", location: { path: "README.md" } },
    ],
    relations: [
      { id: "contains-file-class", from: "file-service", to: "class-service", kind: "contains", confidence: 1 },
      { id: "contains-class-run", from: "class-service", to: "method-run", kind: "contains", confidence: 1 },
      { id: "contains-class-helper", from: "class-service", to: "method-helper", kind: "contains", confidence: 1 },
      { id: "contains-file-caller", from: "file-caller", to: "function-caller", kind: "contains", confidence: 1 },
      { id: "caller-runs", from: "function-caller", to: "method-run", kind: "calls", confidence: 1, evidence: [{ location: { path: "src/caller.ts", startLine: 3 }, label: "call" }] },
      { id: "run-helper", from: "method-run", to: "method-helper", kind: "calls", confidence: 1 },
      { id: "run-config", from: "method-run", to: "config", kind: "reads", confidence: 0.9, evidence: [{ location: { path: "src/service.ts", startLine: 6 } }] },
    ],
  };
}

class QueryProvider implements CodeIntelligenceProvider {
  readonly providerId = "query-test-provider";
  readonly capabilities = { incrementalIndexing: false, impactAnalysis: false, callTrace: true } as const;

  async indexProject(request: CodeIndexRequest): Promise<CodeGraphSnapshot> {
    return fixtureGraph(request.projectId, request.rootPath);
  }
}

test("bounded Code Map queries navigate definition, hierarchy, callers, callees, and references", () => {
  const graph = fixtureGraph();
  const found = queryCodeGraph(graph, "query-test-provider", {
    operation: "find_nodes",
    query: "run",
    kinds: ["method"],
  });
  assert.equal(found.operation, "find_nodes");
  assert.deepEqual(found.nodes.map((node) => node.id), ["method-run"]);
  assert.equal(found.providerId, "query-test-provider");

  const exact = queryCodeGraph(graph, "query-test-provider", {
    operation: "get_node",
    canonicalIdentity: "scip:Service#run().",
  });
  assert.equal(exact.operation, "get_node");
  assert.equal(exact.node.id, "method-run");
  assert.equal(exact.node.location?.path, "src/service.ts");

  const hierarchy = queryCodeGraph(graph, "query-test-provider", {
    operation: "hierarchy",
    nodeId: "method-run",
    direction: "parents",
    depth: 2,
  });
  assert.equal(hierarchy.operation, "hierarchy");
  assert.deepEqual(hierarchy.entries.map((entry) => [entry.node.id, entry.depth]), [
    ["class-service", 1],
    ["file-service", 2],
  ]);

  const children = queryCodeGraph(graph, "query-test-provider", {
    operation: "hierarchy",
    nodeId: "class-service",
    direction: "children",
    depth: 1,
  });
  assert.equal(children.operation, "hierarchy");
  assert.deepEqual(children.entries.map((entry) => entry.node.id), ["method-run", "method-helper"]);

  const callers = queryCodeGraph(graph, "query-test-provider", {
    operation: "relations",
    nodeId: "method-run",
    semantic: "callers",
  });
  assert.equal(callers.operation, "relations");
  assert.deepEqual(callers.entries.map((entry) => entry.node.id), ["function-caller"]);
  assert.equal(callers.entries[0]?.relation.evidence?.[0]?.location.path, "src/caller.ts");

  const callees = queryCodeGraph(graph, "query-test-provider", {
    operation: "relations",
    nodeId: "method-run",
    semantic: "callees",
  });
  assert.equal(callees.operation, "relations");
  assert.deepEqual(callees.entries.map((entry) => entry.node.id), ["method-helper"]);

  const references = queryCodeGraph(graph, "query-test-provider", {
    operation: "relations",
    nodeId: "method-run",
    semantic: "references",
  });
  assert.equal(references.operation, "relations");
  assert.deepEqual(references.entries.map((entry) => entry.node.id), ["config"]);
});

test("semantic references exclude broad depends_on noise while explicit dependency queries preserve it", () => {
  const graph = fixtureGraph();
  graph.nodes = [
    ...graph.nodes,
    { id: "local-noise", kind: "variable", name: "parsed", canonicalIdentity: "scip:src/service.ts:local 7", language: "typescript", location: { path: "src/service.ts", startLine: 7 } },
  ];
  graph.relations = [
    ...graph.relations,
    { id: "run-local-noise", from: "method-run", to: "local-noise", kind: "depends_on", confidence: 0.9 },
  ];

  const references = queryCodeGraph(graph, "query-test-provider", {
    operation: "relations",
    nodeId: "method-run",
    semantic: "references",
  });
  assert.equal(references.operation, "relations");
  assert.deepEqual(references.entries.map((entry) => entry.node.id), ["config"]);

  const dependencies = queryCodeGraph(graph, "query-test-provider", {
    operation: "relations",
    nodeId: "method-run",
    direction: "outgoing",
    relationKinds: ["depends_on"],
  });
  assert.equal(dependencies.operation, "relations");
  assert.deepEqual(dependencies.entries.map((entry) => entry.node.id), ["local-noise"]);
});

test("find_nodes normalizes unknown language and ranks exact names ahead of enclosing canonical matches", () => {
  const graph = fixtureGraph();
  const unknown = queryCodeGraph(graph, "query-test-provider", {
    operation: "find_nodes",
    language: "unknown",
  });
  assert.equal(unknown.operation, "find_nodes");
  assert.deepEqual(unknown.nodes.map((node) => node.id), ["file-readme"]);

  const ranked = queryCodeGraph(graph, "query-test-provider", {
    operation: "find_nodes",
    query: "Service",
    limit: 5,
  });
  assert.equal(ranked.operation, "find_nodes");
  assert.equal(ranked.nodes[0]?.id, "class-service");
});

test("neighborhood keeps broad depends_on edges behind more useful navigation relations", () => {
  const graph = fixtureGraph();
  graph.nodes = [
    ...graph.nodes,
    { id: "dependency-noise", kind: "type", name: "DependencyNoise", canonicalIdentity: "scip:DependencyNoise#", language: "typescript", location: { path: "src/noise.ts", startLine: 1 } },
  ];
  graph.relations = [
    ...graph.relations,
    { id: "dependency-noise-edge", from: "method-run", to: "dependency-noise", kind: "depends_on", confidence: 0.9 },
  ];

  const neighborhood = queryCodeGraph(graph, "query-test-provider", {
    operation: "neighborhood",
    nodeId: "method-run",
    direction: "outgoing",
    depth: 1,
    limit: 3,
  });
  assert.equal(neighborhood.operation, "neighborhood");
  assert.deepEqual(neighborhood.nodes.map((node) => node.id), ["method-run", "method-helper", "config"]);
});

test("Code Map query limits are hard bounded and ambiguous search stays explicit", () => {
  const graph = fixtureGraph();
  graph.nodes = [
    ...graph.nodes,
    ...Array.from({ length: 140 }, (_, index) => ({
      id: `extra-${index}`,
      kind: "function" as const,
      name: `sharedName${index}`,
      canonicalIdentity: `extra:${index}`,
      location: { path: `src/generated-${index}.ts`, startLine: 1 },
    })),
  ];

  const result = queryCodeGraph(graph, "query-test-provider", {
    operation: "find_nodes",
    query: "sharedName",
    limit: 10_000,
  });
  assert.equal(result.operation, "find_nodes");
  assert.equal(result.limit, CODE_MAP_QUERY_MAX_LIMIT);
  assert.equal(result.nodes.length, CODE_MAP_QUERY_MAX_LIMIT);
  assert.equal(result.matchedCount, 140);
  assert.equal(result.truncated, true);

});

test("exact ambiguous identities and unindexed service queries fail explicitly", () => {
  const graph = fixtureGraph();
  assert.throws(
    () => queryCodeGraph({
      ...graph,
      nodes: [
        ...graph.nodes,
        { id: "duplicate-canonical", kind: "method", name: "runDuplicate", canonicalIdentity: "scip:Service#run()." },
      ],
    }, "query-test-provider", {
      operation: "get_node",
      canonicalIdentity: "scip:Service#run().",
    }),
    (error: unknown) => error instanceof CodeMapQueryError && error.code === "code_node_ambiguous",
  );

  const service = new CodeMapService(new QueryProvider());
  assert.throws(
    () => service.query("questboard", { operation: "find_nodes", query: "run" }),
    (error: unknown) => error instanceof CodeMapQueryError && error.code === "code_map_not_indexed",
  );
});

test("HTTP and MCP share the same bounded Code Map query surface", async () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  const project = service.createProject({ name: "Query boundary", rootPath: "/workspace/query-boundary" }, actor);
  const codeMapService = new CodeMapService(new QueryProvider());
  const server = createQuestBoardHttpServer(service, { codeMapService });

  try {
    await listen(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const codeMapUrl = `${baseUrl}/projects/${encodeURIComponent(project.id)}/code-map`;
    const queryUrl = `${codeMapUrl}/query`;

    const before = await json(queryUrl, {
      method: "POST",
      body: JSON.stringify({ operation: "find_nodes", query: "run" }),
    });
    assert.equal(before.response.status, 409);
    assert.equal(before.body.error.code, "code_map_not_indexed");

    assert.equal((await json(codeMapUrl, { method: "POST" })).response.status, 200);

    const httpFound = await json(queryUrl, {
      method: "POST",
      body: JSON.stringify({ operation: "find_nodes", query: "run", kinds: ["method"], limit: 5 }),
    });
    assert.equal(httpFound.response.status, 200);
    assert.equal(httpFound.body.query.nodes[0]?.id, "method-run");
    assert.equal(httpFound.body.query.providerId, "query-test-provider");

    const tools = await mcp(baseUrl, 1, "tools/list");
    const toolNames = (tools.result.tools as Array<{ name: string }>).map((tool) => tool.name);
    assert.ok(toolNames.includes("questboard_query_code_map"));

    const mcpCall = await mcp(baseUrl, 2, "tools/call", {
      name: "questboard_query_code_map",
      arguments: {
        projectId: project.id,
        operation: "relations",
        nodeId: "method-run",
        semantic: "callers",
        limit: 5,
      },
    });
    const content = mcpCall.result.content as Array<{ text: string }>;
    const payload = JSON.parse(content[0]?.text ?? "{}") as {
      query: { entries: Array<{ node: { id: string } }>; truncated: boolean };
    };
    assert.deepEqual(payload.query.entries.map((entry) => entry.node.id), ["function-caller"]);
    assert.equal(payload.query.truncated, false);

    const neighborhood = await json(queryUrl, {
      method: "POST",
      body: JSON.stringify({
        operation: "neighborhood",
        nodeIds: ["method-run"],
        depth: 3,
        limit: 3,
      }),
    });
    assert.equal(neighborhood.body.query.nodes.length <= 3, true);
    assert.equal(neighborhood.body.query.relations.length <= 3, true);
  } finally {
    await closeServer(server);
    repository.close();
  }
});

async function listen(server: ReturnType<typeof createQuestBoardHttpServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function closeServer(server: ReturnType<typeof createQuestBoardHttpServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function json(url: string, init?: RequestInit): Promise<{ response: Response; body: any }> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  return { response, body: await response.json() };
}

async function mcp(
  baseUrl: string,
  id: number,
  method: string,
  params?: unknown,
): Promise<any> {
  const result = await json(`${baseUrl}/_questboard/mcp-proxy`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-questboard-daemon-client": "1" },
    body: JSON.stringify({
      sessionId: "code-map-query-boundary",
      message: { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) },
    }),
  });
  assert.equal(result.response.status, 200);
  return result.body;
}
