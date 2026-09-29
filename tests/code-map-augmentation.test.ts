import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  CODE_GRAPH_SCHEMA_VERSION,
  CodeMapAugmentationService,
  CodeMapService,
  createQuestBoardHttpServer,
  createQuestBoardMcpHandler,
  EntityRevisionConflictError,
  executeQuestBoardAgentTool,
  MutationRequestConflictError,
  QuestBoardService,
  SqliteQuestBoardRepository,
  type ActorRef,
  type CodeGraphSnapshot,
  type CodeIndexRequest,
  type CodeIntelligenceProvider,
} from "../src/index.js";

const owner: ActorRef = { id: "human:owner", provider: "human" };
const agent: ActorRef = { id: "agent:manual-map", provider: "test-agent" };

class MutableAugmentationProvider implements CodeIntelligenceProvider {
  readonly providerId = "augmentation-provider";
  readonly capabilities = { incrementalIndexing: false, impactAnalysis: false, callTrace: true } as const;
  includeTarget = true;
  targetIdentity = "symbol:target";
  index = 0;

  async indexProject(request: CodeIndexRequest): Promise<CodeGraphSnapshot> {
    this.index += 1;
    return {
      schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
      projectId: request.projectId,
      rootPath: request.rootPath,
      indexedAt: `2026-09-29T00:00:0${this.index}.000Z`,
      nodes: [
        {
          id: "source-node",
          kind: "function",
          name: "source",
          canonicalIdentity: "symbol:source",
          language: "typescript",
          location: { path: "src/source.ts", startLine: 1 },
          provenance: [{ providerId: this.providerId, freshness: "fresh" }],
        },
        ...(this.includeTarget
          ? [{
              id: "target-node",
              kind: "function" as const,
              name: "target",
              canonicalIdentity: this.targetIdentity,
              language: "typescript",
              location: { path: "src/target.ts", startLine: 1 },
              provenance: [{ providerId: this.providerId, freshness: "fresh" as const }],
            }]
          : []),
      ],
      relations: [],
    };
  }
}

function createFixture(repository = new SqliteQuestBoardRepository()) {
  const service = new QuestBoardService(repository);
  const project = service.createProject(
    { name: "Manual Code Map", rootPath: "/workspace/manual-code-map" },
    owner,
  );
  const provider = new MutableAugmentationProvider();
  const codeMapService = new CodeMapService(provider, undefined, undefined, repository);
  const augmentationService = new CodeMapAugmentationService(codeMapService, repository);
  return { repository, service, project, provider, codeMapService, augmentationService };
}

