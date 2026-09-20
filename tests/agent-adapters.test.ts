import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  executeQuestBoardAgentTool,
  createQuestBoardMcpHandler,
  QuestBoardService,
  runQuestBoardCli,
  runQuestBoardMcpStdio,
  SqliteQuestBoardRepository,
  type ActorRef,
} from "../src/index.js";

const owner: ActorRef = { id: "human:owner", provider: "human" };
const agent: ActorRef = { id: "agent:neutral-a", provider: "test-agent" };
const otherAgent: ActorRef = { id: "agent:neutral-b", provider: "other-agent" };

test("agent tool boundary provides Task, Claim, and Activity workflow without vendor coupling", () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  try {
    const projectResult = executeQuestBoardAgentTool(service, "questboard_create_project", {
      name: "Adapters",
      description: "Created through the shared agent boundary",
      actor: owner,
    }) as { project: { id: string; name: string } };
    const project = projectResult.project;
    assert.equal(project.name, "Adapters");
    const created = executeQuestBoardAgentTool(service, "questboard_create_task", {
      projectId: project.id,
      title: "Connect agents",
      status: "ready",
      priority: "high",
      tags: ["mcp", "cli"],
      actor: agent,
    }) as { task: { id: string; status: string } };

    const listed = executeQuestBoardAgentTool(service, "questboard_list_tasks", {
      projectId: project.id,
      status: "ready",
    }) as { tasks: Array<{ id: string }> };
    assert.deepEqual(listed.tasks.map((task) => task.id), [created.task.id]);

    const updated = executeQuestBoardAgentTool(service, "questboard_update_task", {
      taskId: created.task.id,
      status: "in_progress",
      actor: agent,
    }) as { task: { revision: number } };
    assert.equal(updated.task.revision, 2);
    assert.throws(
      () => executeQuestBoardAgentTool(service, "questboard_update_task", {
        taskId: created.task.id,
        expectedRevision: 1,
        status: "review",
        actor: otherAgent,
      }),
      /revision conflict/,
    );

    const claimed = executeQuestBoardAgentTool(service, "questboard_claim_task", {
      taskId: created.task.id,
      actor: agent,
    }) as { claim: { agentId: string } };
    assert.equal(claimed.claim.agentId, agent.id);

    assert.throws(
      () => executeQuestBoardAgentTool(service, "questboard_claim_task", {
        taskId: created.task.id,
        actor: otherAgent,
      }),
      /already claimed/,
    );

    executeQuestBoardAgentTool(service, "questboard_add_activity", {
      taskId: created.task.id,
      type: "agent_handoff",
      summary: "Adapter verification complete",
      actor: agent,
    });
    const artifact = executeQuestBoardAgentTool(service, "questboard_add_artifact", {
      taskId: created.task.id,
      type: "screenshot",
      title: "Adapter proof",
      locator: "screenshots/adapter-proof.png",
      description: "Evidence from the shared tool boundary",
      actor: agent,
    }) as { artifact: { id: string } };
    const artifactList = executeQuestBoardAgentTool(service, "questboard_list_artifacts", {
      taskId: created.task.id,
    }) as { artifacts: Array<{ id: string }> };
    assert.deepEqual(artifactList.artifacts.map((item) => item.id), [artifact.artifact.id]);

    executeQuestBoardAgentTool(service, "questboard_add_relation", {
      fromType: "task",
      fromId: created.task.id,
      toType: "artifact",
      toId: artifact.artifact.id,
      kind: "evidence_for",
      actor: agent,
    });
    const relations = executeQuestBoardAgentTool(service, "questboard_list_relations", {
      taskId: created.task.id,
    }) as { relations: Array<{ kind: string }> };
    assert.equal(relations.relations[0]?.kind, "evidence_for");

    const activity = executeQuestBoardAgentTool(service, "questboard_list_activity", {
      taskId: created.task.id,
    }) as { activities: Array<{ type: string }> };
    assert.deepEqual(activity.activities.map((item) => item.type), [
      "task_created",
      "status_changed",
      "task_claimed",
      "agent_handoff",
      "artifact_attached",
      "relation_added",
    ]);
  } finally {
    repository.close();
  }
});

