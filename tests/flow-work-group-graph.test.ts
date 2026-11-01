import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { DatabaseSync, backup } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createQuestBoardHttpServer,
  createQuestBoardMcpHandler,
  executeQuestBoardAgentTool,
  QuestBoardService,
  QUESTBOARD_AGENT_TOOLS,
  SqliteQuestBoardRepository,
  type FlowWorkGroupGraph,
  type ActorRef,
} from "../src/index.js";

const actor: ActorRef = { id: "human:flow-test", provider: "human" };
const toolName = "questboard_get_flow_work_group_graph";

test("MCP and HTTP restore only a direct Flow Work Group's persisted directed graph", async () => {
  const repo = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repo);
  const server = createQuestBoardHttpServer(service);
  try {
    const project = service.createProject({ name: "Flow Graph Test" }, actor);
    const group = service.createFlowWorkGroup({ projectId: project.id, title: "Video flow", goal: "Restore branch and join" }, actor);
    const child = service.createFlowWorkGroup({ projectId: project.id, parentGroupId: group.id, title: "Nested" }, actor);
    const titles = ["Capture", "Encoder", "Server", "Wi-Fi Aware", "LAN", "Receiver", "Renderer"];
    const nodes = titles.map((title) => service.createInvestigationNode({
      projectId: project.id, title, description: `Path: src/${title.toLowerCase().replaceAll(" ", "-")}.ts`,
    }, actor));
    for (const node of nodes) service.setFlowWorkGroupMembership({
      groupId: group.id, entityType: "investigation_node", entityId: node.id,
    }, actor);
    const items = nodes.map((node) => service.createInvestigationItem({
      nodeId: node.id, title: `${node.title} output`, description: `Output of ${node.title}`,
    }, actor));
    const extraItem = service.createInvestigationItem({ nodeId: nodes[0]!.id, title: "Mac encoder path" }, actor);
    const edges: Array<[number, number, string]> = [
      [0, 1, "frame"], [1, 2, "h264"], [2, 3, "WA"], [2, 4, "LAN"],
      [3, 5, "WA receive"], [4, 5, "LAN receive"], [5, 6, "render"],
    ];
    const links = edges.map(([from, to, label]) => service.createInvestigationItemLink({
      fromItemId: items[from]!.id, toNodeId: nodes[to]!.id, label, kind: "video-flow",
    }, actor));

    const task = service.createTask({ projectId: project.id, title: "Overlay task" }, actor);
    service.setFlowWorkGroupMembership({ groupId: group.id, entityType: "task", entityId: task.id }, actor);
    const external = service.createInvestigationNode({ projectId: project.id, title: "External decoder" }, actor);
    service.setFlowWorkGroupMembership({ groupId: child.id, entityType: "investigation_node", entityId: external.id }, actor);
    const externalLink = service.createInvestigationItemLink({
      fromItemId: extraItem.id, toNodeId: external.id, label: "external ref", kind: "fallback",
    }, actor);
    const unrelatedItem = service.createInvestigationItem({ nodeId: external.id, title: "Outside item" }, actor);
    service.createInvestigationItemLink({ fromItemId: unrelatedItem.id, toNodeId: nodes[0]!.id }, actor);

    assert.ok(QUESTBOARD_AGENT_TOOLS.some((tool) => tool.name === toolName));
    const revisionBefore = service.getFlowWorkGroup(group.id).revision;
    const graph = executeQuestBoardAgentTool(service, toolName, { groupId: group.id }) as FlowWorkGroupGraph;
    assert.equal(graph.group.title, "Video flow");
    assert.equal(graph.group.goal, "Restore branch and join");
    assert.equal(graph.nodes.length, 7);
    assert.equal(graph.items.length, 8);
    assert.equal(graph.itemLinks.length, 8); // 7 internal + 1 outbound external reference
    assert.equal(graph.memberships.length, 8); // 7 direct nodes + 1 direct task
    assert.ok(!graph.nodes.some((node) => node.id === external.id));
    assert.ok(!graph.items.some((item) => item.id === unrelatedItem.id));
    assert.ok(graph.itemLinks.some((link) => link.id === externalLink.id && link.toNodeId === external.id));
    assert.deepEqual(
      links.map((link) => graph.itemLinks.find((entry) => entry.id === link.id)?.label),
      links.map((link) => link.label),
    );
    assert.equal(graph.itemLinks.filter((link) => link.fromItemId === items[2]!.id).length, 2);
    assert.equal(graph.itemLinks.filter((link) => link.toNodeId === nodes[5]!.id).length, 2);
    assert.equal(service.getFlowWorkGroup(group.id).revision, revisionBefore);

    const handler = createQuestBoardMcpHandler(service);
    const mcp = handler.handle({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: toolName, arguments: { groupId: group.id } },
    }) as { result: { isError?: boolean; structuredContent: FlowWorkGroupGraph } };
    assert.equal(mcp.result.isError, undefined);
    assert.deepEqual(mcp.result.structuredContent, graph);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const http = await fetch(`${baseUrl}/flow-work-groups/${group.id}/graph`);
    assert.equal(http.status, 200);
    assert.deepEqual(await http.json(), graph);

    const missing = await fetch(`${baseUrl}/flow-work-groups/does-not-exist/graph`);
    assert.equal(missing.status, 404);
    const mcpMissing = handler.handle({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: toolName, arguments: { groupId: "does-not-exist" } },
    }) as { result: { isError: boolean; structuredContent: { error: { code: string } } } };
    assert.equal(mcpMissing.result.isError, true);
    assert.equal(mcpMissing.result.structuredContent.error.code, "not_found");
    assert.equal(service.getFlowWorkGroup(group.id).revision, revisionBefore);
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    repo.close();
  }
});

