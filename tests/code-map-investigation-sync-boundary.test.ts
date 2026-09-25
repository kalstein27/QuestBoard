import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  CODE_GRAPH_SCHEMA_VERSION,
  CodeMapInvestigationSyncService,
  CodeMapService,
  createQuestBoardHttpServer,
  QuestBoardService,
  SqliteQuestBoardRepository,
  type ActorRef,
  type CodeGraphSnapshot,
  type CodeIndexRequest,
  type CodeIntelligenceProvider,
} from "../src/index.js";

const actor: ActorRef = { id: "agent:sync-boundary", provider: "test" };

class BoundaryCodeMapProvider implements CodeIntelligenceProvider {
  readonly capabilities = {
    incrementalIndexing: false,
    impactAnalysis: true,
    callTrace: true,
  } as const;

  calls = 0;

  async indexProject(request: CodeIndexRequest): Promise<CodeGraphSnapshot> {
    this.calls += 1;
    return {
      schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
      projectId: request.projectId,
      rootPath: request.rootPath,
      indexedAt: `2026-09-24T11:2${this.calls}:00.000Z`,
      nodes: [
        {
          id: "service-node",
          kind: "method",
          name: "createTask",
          canonicalIdentity: "QuestBoardService.createTask",
          location: { path: "src/application/quest-board-service.ts", startLine: 1 },
        },
      ],
      relations: [],
    };
  }
}

test("HTTP and MCP share one Code Map sync cache and stable error contract", async () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  const project = service.createProject(
    { name: "Sync boundary", rootPath: "/workspace/sync-boundary" },
    actor,
  );
  const provider = new BoundaryCodeMapProvider();
  const codeMapService = new CodeMapService(provider);
  const syncService = new CodeMapInvestigationSyncService(codeMapService, repository);
  const server = createQuestBoardHttpServer(service, {
    codeMapService,
    codeMapInvestigationSyncService: syncService,
  });

  try {
    await listen(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const codeMapUrl = `${baseUrl}/projects/${encodeURIComponent(project.id)}/code-map`;
    const previewUrl = `${codeMapUrl}/investigation-sync/preview`;
    const applyUrl = `${codeMapUrl}/investigation-sync/apply`;

    const beforeIndex = await json(previewUrl, { method: "POST" });
    assert.equal(beforeIndex.response.status, 409);
    assert.equal(beforeIndex.body.error.code, "code_map_not_indexed");

    const indexed = await json(codeMapUrl, { method: "POST" });
    assert.equal(indexed.response.status, 200);
    assert.equal(provider.calls, 1);

    const preview = await json(previewUrl, { method: "POST" });
    assert.equal(preview.response.status, 200);
    assert.equal(preview.body.preview.nodes[0]?.state, "create");
    const fingerprint = preview.body.preview.projectionFingerprint as string;

    const toolsList = await json(`${baseUrl}/_questboard/mcp-proxy`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-questboard-daemon-client": "1" },
      body: JSON.stringify({
        sessionId: "sync-boundary-session",
        message: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      }),
    });
    const toolNames = (toolsList.body.result.tools as Array<{ name: string }>).map((tool) => tool.name);
    assert.ok(toolNames.includes("questboard_preview_code_map_investigation_sync"));
    assert.ok(toolNames.includes("questboard_apply_code_map_investigation_sync"));

    const mcpApply = await json(`${baseUrl}/_questboard/mcp-proxy`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-questboard-daemon-client": "1" },
      body: JSON.stringify({
        sessionId: "sync-boundary-session",
        message: {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "questboard_apply_code_map_investigation_sync",
            arguments: {
              projectId: project.id,
              expectedProjectionFingerprint: fingerprint,
              actor,
            },
          },
        },
      }),
    });
    assert.equal(mcpApply.response.status, 200);
    const mcpContent = mcpApply.body.result.content as Array<{ text: string }>;
    const mcpPayload = JSON.parse(mcpContent[0]?.text ?? "{}") as {
      result: { counts: { createdNodes: number } };
    };
    assert.equal(mcpPayload.result.counts.createdNodes, 1);

    const afterMcpApply = await json(previewUrl, { method: "POST" });
    assert.equal(afterMcpApply.body.preview.nodes[0]?.state, "unchanged");
    assert.equal(service.getInvestigationGraph(project.id).nodes.length, 1);

    const missingRequestId = await json(applyUrl, {
      method: "POST",
      headers: actorHeaders(),
      body: JSON.stringify({ expectedProjectionFingerprint: fingerprint }),
    });
    assert.equal(missingRequestId.response.status, 400);
    assert.equal(missingRequestId.body.error.code, "bad_request");

    const reindexed = await json(codeMapUrl, { method: "POST" });
    assert.equal(reindexed.response.status, 200);
    assert.equal(provider.calls, 2);

    const staleApply = await json(applyUrl, {
      method: "POST",
      headers: { ...actorHeaders(), "x-questboard-request-id": "sync-stale-apply-0001" },
      body: JSON.stringify({ expectedProjectionFingerprint: fingerprint }),
    });
    assert.equal(staleApply.response.status, 409);
    assert.equal(staleApply.body.error.code, "code_map_sync_preview_stale");

    const currentPreview = await json(previewUrl, { method: "POST" });
    const currentFingerprint = currentPreview.body.preview.projectionFingerprint as string;
    const generatedNodeId = service.getInvestigationGraph(project.id).nodes[0]!.id;
    service.deleteInvestigationNode(generatedNodeId, actor);

    const detachedPreview = await json(previewUrl, { method: "POST" });
    assert.equal(detachedPreview.body.preview.nodes[0]?.state, "detached");

    const detachedApply = await json(applyUrl, {
      method: "POST",
      headers: { ...actorHeaders(), "x-questboard-request-id": "sync-detached-apply-0001" },
      body: JSON.stringify({ expectedProjectionFingerprint: currentFingerprint }),
    });
    assert.equal(detachedApply.response.status, 409);
    assert.equal(detachedApply.body.error.code, "code_map_sync_detached_requires_confirmation");

    const recreated = await json(applyUrl, {
      method: "POST",
      headers: { ...actorHeaders(), "x-questboard-request-id": "sync-detached-apply-0002" },
      body: JSON.stringify({
        expectedProjectionFingerprint: currentFingerprint,
        recreateDetached: true,
      }),
    });
    assert.equal(recreated.response.status, 200);
    assert.equal(recreated.body.result.counts.createdNodes, 1);
    assert.equal(service.getInvestigationGraph(project.id).nodes.length, 1);
  } finally {
    await closeServer(server);
    repository.close();
  }
});

function actorHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-questboard-actor-id": actor.id,
    "x-questboard-actor-provider": actor.provider,
  };
}

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
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function json(
  url: string,
  options: RequestInit = {},
): Promise<{ response: Response; body: any }> {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}
