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

class HttpCodeMapProvider implements CodeIntelligenceProvider {
  readonly capabilities = {
    incrementalIndexing: true,
    impactAnalysis: true,
    callTrace: true,
  } as const;

  readonly calls: CodeIndexRequest[] = [];
  fail = false;

  async indexProject(request: CodeIndexRequest): Promise<CodeGraphSnapshot> {
    this.calls.push(request);
    if (this.fail) throw new Error("simulated provider failure");
    return {
      schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
      projectId: request.projectId,
      rootPath: request.rootPath,
      indexedAt: "2026-09-23T00:00:00.000Z",
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

test("Code Map HTTP endpoint exposes availability, indexes on POST, and serves cached projection on GET", async () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  const project = service.createProject(
    { name: "QuestBoard", rootPath: "/workspace/questboard" },
    human,
  );
  const provider = new HttpCodeMapProvider();
  const codeMapService = new CodeMapService(provider);
  const server = createQuestBoardHttpServer(service, { codeMapService });

  try {
    await listen(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const path = `${baseUrl}/projects/${encodeURIComponent(project.id)}/code-map`;

    const before = await json(path);
    assert.equal(before.response.status, 200);
    assert.equal(before.body.enabled, true);
    assert.equal(before.body.available, true);
    assert.equal(before.body.indexed, false);
    assert.equal(before.body.projection, null);

    const indexed = await json(path, { method: "POST" });
    assert.equal(indexed.response.status, 200);
    assert.equal(indexed.body.indexed, true);
    assert.equal(indexed.body.mode, "full");
    assert.equal(indexed.body.projection.nodes[0]?.title, "Application Service");
    assert.equal(indexed.body.graph.nodes[0]?.name, "createTask");
    assert.equal(indexed.body.graph.nodes[0]?.location.path, "src/application/quest-board-service.ts");
    assert.equal(provider.calls.length, 1);

    const cached = await json(path);
    assert.equal(cached.body.indexed, true);
    assert.equal(cached.body.projection.projectId, project.id);
    assert.equal(cached.body.graph.nodes[0]?.canonicalIdentity, "QuestBoardService.createTask");
    assert.equal(provider.calls.length, 1);
  } finally {
    await closeServer(server);
    repository.close();
  }
});

test("Code Map provider failure keeps the last-good cached projection available", async () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  const project = service.createProject(
    { name: "QuestBoard", rootPath: "/workspace/questboard" },
    human,
  );
  const provider = new HttpCodeMapProvider();
  const codeMapService = new CodeMapService(provider);
  const server = createQuestBoardHttpServer(service, { codeMapService });

  try {
    await listen(server);
    const address = server.address() as AddressInfo;
    const path = `http://127.0.0.1:${address.port}/projects/${encodeURIComponent(project.id)}/code-map`;

    const first = await json(path, { method: "POST" });
    assert.equal(first.response.status, 200);
    assert.equal(first.body.indexed, true);
    const lastGood = first.body.projection;

    provider.fail = true;
    const failed = await json(path, { method: "POST" });
    assert.equal(failed.response.status, 503);
    assert.equal(failed.body.error.code, "code_map_provider_failed");
    assert.equal(failed.body.indexed, true);
    assert.deepEqual(failed.body.projection, lastGood);
    assert.equal(failed.body.graph.nodes[0]?.name, "createTask");

    const cached = await json(path);
    assert.equal(cached.response.status, 200);
    assert.equal(cached.body.indexed, true);
    assert.deepEqual(cached.body.projection, lastGood);
  } finally {
    await closeServer(server);
    repository.close();
  }
});

test("Code Map HTTP endpoint stays explicitly unavailable when runtime integration is disabled", async () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  const project = service.createProject(
    { name: "QuestBoard", rootPath: "/workspace/questboard" },
    human,
  );
  const server = createQuestBoardHttpServer(service);

  try {
    await listen(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const result = await json(`${baseUrl}/projects/${encodeURIComponent(project.id)}/code-map`);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.enabled, false);
    assert.equal(result.body.available, false);
    assert.equal(result.body.indexed, false);
  } finally {
    await closeServer(server);
    repository.close();
  }
});

test("Code Map HTTP exposes configured-but-unavailable provider setup without breaking QuestBoard", async () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  const project = service.createProject(
    { name: "QuestBoard", rootPath: "/workspace/questboard" },
    human,
  );
  const server = createQuestBoardHttpServer(service, {
    codeMapAvailability: {
      enabled: true,
      available: false,
      provider: "scip-typescript",
      reason: "missing_executable",
      message: "Install SCIP tools or configure their executable paths.",
      missingExecutables: ["scip-typescript", "scip"],
    },
  });

  try {
    await listen(server);
    const address = server.address() as AddressInfo;
    const path = `http://127.0.0.1:${address.port}/projects/${encodeURIComponent(project.id)}/code-map`;
    const status = await json(path);
    assert.equal(status.response.status, 200);
    assert.equal(status.body.enabled, true);
    assert.equal(status.body.available, false);
    assert.equal(status.body.provider, "scip-typescript");
    assert.equal(status.body.reason, "missing_executable");
    assert.deepEqual(status.body.missingExecutables, ["scip-typescript", "scip"]);

    const index = await json(path, { method: "POST" });
    assert.equal(index.response.status, 503);
    assert.equal(index.body.error.code, "code_map_unavailable");
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
