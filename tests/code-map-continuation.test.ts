import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  CODE_GRAPH_SCHEMA_VERSION,
  CodeMapQueryError,
  CodeMapService,
  createQuestBoardHttpServer,
  queryCodeMapContinuations,
  QuestBoardService,
  SqliteQuestBoardRepository,
  type ActorRef,
  type CodeGraphSnapshot,
  type CodeIndexRequest,
  type CodeIntelligenceProvider,
} from "../src/index.js";

const indexedAt = "2026-10-07T12:00:00.000Z";
const actor: ActorRef = { id: "agent:continuation-test", provider: "test" };

function continuationGraph(projectId = "questboard", rootPath = "/workspace/questboard"): CodeGraphSnapshot {
  const downstream = Array.from({ length: 18 }, (_, index) => ({
    id: `downstream-${String(index).padStart(2, "0")}`,
    kind: "function" as const,
    name: `downstream${index}`,
    canonicalIdentity: `scip:downstream${String(index).padStart(2, "0")}().`,
    language: "typescript",
    location: { path: "src/server/tools.ts", startLine: 200 + index, endLine: 201 + index },
  }));
  return {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId,
    rootPath,
    indexedAt,
    nodes: [
      { id: "owner", kind: "function", name: "registerTools", canonicalIdentity: "scip:registerTools().", language: "typescript", location: { path: "src/server/tools.ts", startLine: 100, startColumn: 1, endLine: 100, endColumn: 14 }, lexicalExtent: { path: "src/server/tools.ts", startLine: 100, startColumn: 1, endLine: 400, endColumn: 1 } },
      { id: "handler", kind: "function", name: "managed_mcp_update", canonicalIdentity: "source-registration:src/server/tools.ts:registerTool:managed_mcp_update:120", language: "typescript", location: { path: "src/server/tools.ts", startLine: 120, startColumn: 1, endLine: 180, endColumn: 1 } },
      { id: "next-handler", kind: "function", name: "runtime_update_prepare", canonicalIdentity: "source-registration:src/server/tools.ts:registerTool:runtime_update_prepare:300", language: "typescript", location: { path: "src/server/tools.ts", startLine: 300, startColumn: 1, endLine: 340, endColumn: 1 } },
      { id: "wrapper", kind: "function", name: "withErrorMapping", canonicalIdentity: "scip:withErrorMapping().", language: "typescript", location: { path: "src/server/tools.ts", startLine: 20, endLine: 40 } },
      { id: "external", kind: "function", name: "external", canonicalIdentity: "scip-external:external()." },
      ...downstream,
    ],
    relations: [
      { id: "handler-wrapper", from: "handler", to: "wrapper", kind: "calls", confidence: 1, evidence: [{ location: { path: "src/server/tools.ts", startLine: 125, startColumn: 3 }, label: "call" }], provenance: [{ providerId: "scip", fidelity: "semantic-call", freshness: "fresh" }] },
      ...downstream.map((node, index) => ({
        id: `owner-downstream-${String(index).padStart(2, "0")}`,
        from: "owner",
        to: node.id,
        kind: "calls" as const,
        confidence: 1,
        evidence: [{ location: { path: "src/server/tools.ts", startLine: 130 + index, startColumn: 5 }, label: "call" }],
        provenance: [{ providerId: "scip", fidelity: "semantic-call" as const, freshness: "fresh" as const }],
      })),
      { id: "owner-external", from: "owner", to: "external", kind: "calls", confidence: 1, evidence: [{ location: { path: "src/server/tools.ts", startLine: 170, startColumn: 1 } }] },
      { id: "outside-registration", from: "owner", to: "downstream-00", kind: "calls", confidence: 1, evidence: [{ location: { path: "src/server/tools.ts", startLine: 350, startColumn: 1 } }] },
    ],
  };
}

class ContinuationProvider implements CodeIntelligenceProvider {
  readonly providerId = "continuation-provider";
  readonly capabilities = { incrementalIndexing: false, impactAnalysis: false, callTrace: false } as const;
  changed = false;
  async indexProject(request: CodeIndexRequest): Promise<CodeGraphSnapshot> {
    const graph = continuationGraph(request.projectId, request.rootPath);
    return this.changed ? {
      ...graph,
      relations: graph.relations.map((relation) => relation.id === "owner-downstream-00"
        ? { ...relation, confidence: 0.75 }
        : relation),
    } : graph;
  }
}

