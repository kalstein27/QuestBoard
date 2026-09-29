import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  AgentFocusService,
  createQuestBoardHttpServer,
  executeQuestBoardAgentTool,
  QuestBoardService,
  SqliteQuestBoardRepository,
  type ActorRef,
} from "../src/index.js";

const actor: ActorRef = { id: "agent:focus-test", provider: "test" };

test("Agent Focus is ephemeral, session-scoped, and never writes Task Activity", () => {
  const repository = new SqliteQuestBoardRepository();
  try {
    const service = new QuestBoardService(repository);
    const project = service.createProject({ name: "Focus" }, actor);
    const task = service.createTask({ projectId: project.id, title: "Focused task" }, actor);
    const baselineActivity = service.listTaskActivity(task.id).length;
    let tick = 0;
    const focus = new AgentFocusService(repository, () => `2026-09-29T00:00:0${++tick}.000Z`);

    const published = focus.set({
      projectId: project.id,
      sessionId: "agent-session-a",
      taskId: task.id,
      workGroupId: "group-1",
      codeScopeId: "code:node:1",
    });
    assert.equal(published.sessionId, "agent-session-a");
    assert.equal(focus.latest(project.id)?.taskId, task.id);
    assert.equal(service.listTaskActivity(task.id).length, baselineActivity);
    assert.equal(Object.hasOwn(service.resumeTask(task.id), "agentFocus"), false, "fresh-agent Resume must not absorb ephemeral focus");

    focus.set({ projectId: project.id, sessionId: "agent-session-b", flowNodeId: "flow-node-1" });
    assert.equal(focus.list(project.id).length, 2);
    assert.equal(focus.latest(project.id)?.sessionId, "agent-session-b");
    assert.deepEqual(focus.clear(project.id, "agent-session-b"), { cleared: true });
    assert.equal(focus.latest(project.id)?.sessionId, "agent-session-a");

    const restartedEphemeralService = new AgentFocusService(repository);
    assert.equal(restartedEphemeralService.latest(project.id), null, "ephemeral focus must not survive service restart");
    assert.equal(service.listTaskActivity(task.id).length, baselineActivity);
  } finally {
    repository.close();
  }
});

test("agent and HTTP surfaces share the same ephemeral Agent Focus state", async () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  const project = service.createProject({ name: "Focus surfaces" }, actor);
  const task = service.createTask({ projectId: project.id, title: "Agent location" }, actor);
  const focus = new AgentFocusService(repository);
  const runtime = { service, agentFocusService: focus };
  const server = createQuestBoardHttpServer(service, { agentFocusService: focus });
  try {
    const agentResult = executeQuestBoardAgentTool(runtime, "questboard_set_agent_focus", {
      projectId: project.id,
      sessionId: "agent-tool-session",
      taskId: task.id,
      codeScopeId: "code:node:agent",
    }) as { focus: { sessionId: string; taskId: string; codeScopeId: string } };
    assert.equal(agentResult.focus.sessionId, "agent-tool-session");

    await listen(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const read = await json(`${baseUrl}/projects/${encodeURIComponent(project.id)}/agent-focus`);
    assert.equal(read.response.status, 200);
    assert.equal(read.body.focus.sessionId, "agent-tool-session");
    assert.equal(read.body.focus.codeScopeId, "code:node:agent");

    const updated = await json(`${baseUrl}/projects/${encodeURIComponent(project.id)}/agent-focus`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "browser-visible-session", taskId: task.id, flowNodeId: "flow-node-2" }),
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.focus.sessionId, "browser-visible-session");
    const agentRead = executeQuestBoardAgentTool(runtime, "questboard_get_agent_focus", { projectId: project.id }) as {
      focus: { sessionId: string };
      sessions: Array<{ sessionId: string }>;
    };
    assert.equal(agentRead.focus.sessionId, "browser-visible-session");
    assert.equal(agentRead.sessions.length, 2);

    const cleared = executeQuestBoardAgentTool(runtime, "questboard_clear_agent_focus", {
      projectId: project.id,
      sessionId: "browser-visible-session",
    }) as { cleared: boolean };
    assert.equal(cleared.cleared, true);
    assert.equal(focus.latest(project.id)?.sessionId, "agent-tool-session");
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
  const response = await fetch(url, init);
  return { response, body: await response.json() };
}