test("oversized group graphs fail explicitly on service, MCP, and HTTP without partial data", async () => {
  const repo = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repo);
  const server = createQuestBoardHttpServer(service);
  try {
    const project = service.createProject({ name: "Oversized graph" }, actor);
    const group = service.createFlowWorkGroup({ projectId: project.id, title: "Too big" }, actor);
    const node = service.createInvestigationNode({
      projectId: project.id, title: "Huge description", description: "x".repeat(70_000),
    }, actor);
    service.setFlowWorkGroupMembership({
      groupId: group.id, entityType: "investigation_node", entityId: node.id,
    }, actor);
    assert.throws(() => service.getFlowWorkGroupGraph(group.id), /64 KiB/);
    const handler = createQuestBoardMcpHandler(service);
    const mcp = handler.handle({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: toolName, arguments: { groupId: group.id } },
    }) as { result: { isError: boolean; structuredContent: { error: { code: string } } } };
    assert.equal(mcp.result.isError, true);
    assert.equal(mcp.result.structuredContent.error.code, "flow_graph_too_large");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/flow-work-groups/${group.id}/graph`);
    assert.equal(response.status, 413);
    const body = await response.json() as { error: { code: string } };
    assert.equal(body.error.code, "flow_graph_too_large");
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    repo.close();
  }
});

const liveDbPath = process.env.QUESTBOARD_FLOW_GROUP_LIVE_DB;
test("opt-in live TouchPilot group: snapshot read-only DB and verify MCP/HTTP equivalence", {
  skip: !liveDbPath,
}, async () => {
  if (!liveDbPath) return;
  const dir = await mkdtemp(join(tmpdir(), "questboard-flow-verify-"));
  const source = new DatabaseSync(liveDbPath, { readOnly: true });
  try {
    // All migrations and test connections run against the isolated backup, not the live DB.
    await backup(source, join(dir, "snapshot.sqlite"));
    const repo = new SqliteQuestBoardRepository(join(dir, "snapshot.sqlite"));
    const service = new QuestBoardService(repo);
    const server = createQuestBoardHttpServer(service);
    try {
      const groupId = "2d0b6fb5-fa5b-450b-bf76-b49adef9248f";
      const before = service.getFlowWorkGroup(groupId);
      const handler = createQuestBoardMcpHandler(service);
      const mcp = handler.handle({
        jsonrpc: "2.0", id: 10, method: "tools/call",
        params: { name: toolName, arguments: { groupId } },
      }) as { result: { isError?: boolean; structuredContent: FlowWorkGroupGraph } };
      assert.equal(mcp.result.isError, undefined);
      const graph = mcp.result.structuredContent;
      assert.equal(graph.group.id, groupId);
      assert.equal(graph.nodes.length, 7);
      assert.equal(graph.items.length, 8);
      assert.equal(graph.itemLinks.length, 7);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/flow-work-groups/${groupId}/graph`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), graph);
      assert.deepEqual(service.getFlowWorkGroup(groupId), before);
      const itemById = new Map(graph.items.map((item) => [item.id, item]));
      const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
      const edges = graph.itemLinks.map((link) => {
        const item = itemById.get(link.fromItemId);
        assert.ok(item, "Every outgoing link must retain its source Item");
        const from = nodeById.get(item.nodeId)?.title;
        const to = nodeById.get(link.toNodeId)?.title;
        assert.ok(from && to, "All 7 real TouchPilot links must resolve inside the group");
        return { from, via: item.title, to, label: link.label, kind: link.kind };
      });
      assert.ok(edges.some((edge) => edge.from.startsWith("Mac") && edge.to.startsWith("③")));
      assert.ok(edges.some((edge) => edge.label.startsWith("WA 성공") && edge.to.startsWith("⑤")));
      assert.ok(edges.some((edge) => edge.label.startsWith("WA 실패") && edge.to.startsWith("⑤")));
      console.log("TOUCHPILOT_FLOW_EDGES " + JSON.stringify({ group: graph.group.title, goal: graph.group.goal, edges }));
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      repo.close();
    }
  } finally {
    source.close();
    await rm(dir, { recursive: true, force: true });
  }
});
