import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  CODE_GRAPH_SCHEMA_VERSION,
  CodeMapService,
  createQuestBoardHttpServer,
  createQuestBoardMcpHandler,
  executeQuestBoardAgentTool,
  QuestBoardService,
  SqliteQuestBoardRepository,
  type ActorRef,
  type CodeGraphSnapshot,
  type CodeIndexRequest,
  type CodeIntelligenceProvider,
} from "../src/index.js";

const human: ActorRef = { id: "human:owner", provider: "human" };

class LifecycleProvider implements CodeIntelligenceProvider {
  readonly providerId = "fixture-code-map";
  readonly capabilities = {
    incrementalIndexing: false,
    impactAnalysis: false,
    callTrace: true,
  } as const;
  readonly calls: CodeIndexRequest[] = [];
  fail = false;
  #gate: { promise: Promise<void>; resolve: () => void } | undefined;

  pause(): void {
    if (this.#gate) return;
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    this.#gate = { promise, resolve };
  }

  resume(): void {
    const gate = this.#gate;
    this.#gate = undefined;
    gate?.resolve();
  }

  async indexProject(request: CodeIndexRequest): Promise<CodeGraphSnapshot> {
    this.calls.push(request);
    const gate = this.#gate;
    if (gate) await gate.promise;
    if (this.fail) throw new Error("simulated lifecycle provider failure");
    return {
      schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
      projectId: request.projectId,
      rootPath: request.rootPath,
      indexedAt: `2026-09-29T08:00:0${this.calls.length}.000Z`,
      nodes: [
        {
          id: "file:src/main.ts",
          kind: "file",
          name: "main.ts",
          canonicalIdentity: "src/main.ts",
          language: "typescript",
          location: { path: "src/main.ts" },
        },
        {
          id: "symbol:main",
          kind: "function",
          name: "main",
          canonicalIdentity: "main",
          language: "typescript",
          location: { path: "src/main.ts", startLine: 1 },
        },
      ],
      relations: [
        {
          id: "contains:main",
          from: "file:src/main.ts",
          to: "symbol:main",
          kind: "contains",
          confidence: 1,
        },
      ],
    };
  }
}

test("agent Code Map lifecycle starts bounded jobs, reuses in-flight refresh, and exposes terminal status", async () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  const project = service.createProject({ name: "Lifecycle", rootPath: "/workspace/lifecycle" }, human);
  const provider = new LifecycleProvider();
  const codeMapService = new CodeMapService(provider);
  const runtime = { service, codeMapService };

  try {
    const before = executeQuestBoardAgentTool(runtime, "questboard_get_code_map_status", {
      projectId: project.id,
    }) as { codeMap: Record<string, unknown> };
    assert.equal(before.codeMap.enabled, true);
    assert.equal(before.codeMap.available, true);
    assert.equal(before.codeMap.rootPathConfigured, true);
    assert.equal(before.codeMap.indexed, false);
    assert.equal("rootPath" in before.codeMap, false, "status must not expose the local absolute project path");

    provider.pause();
    const first = executeQuestBoardAgentTool(runtime, "questboard_refresh_code_map", {
      projectId: project.id,
    }) as { refresh: Record<string, unknown> };
    assert.equal(first.refresh.provider, "fixture-code-map");
    assert.equal(first.refresh.state, "running");
    assert.equal(first.refresh.phase, "queued");
    assert.equal(typeof first.refresh.jobId, "string");
    assert.equal("graph" in first.refresh, false, "refresh receipt must stay bounded");

    await Promise.resolve();
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0]?.rootPath, "/workspace/lifecycle");

    const second = executeQuestBoardAgentTool(runtime, "questboard_refresh_code_map", {
      projectId: project.id,
    }) as { refresh: Record<string, unknown> };
    assert.equal(second.refresh.jobId, first.refresh.jobId, "an in-flight refresh should be reused");
    assert.equal(provider.calls.length, 1);

    const running = executeQuestBoardAgentTool(runtime, "questboard_get_code_map_refresh_status", {
      projectId: project.id,
    }) as { refresh: Record<string, unknown> };
    assert.equal(running.refresh.state, "running");
    assert.equal(running.refresh.phase, "indexing");

    provider.resume();
    const completed = await waitForRefreshJob(codeMapService, project.id, "succeeded");
    assert.equal(completed.mode, "full");
    assert.equal(completed.nodeCount, 2);
    assert.equal(completed.relationCount, 1);
    assert.equal(completed.changedCodeNodeCount, 2);

    const after = executeQuestBoardAgentTool(runtime, "questboard_get_code_map_status", {
      projectId: project.id,
    }) as { codeMap: Record<string, unknown> };
    assert.equal(after.codeMap.indexed, true);
    assert.equal(after.codeMap.nodeCount, 2);
    assert.equal(after.codeMap.relationCount, 1);
    assert.equal(after.codeMap.indexedAt, "2026-09-29T08:00:01.000Z");

    const third = executeQuestBoardAgentTool(runtime, "questboard_refresh_code_map", {
      projectId: project.id,
    }) as { refresh: Record<string, unknown> };
    assert.notEqual(third.refresh.jobId, first.refresh.jobId, "a terminal job should allow a fresh full reindex");
    await waitForRefreshJob(codeMapService, project.id, "succeeded", third.refresh.jobId as string);
    assert.equal(provider.calls.length, 2);
  } finally {
    repository.close();
  }
});

