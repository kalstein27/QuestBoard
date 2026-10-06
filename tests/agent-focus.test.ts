import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  AgentFocusService,
  createQuestBoardHttpServer,
  executeQuestBoardAgentTool,
  QUESTBOARD_AGENT_TOOLS,
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
    const flowNode = service.createInvestigationNode({ projectId: project.id, title: "Focused flow" }, actor);
    const baselineActivity = service.listTaskActivity(task.id).length;
    let tick = 0;
    const focus = new AgentFocusService(
      repository,
      () => `2026-09-29T00:00:0${++tick}.000Z`,
      60_000,
      (_projectId, codeNodeId) => codeNodeId === "code:node:1",
    );

    const published = focus.set({
      projectId: project.id,
      sessionId: "agent-session-a",
      taskId: task.id,
      codeScopeId: "code:node:1",
    });
    assert.equal(published.sessionId, "agent-session-a");
    assert.equal(published.navigationIntent, "navigate");
    assert.equal(published.activeSurface, "code");
    assert.equal(published.focusedEntityType, "code_scope");
    assert.equal(published.focusedEntityId, "code:node:1");
    assert.equal(published.sequence, 1);
    const focused = focus.set({
      projectId: project.id,
      sessionId: "agent-session-a",
      taskId: task.id,
      activeSurface: "quest",
      navigationIntent: "focus",
    });
    assert.equal(focused.sequence, 2, "sequence is monotonic within one agent session");
    assert.equal(focused.activeSurface, "quest");
    assert.equal(focused.navigationIntent, "focus");
    assert.equal(focus.latest(project.id)?.taskId, task.id);
    assert.equal(service.listTaskActivity(task.id).length, baselineActivity);
    assert.equal(Object.hasOwn(service.resumeTask(task.id), "agentFocus"), false, "fresh-agent Resume must not absorb ephemeral focus");

    focus.set({ projectId: project.id, sessionId: "agent-session-b", flowNodeId: flowNode.id, navigationIntent: "inspect" });
    assert.equal(focus.list(project.id).length, 2);
    assert.equal(focus.latest(project.id)?.sessionId, "agent-session-b");
    assert.equal(focus.latest(project.id)?.activeSurface, "flow");
    assert.equal(focus.latest(project.id)?.navigationIntent, "inspect");
    assert.deepEqual(focus.clear(project.id, "agent-session-b"), { cleared: true });
    assert.equal(focus.latest(project.id)?.sessionId, "agent-session-a");

    const restartedEphemeralService = new AgentFocusService(repository);
    assert.equal(restartedEphemeralService.latest(project.id), null, "ephemeral focus must not survive service restart");
    assert.equal(service.listTaskActivity(task.id).length, baselineActivity);
  } finally {
    repository.close();
  }
});

