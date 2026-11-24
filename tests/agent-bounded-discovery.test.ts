import assert from "node:assert/strict";
import test from "node:test";
import {
  QuestBoardService, SqliteQuestBoardRepository, createQuestBoardMcpHandler,
  executeQuestBoardAgentTool, QUESTBOARD_AGENT_TOOLS,
} from "../src/index.js";

const actor = { id: "test:bounded-discovery", provider: "test" };
type Page = { offset: number; total: number; returned: number; nextOffset: number | null };
type Listed = { tasks: Array<Record<string, unknown>>; page?: Page };

test("large agent Task reads are bounded, discoverable and lossless across pages", () => {
  const repo = new SqliteQuestBoardRepository();
  try {
    const service = new QuestBoardService(repo);
    const project = service.createProject({ name: "Large project" }, actor);
    const other = service.createProject({ name: "Other project" }, actor);
    const expected = new Set<string>();
    for (let i = 0; i < 213; i++) {
      const task = service.createTask({ projectId: project.id, title: "Task " + i,
        description: "내용".repeat(1000), now: "progress".repeat(300), status: i % 2 ? "ready" : "done" }, actor);
      expected.add(task.id);
    }
    service.createTask({ projectId: other.id, title: "Do not include" }, actor);
    const handler = createQuestBoardMcpHandler(service);
    const call = (args: Record<string, unknown>) => {
      const response = handler.handle({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "questboard_list_tasks", arguments: { projectId: project.id, ...args } } }) as
        { result: { structuredContent: Listed; isError?: boolean } };
      assert.ok(!response.result.isError);
      assert.ok(Buffer.byteLength(JSON.stringify(response.result)) < 1024 * 1024);
      return response.result.structuredContent;
    };
    const legacyFirst = call({});
    assert.ok(legacyFirst.page?.nextOffset);
    assert.ok(legacyFirst.tasks[0]?.description);
    for (const view of ["full", "summary"]) {
      const seen = new Set<unknown>();
      let offset: number | null = 0;
      while (offset !== null) {
        const result = call({ view, offset, limit: 100 });
        assert.equal(result.page?.total, 213);
        assert.ok(result.tasks.length > 0);
        for (const row of result.tasks) {
          assert.ok(!seen.has(row.id));
          seen.add(row.id);
          assert.equal("description" in row, view === "full");
          assert.equal("now" in row, view === "full");
        }
        offset = result.page!.nextOffset;
      }
      assert.deepEqual(seen, expected);
    }
    assert.equal(call({ view: "summary", status: "ready", limit: 100 }).page?.total, 106);
    assert.equal(call({ view: "summary", offset: 999 }).page?.nextOffset, null);
    assert.throws(() => executeQuestBoardAgentTool(service, "questboard_list_tasks",
      { projectId: project.id, limit: 101 }), /limit/);
    assert.throws(() => executeQuestBoardAgentTool(service, "questboard_list_tasks",
      { projectId: project.id, offset: -1 }), /offset/);
    assert.deepEqual(executeQuestBoardAgentTool(service, "questboard_list_tasks", { projectId: other.id }),
      { tasks: service.listTasks({ projectId: other.id }) });
  } finally { repo.close(); }
});

test("large graph returns actionable MCP error, group discovery never reads full graph", () => {
  const repo = new SqliteQuestBoardRepository();
  try {
    const service = new QuestBoardService(repo);
    const project = service.createProject({ name: "Flow" }, actor);
    const task = service.createTask({ projectId: project.id, title: "Big", description: "x".repeat(160_000) }, actor);
    const group = service.createFlowWorkGroup({ projectId: project.id, title: "Video", linkedTaskId: task.id }, actor);
    const child = service.createFlowWorkGroup({ projectId: project.id, title: "Encoder", parentGroupId: group.id }, actor);
    assert.ok(QUESTBOARD_AGENT_TOOLS.some(t => t.name === "questboard_list_flow_work_groups"));
    const handler = createQuestBoardMcpHandler(service);
    const full = handler.handle({ jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "questboard_get_investigation_graph", arguments: { projectId: project.id } } }) as
      { result: { isError: boolean; structuredContent: { error: { code: string; message: string } } } };
    assert.equal(full.result.isError, true);
    assert.equal(full.result.structuredContent.error.code, "response_too_large");
    assert.match(full.result.structuredContent.error.message, /questboard_list_flow_work_groups/);
    assert.equal(service.getInvestigationGraph(project.id).tasks[0]?.description.length, 160_000);
    service.getInvestigationGraph = () => { throw new Error("full graph must not be loaded"); };
    const groups = executeQuestBoardAgentTool(service, "questboard_list_flow_work_groups", { projectId: project.id }) as
      { groups: Array<{ id: string; parentGroupId?: string; linkedTaskId?: string }>; page: Page };
    assert.equal(groups.page.total, 2);
    assert.equal(groups.groups.find(g => g.id === group.id)?.linkedTaskId, task.id);
    assert.equal(groups.groups.find(g => g.id === child.id)?.parentGroupId, group.id);
    assert.equal(groups.page.nextOffset, null);
    const compact = executeQuestBoardAgentTool(service, "questboard_list_tasks", { projectId: project.id, view: "summary" }) as Listed;
    assert.equal(compact.tasks.length, 1);
    assert.ok(!("description" in compact.tasks[0]!));
    assert.throws(() => executeQuestBoardAgentTool(service, "questboard_list_tasks", { projectId: project.id }),
      /view=summary/);
  } finally { repo.close(); }
});