test("continuation preserves two raw facts and exposes only a navigation handoff", () => {
  const graph = continuationGraph();
  const result = queryCodeMapContinuations(graph, { nodeId: "handler", limit: 8 });
  assert.equal(result.available, true);
  assert.deepEqual(result.semantics, {
    kind: "registration_owner_handoff",
    isCallEdge: false,
    createsRelation: false,
    syntheticTransitiveEdge: false,
    rawRelationOwnerPreserved: true,
  });
  assert.equal(result.registrationEvidence[0]?.id, "handler-wrapper");
  assert.equal(result.registrationEvidence[0]?.from, "handler");
  assert.equal(result.ownerSelection?.node.id, "owner");
  assert.equal(result.ownerSelection?.isRelation, false);
  assert.equal(result.candidates[0]?.ownerDownstreamRelation.from, "owner");
  assert.equal(result.candidates[0]?.handoff.registrationRelationId, "handler-wrapper");
  assert.equal(result.candidates[0]?.handoff.isCallEdge, false);
  assert.equal(result.externalFilteredNodeCount, 1);
  assert.equal(result.candidateCount, 18);
  assert.equal(result.returnedCount, 8);
  assert.equal(result.truncated, true);
  assert.equal(result.reason, "candidate_cap");
  assert.equal(result.nextOffset, 8);

  const second = queryCodeMapContinuations(graph, {
    nodeId: "handler", offset: 8, limit: 8, expectedSourceIndexedAt: indexedAt, expectedSnapshotId: "fixture-snapshot",
  }, "fixture-snapshot");
  assert.deepEqual(second.candidates.map((candidate) => candidate.node.id), [
    "downstream-08", "downstream-09", "downstream-10", "downstream-11",
    "downstream-12", "downstream-13", "downstream-14", "downstream-15",
  ]);
  assert.equal(second.hasMore, false, "hard candidate cap is independent from the raw candidate count");
  assert.throws(
    () => queryCodeMapContinuations(graph, { nodeId: "handler", offset: 1 }),
    (error: unknown) => error instanceof CodeMapQueryError && error.code === "code_map_query_invalid",
  );
  assert.throws(
    () => queryCodeMapContinuations(graph, { nodeId: "handler", offset: 1, expectedSourceIndexedAt: "stale", expectedSnapshotId: "fixture-snapshot" }, "fixture-snapshot"),
    (error: unknown) => error instanceof CodeMapQueryError && error.code === "code_map_subsystem_snapshot_stale",
  );
  assert.throws(
    () => queryCodeMapContinuations(graph, { nodeId: "handler", offset: 1, expectedSourceIndexedAt: indexedAt }, "fixture-snapshot"),
    (error: unknown) => error instanceof CodeMapQueryError && error.code === "code_map_query_invalid",
  );
  assert.throws(
    () => queryCodeMapContinuations(graph, { nodeId: "handler", offset: 1, expectedSourceIndexedAt: indexedAt, expectedSnapshotId: "fixture-snapshot" }),
    (error: unknown) => error instanceof CodeMapQueryError && error.code === "code_map_snapshot_changed",
  );
});

test("continuation fails soft instead of guessing owner or downstream evidence", () => {
  const graph = continuationGraph();
  const normal = queryCodeMapContinuations(graph, { nodeId: "owner" });
  assert.equal(normal.available, false);
  assert.equal(normal.reason, "not_registration_handler");

  const noWrapper = { ...graph, relations: graph.relations.filter((relation) => relation.id !== "handler-wrapper") };
  assert.equal(queryCodeMapContinuations(noWrapper, { nodeId: "handler" }).reason, "no_wrapper_call_evidence");

  const ambiguous = {
    ...graph,
    nodes: [
      ...graph.nodes,
      { id: "owner-tie", kind: "function" as const, name: "tie", canonicalIdentity: "scip:tie().", location: { path: "src/server/tools.ts", startLine: 100, startColumn: 1, endLine: 100, endColumn: 4 }, lexicalExtent: { path: "src/server/tools.ts", startLine: 100, startColumn: 1, endLine: 400, endColumn: 1 } },
    ],
  };
  assert.equal(queryCodeMapContinuations(ambiguous, { nodeId: "handler" }).reason, "ambiguous_enclosing_owner");

  const noDownstream = { ...graph, relations: graph.relations.filter((relation) => relation.from !== "owner") };
  assert.equal(queryCodeMapContinuations(noDownstream, { nodeId: "handler" }).reason, "no_owner_downstream_evidence");
});