test("surface-aware Agent Focus adapters preserve Code→Flow→Task→Code continuity without ID-space mixing", () => {
  const repository = new SqliteQuestBoardRepository();
  try {
    const service = new QuestBoardService(repository);
    const project = service.createProject({ name: "Follow slice" }, actor);
    const otherProject = service.createProject({ name: "Other" }, actor);
    const task = service.createTask({ projectId: project.id, title: "Continuity task" }, actor);
    const flowNode = service.createInvestigationNode({ projectId: project.id, title: "Continuity flow" }, actor);
    const flowGroup = service.createFlowWorkGroup({ projectId: project.id, title: "Continuity group" }, actor);
    const foreignFlowNode = service.createInvestigationNode({ projectId: otherProject.id, title: "Foreign flow" }, actor);
    const rawCodeNodes = new Set(["code:node:A", "code:node:B"]);
    const focus = new AgentFocusService(repository, undefined, 60_000, (_projectId, codeNodeId) => rawCodeNodes.has(codeNodeId));
    const baselineActivity = service.listTaskActivity(task.id).length;
    const sessionId = "vertical-slice";

    const codeA = focus.set({
      projectId: project.id, sessionId, sequence: 1, activeSurface: "code",
      taskId: task.id, codeScopeId: "code:node:A", navigationIntent: "navigate",
    });
    assert.equal(codeA.focusedEntityType, "code_scope");
    assert.equal(codeA.focusedEntityId, "code:node:A");

    const flow = focus.set({
      projectId: project.id, sessionId, sequence: 2, activeSurface: "flow",
      taskId: task.id, flowNodeId: flowNode.id, navigationIntent: "navigate",
    });
    assert.equal(flow.focusedEntityType, "flow_node");
    assert.equal(flow.focusedEntityId, flowNode.id);

    const quest = focus.set({
      projectId: project.id, sessionId, sequence: 3, activeSurface: "quest",
      taskId: task.id, navigationIntent: "navigate",
    });
    assert.equal(quest.focusedEntityType, "task");
    assert.equal(quest.focusedEntityId, task.id);

    const codeB = focus.set({
      projectId: project.id, sessionId, sequence: 4, activeSurface: "code",
      taskId: task.id, codeScopeId: "code:node:B", navigationIntent: "navigate",
    });
    assert.equal(codeB.focusedEntityType, "code_scope");
    assert.equal(codeB.focusedEntityId, "code:node:B");

    const group = focus.set({
      projectId: project.id, sessionId, sequence: 5, activeSurface: "flow",
      workGroupId: flowGroup.id, navigationIntent: "focus",
    });
    assert.equal(group.focusedEntityType, "work_group");
    assert.equal(group.focusedEntityId, flowGroup.id);

    assert.throws(
      () => focus.set({ projectId: project.id, sessionId, sequence: 6, activeSurface: "code", codeScopeId: "code-map:node:derived", navigationIntent: "navigate" }),
      /raw code:node:\* ID/,
    );
    assert.throws(
      () => focus.set({ projectId: project.id, sessionId, sequence: 6, activeSurface: "quest", taskId: task.id, codeScopeId: "code:node:A", navigationIntent: "navigate" }),
      /Quest focus requires exactly a Task target/,
    );
    assert.throws(
      () => focus.set({ projectId: project.id, sessionId, sequence: 6, activeSurface: "flow", flowNodeId: foreignFlowNode.id, navigationIntent: "navigate" }),
      /does not belong to project/,
    );
    assert.equal(focus.latest(project.id)?.sequence, 5, "rejected publications must not advance the visible focus");
    assert.equal(service.listTaskActivity(task.id).length, baselineActivity, "surface presence must stay out of durable Task Activity");
  } finally {
    repository.close();
  }
});

test("Agent Focus rejects stale sequence, clears idle targets, and expires stale presence", () => {
  const repository = new SqliteQuestBoardRepository();
  try {
    const service = new QuestBoardService(repository);
    const project = service.createProject({ name: "Focus ordering" }, actor);
    let nowMs = Date.parse("2026-09-29T01:00:00.000Z");
    const focus = new AgentFocusService(repository, () => new Date(nowMs).toISOString(), 1_000);

    const accepted = focus.set({
      projectId: project.id,
      sessionId: "ordered-session",
      sequence: 10,
      codeScopeId: "code:node:current",
      navigationIntent: "navigate",
    });
    assert.equal(accepted.sequence, 10);
    assert.equal(accepted.codeScopeId, "code:node:current");
    assert.equal(accepted.expiresAt, "2026-09-29T01:00:01.000Z");

    const stale = focus.set({
      projectId: project.id,
      sessionId: "ordered-session",
      sequence: 9,
      flowNodeId: "flow-node-stale",
      navigationIntent: "navigate",
    });
    assert.equal(stale.sequence, 10, "older publication must return the current focus unchanged");
    assert.equal(stale.codeScopeId, "code:node:current");
    assert.equal(stale.flowNodeId, undefined);

    const idle = focus.set({
      projectId: project.id,
      sessionId: "ordered-session",
      sequence: 11,
      codeScopeId: "code:node:must-not-survive-idle",
      navigationIntent: "idle",
    });
    assert.equal(idle.sequence, 11);
    assert.equal(idle.navigationIntent, "idle");
    assert.equal(idle.activeSurface, undefined);
    assert.equal(idle.focusedEntityId, undefined);
    assert.equal(idle.codeScopeId, undefined);

    nowMs += 1_001;
    assert.equal(focus.latest(project.id), null, "expired focus must disappear from latest reads");
    assert.deepEqual(focus.list(project.id), []);
  } finally {
    repository.close();
  }
});

