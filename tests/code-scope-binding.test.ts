import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  CODE_GRAPH_SCHEMA_VERSION,
  CodeMapService,
  CodeScopeBindingService,
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

const actor: ActorRef = { id: "agent:scope-test", provider: "test" };

class FixtureProvider implements CodeIntelligenceProvider {
  readonly providerId = "scope-fixture";
  readonly capabilities = {
    languages: ["typescript"],
    fidelity: "semantic-call" as const,
    incrementalIndexing: false,
    impactAnalysis: false,
    callTrace: false,
  };
  graph: CodeGraphSnapshot;

  constructor(graph: CodeGraphSnapshot) {
    this.graph = graph;
  }

  async indexProject(request: CodeIndexRequest): Promise<CodeGraphSnapshot> {
    return { ...this.graph, projectId: request.projectId, rootPath: request.rootPath };
  }
}

function graph(nodeIdentity = "scip:scope"): CodeGraphSnapshot {
  return {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId: "placeholder",
    rootPath: "/workspace/project",
    indexedAt: "2026-09-29T00:00:00.000Z",
    nodes: [{
      id: "node-scope",
      kind: "function",
      name: "scope",
      canonicalIdentity: nodeIdentity,
      language: "typescript",
      location: { path: "src/scope.ts", startLine: 1 },
      signature: "scope(): void",
    }],
    relations: [],
  };
}

