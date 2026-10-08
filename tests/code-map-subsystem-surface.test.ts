import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  CODE_GRAPH_SCHEMA_VERSION,
  CodeMapService,
  createQuestBoardHttpServer,
  QuestBoardService,
  SqliteQuestBoardRepository,
  type ActorRef,
  type CodeGraphSnapshot,
  type CodeIndexRequest,
  type CodeIntelligenceProvider,
} from "../src/index.js";

const human: ActorRef = { id: "human:owner", provider: "human" };

class SubsystemSurfaceProvider implements CodeIntelligenceProvider {
  readonly providerId = "phase7-a3-provider";
  readonly capabilities = {
    incrementalIndexing: false,
    impactAnalysis: true,
    callTrace: true,
  } as const;

  async indexProject(request: CodeIndexRequest): Promise<CodeGraphSnapshot> {
    return {
      schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
      projectId: request.projectId,
      rootPath: request.rootPath,
      indexedAt: "2026-10-07T07:29:17.346Z",
      nodes: [
        {
          id: "code:node:http-entry",
          kind: "function",
          name: "createHttpServer",
          canonicalIdentity: "scip:src/server/http.ts#createHttpServer",
          language: "typescript",
          location: { path: "src/server/http.ts", startLine: 354 },
        },
        {
          id: "code:node:runtime-record",
          kind: "method",
          name: "record",
          canonicalIdentity: "scip:src/runtime/connection-diagnostics.ts#record",
          language: "typescript",
          location: { path: "src/runtime/connection-diagnostics.ts", startLine: 155 },
        },
        {
          id: "code:node:handler",
          kind: "function",
          name: "managed_mcp_update",
          canonicalIdentity: "source-registration:src/server/tools.ts:registerTool:managed_mcp_update:11304",
          language: "typescript",
          location: { path: "src/server/tools.ts", startLine: 11304 },
        },
        {
          id: "code:node:with-error",
          kind: "function",
          name: "withErrorMapping",
          canonicalIdentity: "scip:src/server/tools.ts#withErrorMapping",
          language: "typescript",
          location: { path: "src/server/tools.ts", startLine: 4200 },
        },
        {
          id: "code:node:register-tools",
          kind: "function",
          name: "registerTools",
          canonicalIdentity: "scip:src/server/tools.ts#registerTools",
          language: "typescript",
          location: { path: "src/server/tools.ts", startLine: 4545 },
        },
        {
          id: "code:node:update-managed",
          kind: "function",
          name: "updateManagedMcp",
          canonicalIdentity: "scip:src/mcp/managed-mcp.ts#updateManagedMcp",
          language: "typescript",
          location: { path: "src/mcp/managed-mcp.ts", startLine: 811 },
        },
      ],
      relations: [
        {
          id: "code:relation:http-runtime",
          from: "code:node:http-entry",
          to: "code:node:runtime-record",
          kind: "calls",
          confidence: 1,
          evidence: [{
            location: { path: "src/server/http.ts", startLine: 421 },
            label: "SCIP-resolved direct call",
          }],
        },
        {
          id: "code:relation:handler-with-error",
          from: "code:node:handler",
          to: "code:node:with-error",
          kind: "calls",
          confidence: 1,
          evidence: [{
            location: { path: "src/server/tools.ts", startLine: 11319 },
            label: "SCIP-resolved direct handler call",
          }],
        },
        {
          id: "code:relation:outer-update",
          from: "code:node:register-tools",
          to: "code:node:update-managed",
          kind: "calls",
          confidence: 1,
          evidence: [{
            location: { path: "src/server/tools.ts", startLine: 11327 },
            label: "SCIP-resolved nested callback call",
          }],
        },
      ],
    };
  }
}

class SubsystemDiscoveryProvider implements CodeIntelligenceProvider {
  readonly providerId = "phase8-a3-discovery-provider";
  readonly capabilities = {
    incrementalIndexing: false,
    impactAnalysis: false,
    callTrace: true,
  } as const;

  #generation = 0;
  constructor(private readonly sameIndexedAt = false) {}