test("Agent Focus keeps identity bounded and rapid publications coalesced to one session state", () => {
  const repository = new SqliteQuestBoardRepository();
  try {
    const service = new QuestBoardService(repository);
    const project = service.createProject({ name: "Focus bounds" }, actor);
    const task = service.createTask({ projectId: project.id, title: "Bounded target" }, actor);
    const focus = new AgentFocusService(repository);

    assert.throws(
      () => focus.set({ projectId: project.id, sessionId: "x".repeat(129), taskId: task.id, navigationIntent: "focus" }),
      /at most 128 characters/,
    );
    assert.throws(
      () => focus.set({ projectId: project.id, sessionId: "agent\nsecret", taskId: task.id, navigationIntent: "focus" }),
      /control characters/,
    );

    for (let sequence = 1; sequence <= 100; sequence += 1) {
      focus.set({
        projectId: project.id,
        sessionId: "rapid-session",
        sequence,
        activeSurface: "quest",
        taskId: task.id,
        navigationIntent: "focus",
      });
    }
    assert.equal(focus.list(project.id).length, 1, "rapid focus changes must overwrite one session slot instead of accumulating history");
    assert.equal(focus.latest(project.id)?.sequence, 100);

    const tool = QUESTBOARD_AGENT_TOOLS.find((entry) => entry.name === "questboard_set_agent_focus");
    assert.ok(tool);
    const schema = tool.inputSchema as { additionalProperties?: boolean; properties?: Record<string, { maxLength?: number }> };
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties?.sessionId?.maxLength, 128);
    assert.deepEqual(
      Object.keys(schema.properties ?? {}).sort(),
      ["activeSurface", "codeScopeId", "flowNodeId", "navigationIntent", "projectId", "sequence", "sessionId", "taskId", "workGroupId"].sort(),
      "presence schema must not grow payload slots for prompts, file bodies, secrets, or raw tool arguments",
    );
  } finally {
    repository.close();
  }
});

test("agent and HTTP surfaces share ordered ephemeral Agent Focus state", async () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  const project = service.createProject({ name: "Focus surfaces" }, actor);
  const task = service.createTask({ projectId: project.id, title: "Agent location" }, actor);
  const flowNode = service.createInvestigationNode({ projectId: project.id, title: "Browser-visible flow" }, actor);
  const focus = new AgentFocusService(repository);
  const runtime = { service, agentFocusService: focus };
  const server = createQuestBoardHttpServer(service, { agentFocusService: focus });
  try {
    const agentResult = executeQuestBoardAgentTool(runtime, "questboard_set_agent_focus", {
      projectId: project.id,
      sessionId: "agent-tool-session",
      sequence: 7,
      taskId: task.id,
      codeScopeId: "code:node:agent",
      navigationIntent: "navigate",
    }) as { focus: { sessionId: string; taskId: string; codeScopeId: string; activeSurface: string; navigationIntent: string; sequence: number } };
    assert.equal(agentResult.focus.sessionId, "agent-tool-session");
    assert.equal(agentResult.focus.activeSurface, "code");
    assert.equal(agentResult.focus.navigationIntent, "navigate");
    assert.equal(agentResult.focus.sequence, 7);

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
      body: JSON.stringify({
        sessionId: "browser-visible-session",
        sequence: 11,
        taskId: task.id,
        flowNodeId: flowNode.id,
        activeSurface: "flow",
        navigationIntent: "focus",
        prompt: "SENSITIVE_PROMPT_SENTINEL",
        fileBody: "SENSITIVE_FILE_SENTINEL",
        rawToolArguments: { token: "SENSITIVE_TOOL_SENTINEL" },
        secret: "SENSITIVE_SECRET_SENTINEL",
      }),
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.focus.sessionId, "browser-visible-session");
    assert.equal(updated.body.focus.activeSurface, "flow");
    assert.equal(updated.body.focus.navigationIntent, "focus");
    assert.equal(updated.body.focus.sequence, 11);
    const serializedFocus = JSON.stringify(updated.body.focus);
    assert.equal(serializedFocus.includes("SENSITIVE_"), false, "unknown sensitive fields must never enter the presence payload");
    const staleHttp = await json(`${baseUrl}/projects/${encodeURIComponent(project.id)}/agent-focus`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "browser-visible-session", sequence: 10, codeScopeId: "code:node:stale" }),
    });
    assert.equal(staleHttp.response.status, 200);
    assert.equal(staleHttp.body.focus.sequence, 11);
    assert.equal(staleHttp.body.focus.flowNodeId, flowNode.id);
    assert.equal(staleHttp.body.focus.codeScopeId, undefined);

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