test("manual Code Map relations stay separate from raw facts, participate in bounded queries, and become stale without fuzzy relinking", async () => {
  const fixture = createFixture();
  const { repository, service, project, provider, codeMapService, augmentationService } = fixture;
  try {
    await codeMapService.refresh({ projectId: project.id, rootPath: project.rootPath! });
    const created = augmentationService.create(
      {
        projectId: project.id,
        fromCodeNodeId: "source-node",
        toCodeNodeId: "target-node",
        relationKind: "calls",
        label: "Runtime call",
        rationale: "Observed while tracing the request path",
      },
      agent,
      { requestId: "manual-create-0001" },
    );

    assert.equal(created.state, "active");
    assert.equal(created.provenance, "manual");
    assert.equal(created.revision, 1);
    assert.deepEqual(codeMapService.getCached(project.id)?.graph.relations, []);

    const outgoing = codeMapService.query(project.id, {
      operation: "relations",
      nodeId: "source-node",
      direction: "outgoing",
    });
    assert.equal(outgoing.operation, "relations");
    assert.deepEqual(outgoing.entries.map((entry) => entry.node.id), ["target-node"]);
    assert.equal(outgoing.entries[0]?.relation.id, `manual:${created.id}`);
    assert.deepEqual(outgoing.entries[0]?.relation.provenance, [{ providerId: "manual", freshness: "fresh" }]);

    const incoming = codeMapService.query(project.id, {
      operation: "relations",
      nodeId: "target-node",
      direction: "incoming",
    });
    assert.equal(incoming.operation, "relations");
    assert.deepEqual(incoming.entries.map((entry) => entry.node.id), ["source-node"]);

    const replay = augmentationService.create(
      {
        projectId: project.id,
        fromCodeNodeId: "source-node",
        toCodeNodeId: "target-node",
        relationKind: "calls",
        label: "Runtime call",
        rationale: "Observed while tracing the request path",
      },
      agent,
      { requestId: "manual-create-0001" },
    );
    assert.equal(replay.id, created.id);
    assert.equal(repository.listCodeMapManualRelations(project.id).length, 1);
    assert.throws(
      () => augmentationService.create(
        {
          projectId: project.id,
          fromCodeNodeId: "source-node",
          toCodeNodeId: "target-node",
          relationKind: "calls",
          rationale: "Different input under the same request id",
        },
        agent,
        { requestId: "manual-create-0001" },
      ),
      MutationRequestConflictError,
    );

    const updated = augmentationService.update(
      created.id,
      { expectedRevision: 1, label: "Confirmed runtime call" },
      agent,
      { requestId: "manual-update-0001" },
    );
    assert.equal(updated.revision, 2);
    assert.equal(updated.label, "Confirmed runtime call");
    assert.throws(
      () => augmentationService.update(created.id, { expectedRevision: 1, label: "stale writer" }, agent),
      EntityRevisionConflictError,
    );

    await codeMapService.refresh({ projectId: project.id, rootPath: project.rootPath! });
    assert.equal(augmentationService.list(project.id)[0]?.state, "active");

    const otherProject = service.createProject(
      { name: "Other", rootPath: "/workspace/other" },
      owner,
    );
    await codeMapService.refresh({ projectId: otherProject.id, rootPath: otherProject.rootPath! });
    assert.deepEqual(augmentationService.list(otherProject.id), []);

    provider.includeTarget = false;
    await codeMapService.refresh({ projectId: project.id, rootPath: project.rootPath! });
    const stale = augmentationService.list(project.id)[0]!;
    assert.equal(stale.state, "stale");
    assert.equal(stale.staleReason, "to_missing");
    const afterRemoval = codeMapService.query(project.id, {
      operation: "relations",
      nodeId: "source-node",
      direction: "outgoing",
    });
    assert.equal(afterRemoval.operation, "relations");
    assert.deepEqual(afterRemoval.entries, []);
    assert.deepEqual(codeMapService.getCached(project.id)?.graph.relations, []);

    assert.deepEqual(
      augmentationService.delete(created.id, agent, { expectedRevision: 2, requestId: "manual-delete-0001" }),
      { deleted: true, relationId: created.id },
    );
    assert.deepEqual(repository.listCodeMapManualRelations(project.id), []);
  } finally {
    repository.close();
  }
});