  async indexProject(request: CodeIndexRequest): Promise<CodeGraphSnapshot> {
    this.#generation += 1;
    const nodes = Array.from({ length: 14 }, (_, index) => ({
      id: `code:node:p${index.toString().padStart(2, "0")}`,
      kind: "function" as const,
      name: `handler${index}`,
      canonicalIdentity: `scip:src/p${index.toString().padStart(2, "0")}/index.ts#handler${index}().`,
      language: "typescript",
      location: {
        path: `src/p${index.toString().padStart(2, "0")}/index.ts`,
        startLine: 1,
      },
    }));
    const relations = Array.from({ length: 6 }, (_, fromIndex) =>
      Array.from({ length: 6 }, (_, toIndex) => ({ fromIndex, toIndex })))
      .flat()
      .filter(({ fromIndex, toIndex }) => fromIndex !== toIndex)
      .map(({ fromIndex, toIndex }) => ({
        id: `code:relation:p${fromIndex.toString().padStart(2, "0")}-p${toIndex.toString().padStart(2, "0")}`,
        from: `code:node:p${fromIndex.toString().padStart(2, "0")}`,
        to: `code:node:p${toIndex.toString().padStart(2, "0")}`,
        kind: "calls" as const,
        confidence: 1,
        evidence: [{
          location: {
            path: `src/p${fromIndex.toString().padStart(2, "0")}/index.ts`,
            startLine: toIndex + 2,
          },
          label: "raw direct call",
        }],
      }));
    const reverse = this.#generation % 2 === 0;
    return {
      schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
      projectId: request.projectId,
      rootPath: request.rootPath,
      indexedAt: this.#generation === 1 || this.sameIndexedAt
        ? "2026-10-07T14:00:00.000Z"
        : "2026-10-07T14:01:00.000Z",
      nodes: reverse ? [...nodes].reverse() : nodes,
      relations: this.sameIndexedAt && reverse
        ? relations.map((relation, index) => index === 0 ? { ...relation, confidence: 0.75 } : relation)
        : reverse ? [...relations].reverse() : relations,
    };
  }
}

test("HTTP and MCP expose the same bounded subsystem contract without a full raw graph", async () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  const project = service.createProject(
    { name: "Phase 7 A3", rootPath: "/workspace/phase7-a3" },
    human,
  );
  const codeMapService = new CodeMapService(new SubsystemSurfaceProvider());
  await codeMapService.refresh({ projectId: project.id, rootPath: project.rootPath! });
  const server = createQuestBoardHttpServer(service, { codeMapService });

  try {
    await listen(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const subsystemUrl =
      `${baseUrl}/projects/${encodeURIComponent(project.id)}/code-map/subsystems`;

    const http = await json(subsystemUrl);
    assert.equal(http.response.status, 200);
    assert.ok(http.body.subsystems);
    assert.equal("graph" in http.body, false);
    assert.equal(http.body.subsystems.caps.subsystems, 12);
    assert.equal(http.body.subsystems.caps.relations, 24);
    assert.equal(http.body.subsystems.caps.relationEvidence, 16);
    assert.ok(http.body.subsystems.nodes.every(
      (entry: { id: string }) => entry.id.startsWith("code-subsystem:node:"),
    ));

    const tools = await mcp(baseUrl, 1, "tools/list");
    const toolNames = (tools.result.tools as Array<{ name: string }>).map((tool) => tool.name);
    assert.ok(toolNames.includes("questboard_get_code_map_subsystems"));

    const mcpCall = await mcp(baseUrl, 2, "tools/call", {
      name: "questboard_get_code_map_subsystems",
      arguments: { projectId: project.id },
    });
    const content = mcpCall.result.content as Array<{ text: string }>;
    const mcpPayload = JSON.parse(content[0]?.text ?? "{}");
    assert.deepEqual(mcpPayload.subsystems, http.body.subsystems);

    const serverSubsystem = http.body.subsystems.nodes.find(
      (entry: { pathPrefix: string }) => entry.pathPrefix === "src/server",
    );
    const handler = serverSubsystem.notableNodes.find(
      (entry: { rawNodeId: string }) => entry.rawNodeId === "code:node:handler",
    );
    assert.equal(handler.navigation.rawNodeId, "code:node:handler");
    assert.equal(handler.registrationContext, true);

    const serverToMcp = http.body.subsystems.relations.find(
      (entry: { fromPathPrefix: string; toPathPrefix: string; kind: string }) =>
        entry.fromPathPrefix === "src/server"
        && entry.toPathPrefix === "src/mcp"
        && entry.kind === "calls",
    );
    assert.deepEqual(serverToMcp.sourceRelationIds, ["code:relation:outer-update"]);
    assert.equal(
      serverToMcp.evidenceSample.some(
        (entry: { fromNodeId: string }) => entry.fromNodeId === "code:node:handler",
      ),
      false,
    );
  } finally {
    await closeServer(server);
    repository.close();
  }
});

