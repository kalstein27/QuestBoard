import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import test from "node:test";
import {
  createQuestBoardHttpServer,
  QuestBoardService,
  SqliteQuestBoardRepository,
  type ActorRef,
} from "../src/index.js";

const human: ActorRef = { id: "human:owner", provider: "human" };
const chatgpt: ActorRef = { id: "agent:chatgpt", provider: "chatgpt" };
const claude: ActorRef = { id: "agent:claude", provider: "claude" };

test("serves the vendor-neutral localhost Task workflow over HTTP", async () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  const server = createQuestBoardHttpServer(service, { webRoot: resolve("web") });

  try {
    await listen(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const health = await jsonRequest<{ status: string }>(`${baseUrl}/health`);
    assert.equal(health.response.status, 200);
    assert.equal(health.body.status, "ok");

    const home = await fetch(`${baseUrl}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await home.text(), /id="kanban-board"/);

    const webApp = await fetch(`${baseUrl}/app.js`);
    assert.equal(webApp.status, 200);
    assert.match(await webApp.text(), /kanban-board/);

    const projectCreated = await jsonRequest<{ project: { id: string; name: string } }>(
      `${baseUrl}/projects`,
      { method: "POST", actor: human, body: { name: "QuestBoard", description: "Shared board" } },
    );
    assert.equal(projectCreated.response.status, 201);
    const projectId = projectCreated.body.project.id;

    const projectUpdated = await jsonRequest<{ project: { status: string } }>(
      `${baseUrl}/projects/${projectId}`,
      { method: "PATCH", actor: human, body: { status: "active", rootPath: "/tmp/questboard" } },
    );
    assert.equal(projectUpdated.body.project.status, "active");

    const taskCreated = await jsonRequest<{ task: { id: string; status: string; revision: number } }>(
      `${baseUrl}/tasks`,
      {
        method: "POST",
        actor: human,
        body: { projectId, title: "Expose local API", status: "ready", priority: "high", tags: ["api"] },
      },
    );
    assert.equal(taskCreated.response.status, 201);
    const taskId = taskCreated.body.task.id;

    const readyTasks = await jsonRequest<{ tasks: Array<{ id: string }> }>(
      `${baseUrl}/tasks?projectId=${encodeURIComponent(projectId)}&status=ready`,
    );
    assert.deepEqual(readyTasks.body.tasks.map((task) => task.id), [taskId]);

    const taskUpdated = await jsonRequest<{ task: { status: string; revision: number } }>(
      `${baseUrl}/tasks/${taskId}`,
      { method: "PATCH", actor: chatgpt, requestId: "http:update:0001", body: { status: "in_progress" } },
    );
    assert.equal(taskUpdated.body.task.status, "in_progress");
    assert.equal(taskUpdated.body.task.revision, 2);

    const replayedUpdate = await jsonRequest<{ task: { status: string; revision: number } }>(
      `${baseUrl}/tasks/${taskId}`,
      { method: "PATCH", actor: chatgpt, requestId: "http:update:0001", body: { status: "in_progress" } },
    );
    assert.equal(replayedUpdate.body.task.revision, 2);

    const staleUpdate = await jsonRequest<{ error: { code: string; actualRevision: number } }>(
      `${baseUrl}/tasks/${taskId}`,
      { method: "PATCH", actor: claude, body: { status: "review", expectedRevision: 1 } },
    );
    assert.equal(staleUpdate.response.status, 409);
    assert.equal(staleUpdate.body.error.code, "revision_conflict");
    assert.equal(staleUpdate.body.error.actualRevision, 2);

    const claimed = await jsonRequest<{ claim: { id: string; agentId: string; state: string } }>(
      `${baseUrl}/tasks/${taskId}/claim`,
      { method: "POST", actor: chatgpt },
    );
    assert.equal(claimed.body.claim.agentId, chatgpt.id);
    assert.equal(claimed.body.claim.state, "active");

    const activeClaim = await jsonRequest<{ claim: { agentId: string } | null }>(
      `${baseUrl}/tasks/${taskId}/claim`,
    );
    assert.equal(activeClaim.body.claim?.agentId, chatgpt.id);

    const collision = await jsonRequest<{ error: { code: string } }>(
      `${baseUrl}/tasks/${taskId}/claim`,
      { method: "POST", actor: claude },
    );
    assert.equal(collision.response.status, 409);
    assert.equal(collision.body.error.code, "claim_conflict");

    const note = await jsonRequest<{ activity: { type: string } }>(
      `${baseUrl}/tasks/${taskId}/activity`,
      { method: "POST", actor: chatgpt, body: { type: "note_added", summary: "API verified" } },
    );
    assert.equal(note.response.status, 201);
    assert.equal(note.body.activity.type, "note_added");

    const artifactCreated = await jsonRequest<{ artifact: { id: string; type: string; locator: string } }>(
      `${baseUrl}/tasks/${taskId}/artifacts`,
      {
        method: "POST",
        actor: chatgpt,
        body: { type: "log", title: "API verification log", locator: "logs/api.log", description: "HTTP evidence" },
      },
    );
    assert.equal(artifactCreated.response.status, 201);
    assert.equal(artifactCreated.body.artifact.type, "log");
    const artifactId = artifactCreated.body.artifact.id;

    const artifacts = await jsonRequest<{ artifacts: Array<{ id: string }> }>(
      `${baseUrl}/tasks/${taskId}/artifacts`,
    );
    assert.deepEqual(artifacts.body.artifacts.map((item) => item.id), [artifactId]);

    const artifactRead = await jsonRequest<{ artifact: { locator: string } }>(`${baseUrl}/artifacts/${artifactId}`);
    assert.equal(artifactRead.body.artifact.locator, "logs/api.log");

    const relationCreated = await jsonRequest<{ relation: { id: string; kind: string } }>(`${baseUrl}/relations`, {
      method: "POST",
      actor: chatgpt,
      body: {
        fromType: "task",
        fromId: taskId,
        toType: "artifact",
        toId: artifactId,
        kind: "evidence_for",
        label: "API verification",
      },
    });
    assert.equal(relationCreated.response.status, 201);
    assert.equal(relationCreated.body.relation.kind, "evidence_for");

    const relations = await jsonRequest<{ relations: Array<{ id: string }> }>(`${baseUrl}/tasks/${taskId}/relations`);
    assert.deepEqual(relations.body.relations.map((item) => item.id), [relationCreated.body.relation.id]);

    const taskPosition = await jsonRequest<{ position: { entityType: string; entityId: string; x: number; y: number } }>(
      `${baseUrl}/projects/${projectId}/investigation/positions/task/${taskId}`,
      { method: "PUT", actor: chatgpt, body: { x: 210, y: 160 } },
    );
    assert.equal(taskPosition.response.status, 200);
    assert.deepEqual(
      [taskPosition.body.position.entityType, taskPosition.body.position.entityId, taskPosition.body.position.x],
      ["task", taskId, 210],
    );
    const artifactPosition = await jsonRequest<{ position: { x: number; y: number } }>(
      `${baseUrl}/projects/${projectId}/investigation/positions/artifact/${artifactId}`,
      { method: "PUT", actor: chatgpt, body: { x: 580.5, y: 310.25 } },
    );
    assert.equal(artifactPosition.body.position.y, 310.25);

    const investigation = await jsonRequest<{
      tasks: Array<{ id: string; revision: number }>;
      artifacts: Array<{ id: string }>;
      relations: Array<{ id: string }>;
      positions: Array<{ entityType: string; entityId: string }>;
    }>(`${baseUrl}/projects/${projectId}/investigation`);
    assert.deepEqual(investigation.body.tasks.map((item) => item.id), [taskId]);
    assert.deepEqual(investigation.body.artifacts.map((item) => item.id), [artifactId]);
    assert.deepEqual(investigation.body.relations.map((item) => item.id), [relationCreated.body.relation.id]);
    assert.equal(investigation.body.positions.length, 2);
    assert.equal(investigation.body.tasks[0]?.revision, 2);

    await jsonRequest(`${baseUrl}/tasks/${taskId}/release`, {
      method: "POST",
      actor: chatgpt,
      body: { claimId: claimed.body.claim.id },
    });
    const releasedClaim = await jsonRequest<{ claim: { agentId: string } | null }>(
      `${baseUrl}/tasks/${taskId}/claim`,
    );
    assert.equal(releasedClaim.body.claim, null);
    const activity = await jsonRequest<{ activities: Array<{ type: string }> }>(
      `${baseUrl}/tasks/${taskId}/activity`,
    );
    assert.deepEqual(activity.body.activities.map((item) => item.type), [
      "task_created",
      "status_changed",
      "task_claimed",
      "note_added",
      "artifact_attached",
      "relation_added",
      "task_released",
    ]);

    const missingActor = await jsonRequest<{ error: { code: string } }>(`${baseUrl}/projects`, {
      method: "POST",
      body: { name: "Rejected" },
    });
    assert.equal(missingActor.response.status, 400);
    assert.equal(missingActor.body.error.code, "bad_request");
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

interface RequestOptions {
  method?: string;
  actor?: ActorRef;
  requestId?: string;
  body?: unknown;
}

async function jsonRequest<T = unknown>(
  url: string,
  options: RequestOptions = {},
): Promise<{ response: Response; body: T }> {
  const headers = new Headers();
  if (options.actor) {
    headers.set("x-questboard-actor-id", options.actor.id);
    headers.set("x-questboard-actor-provider", options.actor.provider);
  }
  if (options.requestId) headers.set("x-questboard-request-id", options.requestId);
  if (options.body !== undefined) headers.set("content-type", "application/json");

  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  return { response, body: (await response.json()) as T };
}