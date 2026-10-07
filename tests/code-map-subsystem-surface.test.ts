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