test("persistent Task↔CodeScope bindings survive restart, expose unindexed, and surface a conservative relink without mutating", async () => {
  const dir = mkdtempSync(join(tmpdir(), "questboard-code-scope-"));
  const dbPath = join(dir, "questboard.sqlite");
  try {
    let repository = new SqliteQuestBoardRepository(dbPath);
    let tasks = new QuestBoardService(repository);
    const project = tasks.createProject({ name: "Scope", rootPath: "/workspace/project" }, actor);
    const task = tasks.createTask({ projectId: project.id, title: "Keep scope" }, actor);
    const provider = new FixtureProvider(graph());
    let codeMap = new CodeMapService(provider);
    await codeMap.refresh({ projectId: project.id, rootPath: "/workspace/project" });
    let scopes = new CodeScopeBindingService(codeMap, repository, tasks);
    const attached = scopes.attach({ projectId: project.id, taskId: task.id, codeNodeId: "node-scope" }, actor, { requestId: "scope-attach-001" });
    assert.equal(attached.state, "active");
    assert.equal(attached.kind, "targets");
    repository.close();

    repository = new SqliteQuestBoardRepository(dbPath);
    tasks = new QuestBoardService(repository);
    codeMap = new CodeMapService(provider);
    scopes = new CodeScopeBindingService(codeMap, repository, tasks);
    const unindexed = scopes.list(project.id, { taskId: task.id });
    assert.equal(unindexed.length, 1);
    assert.equal(unindexed[0]?.state, "unindexed");
    assert.equal(unindexed[0]?.staleReason, "code_map_not_indexed");

    provider.graph = graph("scip:scope-changed");
    await codeMap.refresh({ projectId: project.id, rootPath: "/workspace/project" });
    const relinkable = scopes.list(project.id, { taskId: task.id });
    assert.equal(relinkable[0]?.state, "relinkable");
    assert.equal(relinkable[0]?.relink?.strategy, "path_signature");
    assert.equal(relinkable[0]?.codeNodeId, "node-scope");
    assert.equal(relinkable[0]?.codeCanonicalIdentity, "scip:scope", "reading a relink candidate must not mutate persisted identity");
    assert.equal(tasks.getTask(task.id).title, "Keep scope");
    repository.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attach is idempotent by request and createTaskForScope is atomic from the shared service boundary", async () => {
  const repository = new SqliteQuestBoardRepository();
  try {
    const tasks = new QuestBoardService(repository);
    const project = tasks.createProject({ name: "Scope", rootPath: "/workspace/project" }, actor);
    const provider = new FixtureProvider(graph());
    const codeMap = new CodeMapService(provider);
    await codeMap.refresh({ projectId: project.id, rootPath: "/workspace/project" });
    const scopes = new CodeScopeBindingService(codeMap, repository, tasks);
    const task = tasks.createTask({ projectId: project.id, title: "Existing" }, actor);
    const first = scopes.attach({ projectId: project.id, taskId: task.id, codeNodeId: "node-scope", kind: "affects" }, actor, { requestId: "scope-attach-002" });
    const replay = scopes.attach({ projectId: project.id, taskId: task.id, codeNodeId: "node-scope", kind: "affects" }, actor, { requestId: "scope-attach-002" });
    assert.equal(replay.id, first.id);
    assert.equal(repository.listTaskCodeScopeBindings(project.id).length, 1);

    const created = scopes.createTaskForScope({
      projectId: project.id,
      codeNodeId: "node-scope",
      kind: "targets",
      task: { title: "Scoped TODO", goal: "Finish this scope" },
    }, actor, { requestId: "scope-create-task-001" });
    assert.equal(created.task.title, "Scoped TODO");
    assert.equal(created.binding.taskId, created.task.id);
    assert.equal(created.binding.state, "active");
    assert.equal(repository.listTaskCodeScopeBindings(project.id).length, 2);
  } finally {
    repository.close();
  }
});

test("agent, MCP, and HTTP share persistent Task↔CodeScope semantics", async () => {
  const repository = new SqliteQuestBoardRepository();
  const tasks = new QuestBoardService(repository);
  const project = tasks.createProject({ name: "Scope surfaces", rootPath: "/workspace/project" }, actor);
  const provider = new FixtureProvider(graph());
  const codeMap = new CodeMapService(provider);
  await codeMap.refresh({ projectId: project.id, rootPath: project.rootPath! });
  const scopes = new CodeScopeBindingService(codeMap, repository, tasks);
  const runtime = { service: tasks, codeMapService: codeMap, codeScopeBindingService: scopes };
  const existing = tasks.createTask({ projectId: project.id, title: "Existing" }, actor);
  const server = createQuestBoardHttpServer(tasks, { codeMapService: codeMap, codeScopeBindingService: scopes });
  try {
    const agentCreated = executeQuestBoardAgentTool(runtime, "questboard_create_task_for_code_scope", {
      projectId: project.id,
      codeNodeId: "node-scope",
      title: "Agent scoped",
      actor,
      requestId: "scope-agent-create-001",
    }) as { task: { id: string }; binding: { taskId: string; state: string } };
    assert.equal(agentCreated.binding.taskId, agentCreated.task.id);
    assert.equal(agentCreated.binding.state, "active");

    const mcp = createQuestBoardMcpHandler(runtime, "scope-surface-session");
    const attached = mcp.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "questboard_attach_task_code_scope",
        arguments: { projectId: project.id, taskId: existing.id, codeNodeId: "node-scope", kind: "affects", actor },
      },
    }) as { result: { structuredContent: { codeScopeBinding: { id: string; kind: string } }; isError?: boolean } };
    assert.equal(attached.result.isError, undefined);
    assert.equal(attached.result.structuredContent.codeScopeBinding.kind, "affects");

    await listen(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const created = await json(`${baseUrl}/projects/${encodeURIComponent(project.id)}/code-scope-tasks`, {
      method: "POST",
      headers: actorHeaders("scope-http-create-001"),
      body: JSON.stringify({ codeNodeId: "node-scope", title: "HTTP scoped", goal: "Keep context" }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.binding.state, "active");

    const map = await json(`${baseUrl}/projects/${encodeURIComponent(project.id)}/code-map`);
    assert.equal(map.body.codeScopeBindings.length, 3);
    assert.ok(map.body.codeScopeBindings.every((binding: { codeCanonicalIdentity: string }) => binding.codeCanonicalIdentity === "scip:scope"));

    const listed = await json(`${baseUrl}/projects/${encodeURIComponent(project.id)}/code-scope-bindings?taskId=${encodeURIComponent(existing.id)}`);
    assert.equal(listed.body.codeScopeBindings.length, 1);
    const binding = listed.body.codeScopeBindings[0];
    const removed = await json(`${baseUrl}/code-scope-bindings/${encodeURIComponent(binding.id)}?expectedRevision=${binding.revision}`, {
      method: "DELETE",
      headers: actorHeaders("scope-http-detach-001"),
    });
    assert.equal(removed.response.status, 200);
    assert.equal(tasks.getTask(existing.id).title, "Existing", "detaching code context must not delete the Task");
  } finally {
    await closeServer(server);
    repository.close();
  }
});

test("Task↔CodeScope cardinality supports many-to-many bindings without duplicate exact triples", async () => {
  const repository = new SqliteQuestBoardRepository();
  try {
    const tasks = new QuestBoardService(repository);
    const project = tasks.createProject({ name: "Scope cardinality", rootPath: "/workspace/project" }, actor);
    const provider = new FixtureProvider({
      ...graph(),
      nodes: [
        ...graph().nodes,
        {
          id: "node-second",
          kind: "function",
          name: "secondScope",
          canonicalIdentity: "scip:second-scope",
          language: "typescript",
          location: { path: "src/second.ts", startLine: 1 },
        },
      ],
    });
    const codeMap = new CodeMapService(provider);
    await codeMap.refresh({ projectId: project.id, rootPath: project.rootPath! });
    const scopes = new CodeScopeBindingService(codeMap, repository, tasks);
    const firstTask = tasks.createTask({ projectId: project.id, title: "First" }, actor);
    const secondTask = tasks.createTask({ projectId: project.id, title: "Second" }, actor);

    scopes.attach({ projectId: project.id, taskId: firstTask.id, codeNodeId: "node-scope", kind: "targets" }, actor);
    scopes.attach({ projectId: project.id, taskId: firstTask.id, codeNodeId: "node-second", kind: "implemented_in" }, actor);
    scopes.attach({ projectId: project.id, taskId: secondTask.id, codeNodeId: "node-scope", kind: "investigates" }, actor);
    const duplicate = scopes.attach({ projectId: project.id, taskId: firstTask.id, codeNodeId: "node-scope", kind: "targets" }, actor);

    assert.equal(scopes.list(project.id, { taskId: firstTask.id }).length, 2);
    assert.equal(scopes.list(project.id, { codeNodeId: "node-scope" }).length, 2);
    assert.equal(repository.listTaskCodeScopeBindings(project.id).length, 3);
    assert.equal(duplicate.kind, "targets");
  } finally {
    repository.close();
  }
});

test("createTaskForScope rolls back the Task when binding persistence fails", async () => {
  const repository = new SqliteQuestBoardRepository();
  try {
    const tasks = new QuestBoardService(repository);
    const project = tasks.createProject({ name: "Scope rollback", rootPath: "/workspace/project" }, actor);
    const provider = new FixtureProvider(graph());
    const codeMap = new CodeMapService(provider);
    await codeMap.refresh({ projectId: project.id, rootPath: project.rootPath! });
    const scopes = new CodeScopeBindingService(codeMap, repository, tasks);
    const before = tasks.listTasks({ projectId: project.id }).length;
    const original = repository.createTaskCodeScopeBinding.bind(repository);
    (repository as unknown as { createTaskCodeScopeBinding: typeof repository.createTaskCodeScopeBinding }).createTaskCodeScopeBinding = () => {
      throw new Error("forced binding persistence failure");
    };
    assert.throws(() => scopes.createTaskForScope({
      projectId: project.id,
      codeNodeId: "node-scope",
      task: { title: "Must roll back" },
    }, actor, { requestId: "scope-rollback-create-001" }), /forced binding persistence failure/);
    (repository as unknown as { createTaskCodeScopeBinding: typeof repository.createTaskCodeScopeBinding }).createTaskCodeScopeBinding = original;
    assert.equal(tasks.listTasks({ projectId: project.id }).length, before);
    assert.equal(repository.listTaskCodeScopeBindings(project.id).length, 0);
  } finally {
    repository.close();
  }
});

test("CodeScope relink is conservative across canonical identity and path+signature fallback", async () => {
  const repository = new SqliteQuestBoardRepository();
  try {
    const tasks = new QuestBoardService(repository);
    const project = tasks.createProject({ name: "Scope relink", rootPath: "/workspace/project" }, actor);
    const task = tasks.createTask({ projectId: project.id, title: "Survive refactor" }, actor);
    const provider = new FixtureProvider(graph());
    const codeMap = new CodeMapService(provider);
    await codeMap.refresh({ projectId: project.id, rootPath: project.rootPath! });
    const scopes = new CodeScopeBindingService(codeMap, repository, tasks);
    const attached = scopes.attach({ projectId: project.id, taskId: task.id, codeNodeId: "node-scope" }, actor);
    assert.equal(attached.codePath, "src/scope.ts");
    assert.equal(attached.codeSignature, "scope(): void");

    provider.graph = {
      ...graph(),
      nodes: [{ ...graph().nodes[0]!, id: "node-scope-moved" }],
    };
    await codeMap.refresh({ projectId: project.id, rootPath: project.rootPath! });
    const canonicalCandidate = scopes.list(project.id, { taskId: task.id })[0]!;
    assert.equal(canonicalCandidate.state, "relinkable");
    assert.equal(canonicalCandidate.relink?.strategy, "canonical_identity");
    assert.equal(canonicalCandidate.relink?.candidate.id, "node-scope-moved");
    const canonicalRelinked = scopes.relink(attached.id, actor, { expectedRevision: attached.revision, requestId: "scope-relink-canonical-001" });
    assert.equal(canonicalRelinked.state, "active");
    assert.equal(canonicalRelinked.codeNodeId, "node-scope-moved");
    assert.equal(canonicalRelinked.revision, 2);

    provider.graph = {
      ...graph("scip:scope-refactored"),
      nodes: [{ ...graph("scip:scope-refactored").nodes[0]!, id: "node-scope-refactored" }],
    };
    await codeMap.refresh({ projectId: project.id, rootPath: project.rootPath! });
    const fallbackCandidate = scopes.list(project.id, { taskId: task.id })[0]!;
    assert.equal(fallbackCandidate.state, "relinkable");
    assert.equal(fallbackCandidate.relink?.strategy, "path_signature");
    const fallbackRelinked = scopes.relink(canonicalRelinked.id, actor, { expectedRevision: canonicalRelinked.revision, requestId: "scope-relink-fallback-001" });
    assert.equal(fallbackRelinked.state, "active");
    assert.equal(fallbackRelinked.codeCanonicalIdentity, "scip:scope-refactored");
    assert.equal(fallbackRelinked.revision, 3);

    provider.graph = {
      ...graph("scip:ambiguous-a"),
      nodes: [
        { ...graph("scip:ambiguous-a").nodes[0]!, id: "node-a" },
        { ...graph("scip:ambiguous-b").nodes[0]!, id: "node-b" },
      ],
    };
    await codeMap.refresh({ projectId: project.id, rootPath: project.rootPath! });
    const ambiguous = scopes.list(project.id, { taskId: task.id })[0]!;
    assert.equal(ambiguous.state, "stale");
    assert.equal(ambiguous.staleReason, "relink_ambiguous");
    assert.throws(
      () => scopes.relink(fallbackRelinked.id, actor, { expectedRevision: fallbackRelinked.revision, requestId: "scope-relink-ambiguous-001" }),
      /no unique relink target/,
    );
    assert.equal(tasks.getTask(task.id).title, "Survive refactor");

    provider.graph = {
      ...graph(fallbackRelinked.codeCanonicalIdentity),
      nodes: [
        {
          ...graph(fallbackRelinked.codeCanonicalIdentity).nodes[0]!,
          id: "canonical-ambiguous-anchor-match",
          location: { path: fallbackRelinked.codePath! },
          signature: fallbackRelinked.codeSignature!,
        },
        {
          ...graph(fallbackRelinked.codeCanonicalIdentity).nodes[0]!,
          id: "canonical-ambiguous-anchor-miss",
          location: { path: "src/other-location.ts" },
          signature: "different-signature",
        },
      ],
    };
    await codeMap.refresh({ projectId: project.id, rootPath: project.rootPath! });
    const higherPriorityAmbiguous = scopes.list(project.id, { taskId: task.id })[0]!;
    assert.equal(higherPriorityAmbiguous.state, "stale");
    assert.equal(higherPriorityAmbiguous.staleReason, "relink_ambiguous");
    assert.equal(higherPriorityAmbiguous.relink, undefined);
    assert.throws(
      () => scopes.relink(fallbackRelinked.id, actor, { expectedRevision: fallbackRelinked.revision, requestId: "scope-relink-canonical-ambiguous-001" }),
      /no unique relink target/,
    );
  } finally {
    repository.close();
  }
});

function actorHeaders(requestId: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-questboard-actor-id": actor.id,
    "x-questboard-actor-provider": actor.provider,
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

async function json(url: string, init?: RequestInit): Promise<{ response: Response; body: any }> {
  const response = await fetch(url, init);
  const body = await response.json();
  return { response, body };
}