test("manual Code Map relations survive SQLite repository restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "questboard-code-map-augmentation-"));
  const databasePath = join(directory, "questboard.sqlite");
  let relationId = "";
  let projectId = "";
  try {
    {
      const repository = new SqliteQuestBoardRepository(databasePath);
      const service = new QuestBoardService(repository);
      const project = service.createProject(
        { name: "Persistent manual map", rootPath: "/workspace/persistent-map" },
        owner,
      );
      projectId = project.id;
      const provider = new MutableAugmentationProvider();
      const codeMapService = new CodeMapService(provider, undefined, undefined, repository);
      const augmentationService = new CodeMapAugmentationService(codeMapService, repository);
      await codeMapService.refresh({ projectId, rootPath: project.rootPath! });
      relationId = augmentationService.create(
        {
          projectId,
          fromCodeNodeId: "source-node",
          toCodeNodeId: "target-node",
          relationKind: "depends_on",
          rationale: "Persist this manual evidence",
        },
        agent,
        { requestId: "restart-create-0001" },
      ).id;
      repository.close();
    }

    {
      const repository = new SqliteQuestBoardRepository(databasePath);
      const service = new QuestBoardService(repository);
      const project = service.getProject(projectId);
      const provider = new MutableAugmentationProvider();
      const codeMapService = new CodeMapService(provider, undefined, undefined, repository);
      const augmentationService = new CodeMapAugmentationService(codeMapService, repository);
      await codeMapService.refresh({ projectId, rootPath: project.rootPath! });
      const relations = augmentationService.list(projectId);
      assert.equal(relations.length, 1);
      assert.equal(relations[0]?.id, relationId);
      assert.equal(relations[0]?.state, "active");
      assert.equal(relations[0]?.rationale, "Persist this manual evidence");
      repository.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("agent and MCP augmentation tools share the service and MCP auto-request ids make exact mutation retries idempotent", async () => {
  const fixture = createFixture();
  const { repository, project, codeMapService, augmentationService, service } = fixture;
  try {
    await codeMapService.refresh({ projectId: project.id, rootPath: project.rootPath! });
    const runtime = { service, codeMapService, codeMapAugmentationService: augmentationService };
    const created = executeQuestBoardAgentTool(runtime, "questboard_create_code_map_manual_relation", {
      projectId: project.id,
      fromCodeNodeId: "source-node",
      toCodeNodeId: "target-node",
      relationKind: "calls",
      rationale: "Agent-observed edge",
      requestId: "agent-manual-create-0001",
      actor: agent,
    }) as { manualRelation: { id: string; provenance: string } };
    assert.equal(created.manualRelation.provenance, "manual");

    const listed = executeQuestBoardAgentTool(runtime, "questboard_list_code_map_manual_relations", {
      projectId: project.id,
    }) as { manualRelations: Array<{ id: string }> };
    assert.deepEqual(listed.manualRelations.map((relation) => relation.id), [created.manualRelation.id]);

    const handler = createQuestBoardMcpHandler(runtime, "manual-augmentation-session");
    const request = {
      jsonrpc: "2.0" as const,
      id: 33,
      method: "tools/call",
      params: {
        name: "questboard_create_code_map_manual_relation",
        arguments: {
          projectId: project.id,
          fromCodeNodeId: "source-node",
          toCodeNodeId: "target-node",
          relationKind: "depends_on",
          rationale: "MCP-observed edge",
          actor: agent,
        },
      },
    };
    const first = handler.handle(request) as { result: { structuredContent: { manualRelation: { id: string } }; isError?: boolean } };
    const replay = handler.handle(request) as { result: { structuredContent: { manualRelation: { id: string } }; isError?: boolean } };
    assert.equal(first.result.isError, undefined);
    assert.equal(replay.result.isError, undefined);
    assert.equal(replay.result.structuredContent.manualRelation.id, first.result.structuredContent.manualRelation.id);
    assert.equal(repository.listCodeMapManualRelations(project.id).length, 2);
  } finally {
    repository.close();
  }
});

test("HTTP exposes manual Code Map mutations and Code Map status includes active manual wiring", async () => {
  const fixture = createFixture();
  const { repository, project, codeMapService, augmentationService, service } = fixture;
  const server = createQuestBoardHttpServer(service, {
    codeMapService,
    codeMapAugmentationService: augmentationService,
  });
  try {
    await listen(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const codeMapUrl = `${baseUrl}/projects/${encodeURIComponent(project.id)}/code-map`;
    const manualUrl = `${codeMapUrl}/manual-relations`;

    assert.equal((await json(codeMapUrl, { method: "POST" })).response.status, 200);
    const created = await json(manualUrl, {
      method: "POST",
      headers: actorHeaders("http-manual-create-0001"),
      body: JSON.stringify({
        fromCodeNodeId: "source-node",
        toCodeNodeId: "target-node",
        relationKind: "calls",
        label: "HTTP manual edge",
        rationale: "Added through the shared HTTP boundary",
      }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.manualRelation.provenance, "manual");
    assert.equal(created.body.manualRelation.state, "active");
    const relationId = created.body.manualRelation.id as string;

    const listed = await json(manualUrl);
    assert.equal(listed.response.status, 200);
    assert.deepEqual(listed.body.manualRelations.map((relation: { id: string }) => relation.id), [relationId]);

    const status = await json(codeMapUrl);
    assert.equal(status.body.manualRelations[0]?.id, relationId);
    assert.equal(status.body.manualRelations[0]?.state, "active");
    assert.deepEqual(status.body.graph.relations, []);

    const queried = await json(`${codeMapUrl}/query`, {
      method: "POST",
      body: JSON.stringify({ operation: "relations", nodeId: "source-node", direction: "outgoing" }),
    });
    assert.equal(queried.response.status, 200);
    assert.equal(queried.body.query.entries[0]?.relation.id, `manual:${relationId}`);
    assert.equal(queried.body.query.entries[0]?.relation.provenance[0]?.providerId, "manual");

    const updated = await json(`${baseUrl}/code-map/manual-relations/${encodeURIComponent(relationId)}`, {
      method: "PATCH",
      headers: actorHeaders("http-manual-update-0001"),
      body: JSON.stringify({ expectedRevision: 1, label: "HTTP manual edge updated" }),
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.manualRelation.revision, 2);
    assert.equal(updated.body.manualRelation.label, "HTTP manual edge updated");

    const removed = await json(`${baseUrl}/code-map/manual-relations/${encodeURIComponent(relationId)}?expectedRevision=2`, {
      method: "DELETE",
      headers: actorHeaders("http-manual-delete-0001"),
    });
    assert.equal(removed.response.status, 200);
    assert.deepEqual(removed.body, { deleted: true, relationId });
    assert.deepEqual((await json(manualUrl)).body.manualRelations, []);
  } finally {
    await closeServer(server);
    repository.close();
  }
});

function actorHeaders(requestId: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-questboard-actor-id": agent.id,
    "x-questboard-actor-provider": agent.provider,
    "x-questboard-request-id": requestId,
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
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function json(url: string, init: RequestInit = {}): Promise<{ response: Response; body: any }> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return { response, body: await response.json() };
}