test("continuation requires provider-native lexical extent and refuses ambiguous or invalid enclosing owners", () => {
  const graph = continuationGraph();
  const withoutNative = { ...graph, nodes: graph.nodes.map((node) => node.id === "owner" ? { ...node, lexicalExtent: undefined } : node) };
  assert.equal(queryCodeMapContinuations(withoutNative, { nodeId: "handler" }).reason, "no_enclosing_owner");
  const invalidNative = { ...graph, nodes: graph.nodes.map((node) => node.id === "owner" ? { ...node, lexicalExtent: { path: "../outside.ts", startLine: 1, endLine: 999 } } : node) };
  assert.equal(queryCodeMapContinuations(invalidNative, { nodeId: "handler" }).reason, "no_enclosing_owner");
});

test("exact snapshotId pin rejects stale continuation even when indexedAt is unchanged", async () => {
  const holder: { saved?: unknown } = {};
  const store = { load: () => holder.saved, save: (_id: string, value: unknown) => { holder.saved = structuredClone(value); } };
  const persistence = { store, providerConfigFingerprint: "fixture-v1", sourceState: { rootIdentity: (path: string) => `root:${path}`, sourceManifestFingerprint: () => "manifest-v1" }, rootPathForProject: (_id: string) => "/workspace/questboard", now: () => indexedAt };
  const provider = new ContinuationProvider();
  const codeMapService = new CodeMapService(provider, undefined, undefined, undefined, persistence);
  await codeMapService.refresh({ projectId: "questboard", rootPath: "/workspace/questboard" });
  const first = codeMapService.queryContinuations("questboard", { nodeId: "handler" });
  assert.ok(first.snapshotId);
  assert.equal(codeMapService.queryContinuations("questboard", { nodeId: "handler", expectedSnapshotId: first.snapshotId }).snapshotId, first.snapshotId);
  assert.throws(() => codeMapService.queryContinuations("questboard", { nodeId: "handler", expectedSnapshotId: "different-snapshot", expectedSourceIndexedAt: indexedAt }),
    (error: unknown) => error instanceof CodeMapQueryError && error.code === "code_map_snapshot_changed");
  const pinnedPage = { nodeId: "handler", offset: 8, expectedSourceIndexedAt: indexedAt, expectedSnapshotId: first.snapshotId! };
  assert.equal(codeMapService.queryContinuations("questboard", pinnedPage).returnedCount, 8);
  provider.changed = true;
  await codeMapService.refresh({ projectId: "questboard", rootPath: "/workspace/questboard" });
  const second = codeMapService.queryContinuations("questboard", { nodeId: "handler" });
  assert.equal(second.sourceIndexedAt, first.sourceIndexedAt);
  assert.notEqual(second.snapshotId, first.snapshotId, "raw relation content changes exact digest without changing timestamp");
  assert.throws(() => codeMapService.queryContinuations("questboard", pinnedPage),
    (error: unknown) => error instanceof CodeMapQueryError && error.code === "code_map_snapshot_changed");
  assert.equal(codeMapService.queryContinuations("questboard", { ...pinnedPage, expectedSnapshotId: second.snapshotId! }).returnedCount, 8);
});