test("subsystem discovery pages the full deterministic universe and pins offset pages to exact snapshot identity", async () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  const project = service.createProject(
    { name: "Phase 8 A3 discovery", rootPath: "/workspace/phase8-a3-discovery" },
    human,
  );
  const provider = new SubsystemDiscoveryProvider();
  const holder: { saved?: unknown } = {};
  const persistence = { store: { load: () => holder.saved, save: (_id: string, value: unknown) => { holder.saved = structuredClone(value); } }, providerConfigFingerprint: "fixture-v1", sourceState: { rootIdentity: (path: string) => `root:${path}`, sourceManifestFingerprint: () => "manifest-v1" }, rootPathForProject: (_id: string) => project.rootPath!, now: () => "2026-10-07T14:00:00.000Z" };
  const codeMapService = new CodeMapService(provider, undefined, undefined, undefined, persistence);
  await codeMapService.refresh({ projectId: project.id, rootPath: project.rootPath! });
  const server = createQuestBoardHttpServer(service, { codeMapService });

  try {
    await listen(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const subsystemUrl = `${baseUrl}/projects/${encodeURIComponent(project.id)}/code-map/subsystems`;
    const queryUrl = `${subsystemUrl}/query`;

    const boundedGet = await json(subsystemUrl);
    assert.equal(boundedGet.response.status, 200);
    assert.equal(boundedGet.body.subsystems.nodes.length, 12);
    assert.equal(boundedGet.body.subsystems.truncation.subsystems.candidateCount, 14);
    assert.equal(boundedGet.body.subsystems.truncation.subsystems.reason, "subsystem_cap");
    assert.equal(boundedGet.body.subsystems.relations.length, 24);
    assert.equal(boundedGet.body.subsystems.truncation.relations.candidateCount, 30);
    assert.equal(boundedGet.body.subsystems.truncation.relations.reason, "relation_cap");

    const firstSubsystemPage = await json(queryUrl, {
      method: "POST",
      body: JSON.stringify({ operation: "list_subsystems" }),
    });
    assert.equal(firstSubsystemPage.response.status, 200);
    assert.equal(firstSubsystemPage.body.query.candidateCount, 14);
    assert.equal(firstSubsystemPage.body.query.returnedCount, 12);
    assert.equal(firstSubsystemPage.body.query.limit, 12);
    assert.equal(firstSubsystemPage.body.query.hasMore, true);
    assert.equal(firstSubsystemPage.body.query.nextOffset, 12);
    assert.equal(firstSubsystemPage.body.query.truncated, true);
    assert.equal(firstSubsystemPage.body.query.reason, "page_cap");
    assert.deepEqual(firstSubsystemPage.body.query.nodes, boundedGet.body.subsystems.nodes);
    const pinnedIndexedAt = firstSubsystemPage.body.query.sourceIndexedAt as string;
    const pinnedSnapshotId = firstSubsystemPage.body.query.snapshotId as string;
    assert.ok(pinnedSnapshotId);

    const secondSubsystemPage = await json(queryUrl, {
      method: "POST",
      body: JSON.stringify({
        operation: "list_subsystems",
        offset: 12,
        expectedSourceIndexedAt: pinnedIndexedAt,
        expectedSnapshotId: pinnedSnapshotId,
      }),
    });
    assert.equal(secondSubsystemPage.response.status, 200);
    assert.equal(secondSubsystemPage.body.query.returnedCount, 2);
    assert.equal(secondSubsystemPage.body.query.hasMore, false);
    assert.deepEqual(
      secondSubsystemPage.body.query.nodes.map((entry: { pathPrefix: string }) => entry.pathPrefix),
      ["src/p12", "src/p13"],
    );

    const filtered = await json(queryUrl, {
      method: "POST",
      body: JSON.stringify({ operation: "list_subsystems", pathPrefix: "src/p13" }),
    });
    assert.equal(filtered.response.status, 200);
    assert.equal(filtered.body.query.candidateCount, 1);
    assert.equal(filtered.body.query.nodes[0]?.pathPrefix, "src/p13");

    const firstRelationPage = await json(queryUrl, {
      method: "POST",
      body: JSON.stringify({
        operation: "list_relations",
        fromPathPrefix: "src/p",
        toPathPrefix: "src/p",
        relationKinds: ["calls"],
      }),
    });
    assert.equal(firstRelationPage.response.status, 200);
    assert.equal(firstRelationPage.body.query.candidateCount, 30);
    assert.equal(firstRelationPage.body.query.returnedCount, 24);
    assert.equal(firstRelationPage.body.query.nextOffset, 24);
    assert.equal(firstRelationPage.body.query.reason, "page_cap");
    const secondRelationPage = await json(queryUrl, {
      method: "POST",
      body: JSON.stringify({
        operation: "list_relations",
        relationKinds: ["calls"],
        offset: 24,
        expectedSourceIndexedAt: pinnedIndexedAt,
        expectedSnapshotId: pinnedSnapshotId,
      }),
    });
    assert.equal(secondRelationPage.response.status, 200);
    assert.equal(secondRelationPage.body.query.returnedCount, 6);
    assert.equal(secondRelationPage.body.query.hasMore, false);

    const tools = await mcp(baseUrl, 10, "tools/list");
    const toolNames = (tools.result.tools as Array<{ name: string }>).map((tool) => tool.name);
    assert.ok(toolNames.includes("questboard_query_code_map_subsystems"));
    const mcpSubsystemPage = await mcp(baseUrl, 11, "tools/call", {
      name: "questboard_query_code_map_subsystems",
      arguments: { projectId: project.id, operation: "list_subsystems" },
    });
    const mcpSubsystemPayload = JSON.parse(
      (mcpSubsystemPage.result.content as Array<{ text: string }>)[0]?.text ?? "{}",
    );
    assert.deepEqual(mcpSubsystemPayload.query, firstSubsystemPage.body.query);
    const mcpRelationPage = await mcp(baseUrl, 12, "tools/call", {
      name: "questboard_query_code_map_subsystems",
      arguments: {
        projectId: project.id,
        operation: "list_relations",
        fromPathPrefix: "src/p",
        toPathPrefix: "src/p",
        relationKinds: ["calls"],
      },
    });
    const mcpRelationPayload = JSON.parse(
      (mcpRelationPage.result.content as Array<{ text: string }>)[0]?.text ?? "{}",
    );
    assert.deepEqual(mcpRelationPayload.query, firstRelationPage.body.query);
    const mcpPinnedPage = await mcp(baseUrl, 13, "tools/call", {
      name: "questboard_query_code_map_subsystems",
      arguments: { projectId: project.id, operation: "list_subsystems", offset: 12, expectedSourceIndexedAt: pinnedIndexedAt, expectedSnapshotId: pinnedSnapshotId },
    });
    const mcpPinnedPayload = JSON.parse((mcpPinnedPage.result.content as Array<{ text: string }>)[0]?.text ?? "{}");
    assert.deepEqual(mcpPinnedPayload.query, secondSubsystemPage.body.query);
    const mcpPinnedRelations = await mcp(baseUrl, 14, "tools/call", {
      name: "questboard_query_code_map_subsystems",
      arguments: { projectId: project.id, operation: "list_relations", relationKinds: ["calls"], offset: 24, expectedSourceIndexedAt: pinnedIndexedAt, expectedSnapshotId: pinnedSnapshotId },
    });
    const mcpPinnedRelationsPayload = JSON.parse((mcpPinnedRelations.result.content as Array<{ text: string }>)[0]?.text ?? "{}");
    assert.deepEqual(mcpPinnedRelationsPayload.query, secondRelationPage.body.query);
    const failures: Array<{ invalid: Record<string, unknown>; code: string; status: number }> = [
      { invalid: { operation: "list_subsystems", offset: 12, expectedSourceIndexedAt: pinnedIndexedAt }, code: "code_map_query_invalid", status: 400 },
      { invalid: { operation: "list_subsystems", offset: 12, expectedSnapshotId: pinnedSnapshotId }, code: "code_map_query_invalid", status: 400 },
      { invalid: { operation: "list_subsystems", offset: 12, expectedSourceIndexedAt: pinnedIndexedAt, expectedSnapshotId: "wrong" }, code: "code_map_snapshot_changed", status: 409 },
      { invalid: { operation: "list_relations", offset: 24, expectedSourceIndexedAt: "stale", expectedSnapshotId: pinnedSnapshotId }, code: "code_map_subsystem_snapshot_stale", status: 409 },
    ];
    for (const [index, { invalid, code, status }] of failures.entries()) {
      const httpError = await json(queryUrl, { method: "POST", body: JSON.stringify(invalid) });
      assert.equal(httpError.response.status, status);
      assert.equal(httpError.body.error.code, code);
      const mcpError = await mcp(baseUrl, 20 + index, "tools/call", { name: "questboard_query_code_map_subsystems", arguments: { projectId: project.id, ...invalid } });
      const mcpErrorBody = JSON.parse((mcpError.result.content as Array<{ text: string }>)[0]?.text ?? "{}");
      assert.equal(mcpError.result.isError, true);
      assert.equal(mcpErrorBody.error?.code ?? mcpErrorBody.code, code);
    }

    const firstNodeIds = firstSubsystemPage.body.query.nodes.map((entry: { id: string }) => entry.id);
    const firstRelationIds = firstRelationPage.body.query.relations.map((entry: { id: string }) => entry.id);
    await codeMapService.refresh({ projectId: project.id, rootPath: project.rootPath! });
    const reorderedSubsystemPage = await json(queryUrl, {
      method: "POST",
      body: JSON.stringify({ operation: "list_subsystems" }),
    });
    const reorderedRelationPage = await json(queryUrl, {
      method: "POST",
      body: JSON.stringify({ operation: "list_relations", relationKinds: ["calls"] }),
    });
    assert.deepEqual(
      reorderedSubsystemPage.body.query.nodes.map((entry: { id: string }) => entry.id),
      firstNodeIds,
    );
    assert.deepEqual(
      reorderedRelationPage.body.query.relations.map((entry: { id: string }) => entry.id),
      firstRelationIds,
    );

    const stale = await json(queryUrl, {
      method: "POST",
      body: JSON.stringify({
        operation: "list_subsystems",
        offset: 12,
        expectedSourceIndexedAt: pinnedIndexedAt,
        expectedSnapshotId: pinnedSnapshotId,
      }),
    });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.body.error.code, "code_map_subsystem_snapshot_stale");
  } finally {
    await closeServer(server);
    repository.close();
  }
});