test("MCP and bounded HTTP lifecycle routes share the agent Code Map refresh semantics", async () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  const mcpProject = service.createProject({ name: "MCP lifecycle", rootPath: "/workspace/mcp" }, human);
  const httpProject = service.createProject({ name: "HTTP lifecycle", rootPath: "/workspace/http" }, human);
  const missingRootProject = service.createProject({ name: "Missing root" }, human);
  const provider = new LifecycleProvider();
  const codeMapService = new CodeMapService(provider);
  const runtime = { service, codeMapService };
  const handler = createQuestBoardMcpHandler(runtime, "code-map-lifecycle-session");
  const server = createQuestBoardHttpServer(service, { codeMapService });

  try {
    const listed = handler.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) as {
      result: { tools: Array<{ name: string }> };
    };
    assert.ok(listed.result.tools.some((tool) => tool.name === "questboard_get_code_map_status"));
    assert.ok(listed.result.tools.some((tool) => tool.name === "questboard_refresh_code_map"));
    assert.ok(listed.result.tools.some((tool) => tool.name === "questboard_get_code_map_refresh_status"));

    const mcpRefresh = await handler.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "questboard_refresh_code_map",
        arguments: { projectId: mcpProject.id, rootPath: "/sensitive/override-must-be-ignored" },
      },
    }) as { result: { structuredContent: { refresh: Record<string, unknown> }; isError?: boolean } };
    assert.equal(mcpRefresh.result.isError, undefined);
    assert.equal(mcpRefresh.result.structuredContent.refresh.state, "running");
    assert.equal(typeof mcpRefresh.result.structuredContent.refresh.jobId, "string");
    await waitForRefreshJob(codeMapService, mcpProject.id, "succeeded");
    assert.equal(provider.calls.at(-1)?.rootPath, "/workspace/mcp", "raw MCP arguments must not override the canonical Project rootPath");

    await listen(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const statusBefore = await json(`${baseUrl}/projects/${encodeURIComponent(httpProject.id)}/code-map/status`);
    assert.equal(statusBefore.response.status, 200);
    assert.equal(statusBefore.body.codeMap.indexed, false);
    assert.equal(statusBefore.body.codeMap.rootPathConfigured, true);

    const httpRefresh = await json(`${baseUrl}/projects/${encodeURIComponent(httpProject.id)}/code-map/refresh`, {
      method: "POST",
    });
    assert.equal(httpRefresh.response.status, 202);
    assert.equal(httpRefresh.body.refresh.state, "running");
    assert.equal(typeof httpRefresh.body.refresh.jobId, "string");
    assert.equal("graph" in httpRefresh.body.refresh, false);

    await waitForRefreshJob(codeMapService, httpProject.id, "succeeded");
    const httpRefreshStatus = await json(`${baseUrl}/projects/${encodeURIComponent(httpProject.id)}/code-map/refresh`);
    assert.equal(httpRefreshStatus.response.status, 200);
    assert.equal(httpRefreshStatus.body.refresh.state, "succeeded");
    assert.equal(httpRefreshStatus.body.refresh.nodeCount, 2);
    assert.equal(httpRefreshStatus.body.refresh.relationCount, 1);

    const statusAfter = await json(`${baseUrl}/projects/${encodeURIComponent(httpProject.id)}/code-map/status`);
    assert.equal(statusAfter.body.codeMap.indexed, true);
    assert.equal(statusAfter.body.codeMap.nodeCount, 2);

    const missingRoot = await json(`${baseUrl}/projects/${encodeURIComponent(missingRootProject.id)}/code-map/refresh`, {
      method: "POST",
    });
    assert.equal(missingRoot.response.status, 409);
    assert.equal(missingRoot.body.error.code, "code_map_root_missing");

    provider.fail = true;
    const failedMcpRefresh = await handler.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "questboard_refresh_code_map",
        arguments: { projectId: mcpProject.id },
      },
    }) as { result: { structuredContent: { refresh: Record<string, unknown> }; isError?: boolean } };
    assert.equal(failedMcpRefresh.result.isError, undefined);
    assert.equal(failedMcpRefresh.result.structuredContent.refresh.state, "running");
    const failed = await waitForRefreshJob(codeMapService, mcpProject.id, "failed");
    assert.equal(failed.error?.code, "refresh_failed");
  } finally {
    await closeServer(server);
    repository.close();
  }
});

async function waitForRefreshJob(
  service: CodeMapService,
  projectId: string,
  state: "succeeded" | "failed",
  jobId?: string,
): Promise<NonNullable<ReturnType<CodeMapService["refreshJob"]>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const receipt = service.refreshJob(projectId);
    if (receipt?.state === state && (!jobId || receipt.jobId === jobId)) return receipt;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for Code Map refresh job ${projectId} to reach ${state}`);
}

async function listen(server: ReturnType<typeof createQuestBoardHttpServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
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
  options: RequestInit = {},
): Promise<{ response: Response; body: any }> {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}