test("HTTP and MCP expose the same continuation DTO while provider callTrace capability stays false", async () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  const project = service.createProject({ name: "Continuation boundary", rootPath: "/workspace/continuation" }, actor);
  const holder: { saved?: unknown } = {};
  const store = { load: () => holder.saved, save: (_id: string, value: unknown) => { holder.saved = structuredClone(value); } };
  const persistence = { store, providerConfigFingerprint: "fixture-v1", sourceState: { rootIdentity: (path: string) => `root:${path}`, sourceManifestFingerprint: () => "manifest-v1" }, rootPathForProject: (_id: string) => project.rootPath!, now: () => indexedAt };
  const codeMapService = new CodeMapService(new ContinuationProvider(), undefined, undefined, undefined, persistence);
  await codeMapService.refresh({ projectId: project.id, rootPath: project.rootPath! });
  assert.equal(new ContinuationProvider().capabilities.callTrace, false);
  const server = createQuestBoardHttpServer(service, { codeMapService });
  try {
    await listen(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const input = { nodeId: "handler", limit: 4 };
    const http = await json(`${baseUrl}/projects/${encodeURIComponent(project.id)}/code-map/continuations/query`, {
      method: "POST", body: JSON.stringify(input),
    });
    assert.equal(http.response.status, 200);
    const tools = await mcp(baseUrl, 1, "tools/list");
    const toolNames = (tools.result.tools as Array<{ name: string }>).map((tool) => tool.name);
    assert.ok(toolNames.includes("questboard_query_code_map_continuations"));
    const mcpCall = await mcp(baseUrl, 2, "tools/call", {
      name: "questboard_query_code_map_continuations",
      arguments: { projectId: project.id, ...input },
    });
    const payload = JSON.parse((mcpCall.result.content as Array<{ text: string }>)[0]?.text ?? "{}");
    assert.deepEqual(payload.query, http.body.query);
    assert.equal(payload.query.semantics.isCallEdge, false);
    assert.ok(payload.query.snapshotId);
    const pinnedInput = { ...input, offset: 4, expectedSnapshotId: payload.query.snapshotId, expectedSourceIndexedAt: indexedAt };
    const pinnedHttp = await json(`${baseUrl}/projects/${encodeURIComponent(project.id)}/code-map/continuations/query`, { method: "POST", body: JSON.stringify(pinnedInput) });
    const pinnedMcp = await mcp(baseUrl, 3, "tools/call", { name: "questboard_query_code_map_continuations", arguments: { projectId: project.id, ...pinnedInput } });
    const pinnedPayload = JSON.parse((pinnedMcp.result.content as Array<{ text: string }>)[0]?.text ?? "{}");
    assert.deepEqual(pinnedPayload.query, pinnedHttp.body.query);
    assert.equal(pinnedHttp.body.query.snapshotId, payload.query.snapshotId);
    const staleHttp = await json(`${baseUrl}/projects/${encodeURIComponent(project.id)}/code-map/continuations/query`, { method: "POST", body: JSON.stringify({ ...pinnedInput, expectedSnapshotId: "stale" }) });
    assert.equal(staleHttp.response.status, 409);
    assert.equal(staleHttp.body.error?.code ?? staleHttp.body.query?.error?.code, "code_map_snapshot_changed");
    const failures: Array<{ invalid: Record<string, unknown>; code: string; status: number }> = [
      { invalid: { ...pinnedInput, expectedSnapshotId: undefined }, code: "code_map_query_invalid", status: 400 },
      { invalid: { ...pinnedInput, expectedSourceIndexedAt: undefined }, code: "code_map_query_invalid", status: 400 },
      { invalid: { ...pinnedInput, expectedSourceIndexedAt: "stale" }, code: "code_map_subsystem_snapshot_stale", status: 409 },
      { invalid: { ...pinnedInput, expectedSnapshotId: "stale" }, code: "code_map_snapshot_changed", status: 409 },
    ];
    for (const [index, { invalid, code, status }] of failures.entries()) {
      const httpError = await json(`${baseUrl}/projects/${encodeURIComponent(project.id)}/code-map/continuations/query`, { method: "POST", body: JSON.stringify(invalid) });
      assert.equal(httpError.response.status, status);
      assert.equal(httpError.body.error.code, code);
      const mcpError = await mcp(baseUrl, 10 + index, "tools/call", { name: "questboard_query_code_map_continuations", arguments: { projectId: project.id, ...invalid } });
      const mcpErrorBody = JSON.parse((mcpError.result.content as Array<{ text: string }>)[0]?.text ?? "{}");
      assert.equal(mcpError.result.isError, true);
      assert.equal(mcpErrorBody.error?.code ?? mcpErrorBody.code, code);
    }
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
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function json(url: string, init?: RequestInit): Promise<{ response: Response; body: any }> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  return { response, body: await response.json() };
}

async function mcp(baseUrl: string, id: number, method: string, params?: unknown): Promise<any> {
  const result = await json(`${baseUrl}/_questboard/mcp-proxy`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-questboard-daemon-client": "1" },
    body: JSON.stringify({
      sessionId: "code-map-continuation-boundary",
      message: { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) },
    }),
  });
  assert.equal(result.response.status, 200);
  return result.body;
}