test("subsystem exact page pin rejects a different raw graph at the same indexedAt and unknown identity", async () => {
  const provider = new SubsystemDiscoveryProvider(true);
  const holder: { saved?: unknown } = {};
  const persistence = { store: { load: () => holder.saved, save: (_id: string, value: unknown) => { holder.saved = structuredClone(value); } }, providerConfigFingerprint: "fixture-v1", sourceState: { rootIdentity: (path: string) => `root:${path}`, sourceManifestFingerprint: () => "manifest-v1" }, rootPathForProject: (_id: string) => "/workspace/phase8", now: () => "2026-10-07T14:00:00.000Z" };
  const service = new CodeMapService(provider, undefined, undefined, undefined, persistence);
  await service.refresh({ projectId: "phase8", rootPath: "/workspace/phase8" });
  const first = service.querySourceSubsystems("phase8", { operation: "list_subsystems" });
  assert.ok(first.snapshotId);
  const pinned = { operation: "list_subsystems" as const, offset: 12, expectedSourceIndexedAt: first.sourceIndexedAt, expectedSnapshotId: first.snapshotId };
  assert.equal(service.querySourceSubsystems("phase8", pinned).returnedCount, 2);
  await service.refresh({ projectId: "phase8", rootPath: "/workspace/phase8" });
  const changed = service.querySourceSubsystems("phase8", { operation: "list_subsystems" });
  assert.equal(changed.sourceIndexedAt, first.sourceIndexedAt);
  assert.notEqual(changed.snapshotId, first.snapshotId);
  assert.throws(() => service.querySourceSubsystems("phase8", pinned),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "code_map_snapshot_changed");
  assert.equal(service.querySourceSubsystems("phase8", { ...pinned, expectedSnapshotId: changed.snapshotId! }).returnedCount, 2);

  const unknown = new CodeMapService(new SubsystemDiscoveryProvider());
  await unknown.refresh({ projectId: "unknown", rootPath: "/workspace/unknown" });
  assert.equal(unknown.querySourceSubsystems("unknown", { operation: "list_subsystems" }).snapshotId, undefined);
  assert.throws(() => unknown.querySourceSubsystems("unknown", pinned),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "code_map_snapshot_changed");
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
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function json(
  url: string,
  init?: RequestInit,
): Promise<{ response: Response; body: any }> {
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
    headers: {
      "content-type": "application/json",
      "x-questboard-daemon-client": "1",
    },
    body: JSON.stringify({
      sessionId: "phase7-a3-subsystem-surface",
      message: {
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      },
    }),
  });
  return result.body;
}