test("MCP stdio exposes initialize, tools/list, and tools/call over newline JSON-RPC", async () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  const project = service.createProject({ name: "MCP" }, owner);
  service.createTask({ projectId: project.id, title: "Ready via MCP", status: "ready" }, owner);

  const input = new PassThrough();
  const output = new PassThrough();
  let captured = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => { captured += chunk; });

  try {
    const running = runQuestBoardMcpStdio(service, input, output);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "questboard_list_tasks", arguments: { projectId: project.id, status: "ready" } },
    })}\n`);
    input.end();
    await running;

    const messages = captured.trim().split("\n").map((line) => JSON.parse(line) as {
      id: number;
      result: Record<string, unknown>;
    });
    assert.equal(messages.length, 3);
    assert.equal((messages[0]?.result.serverInfo as { name: string }).name, "questboard");
    const toolNames = (messages[1]?.result.tools as Array<{ name: string }>).map((tool) => tool.name);
    assert.ok(toolNames.includes("questboard_create_project"));
    assert.ok(toolNames.includes("questboard_claim_task"));
    assert.ok(toolNames.includes("questboard_add_artifact"));
    assert.ok(toolNames.includes("questboard_add_relation"));
    const content = messages[2]?.result.content as Array<{ text: string }>;
    const payload = JSON.parse(content[0]?.text ?? "{}") as { tasks: Array<{ title: string }> };
    assert.equal(payload.tasks[0]?.title, "Ready via MCP");
  } finally {
    repository.close();
  }
});

test("MCP automatic mutation request ids replay exact retries without colliding on reused JSON-RPC ids", () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  const project = service.createProject({ name: "MCP idempotency" }, owner);
  const task = service.createTask({ projectId: project.id, title: "Reuse RPC id safely", status: "ready" }, owner);
  const handler = createQuestBoardMcpHandler(service);

  try {
    const firstRequest = {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "questboard_update_task",
        arguments: { taskId: task.id, status: "in_progress", actor: agent },
      },
    };
    const first = handler.handle(firstRequest) as { result: { structuredContent: { task: { revision: number } }; isError?: boolean } };
    assert.equal(first.result.isError, undefined);
    assert.equal(first.result.structuredContent.task.revision, 2);

    const replay = handler.handle(firstRequest) as { result: { structuredContent: { task: { revision: number } }; isError?: boolean } };
    assert.equal(replay.result.isError, undefined);
    assert.equal(replay.result.structuredContent.task.revision, 2);
    assert.equal(service.listTaskActivity(task.id).length, 2);

    const reusedId = handler.handle({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "questboard_update_task",
        arguments: { taskId: task.id, description: "A distinct call using the same RPC id", actor: agent },
      },
    }) as { result: { structuredContent: { task: { revision: number } }; isError?: boolean } };
    assert.equal(reusedId.result.isError, undefined);
    assert.equal(reusedId.result.structuredContent.task.revision, 3);
  } finally {
    repository.close();
  }
});

test("CLI uses the same agent tool boundary and supports neutral actor overrides", () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  const project = service.createProject({ name: "CLI" }, owner);
  const task = service.createTask({ projectId: project.id, title: "Claim from CLI", status: "ready" }, owner);
  const stdout: string[] = [];
  const stderr: string[] = [];

  try {
    const listExit = runQuestBoardCli(service, ["tasks", "--project", project.id, "--status", "ready"], {
      io: { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) },
    });
    assert.equal(listExit, 0);
    assert.equal((JSON.parse(stdout.at(-1) ?? "{}") as { tasks: Array<{ id: string }> }).tasks[0]?.id, task.id);

    const claimExit = runQuestBoardCli(
      service,
      ["claim", task.id, "--actor-id", "agent:cli-test", "--actor-provider", "test-cli"],
      { io: { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) } },
    );
    assert.equal(claimExit, 0);
    assert.equal(service.getTaskClaim(task.id)?.agentId, "agent:cli-test");

    const updateExit = runQuestBoardCli(
      service,
      ["update-task", task.id, "--status", "in_progress"],
      { io: { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) } },
    );
    assert.equal(updateExit, 0);
    assert.equal(service.getTask(task.id).revision, 2);

    const artifactExit = runQuestBoardCli(
      service,
      [
        "add-artifact", task.id,
        "--type", "log",
        "--title", "CLI proof",
        "--locator", "logs/cli.log",
        "--actor-id", "agent:cli-test",
        "--actor-provider", "test-cli",
      ],
      { io: { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) } },
    );
    assert.equal(artifactExit, 0);
    const artifactId = (JSON.parse(stdout.at(-1) ?? "{}") as { artifact: { id: string } }).artifact.id;

    const relationExit = runQuestBoardCli(
      service,
      [
        "add-relation",
        "--from-type", "task",
        "--from", task.id,
        "--to-type", "artifact",
        "--to", artifactId,
        "--kind", "evidence_for",
        "--actor-id", "agent:cli-test",
        "--actor-provider", "test-cli",
      ],
      { io: { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) } },
    );
    assert.equal(relationExit, 0);
    assert.equal(service.listTaskArtifacts(task.id).length, 1);
    assert.equal(service.listTaskRelations(task.id)[0]?.kind, "evidence_for");
    assert.deepEqual(stderr, []);
  } finally {
    repository.close();
  }
});
