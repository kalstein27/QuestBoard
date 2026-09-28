import assert from "node:assert/strict";
import test from "node:test";
import {
  executeQuestBoardAgentTool,
  QuestBoardService,
  SqliteQuestBoardRepository,
  type ActorRef,
} from "../src/index.js";

const human: ActorRef = { id: "human:owner", provider: "human" };
const agent: ActorRef = { id: "agent:flow", provider: "test-agent" };

test("nested Flow Work Groups preserve an explicit visual hierarchy independently of Task hierarchy", () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);

  try {
    const project = service.createProject({ name: "Visual Work" }, human);
    const otherProject = service.createProject({ name: "Other" }, human);
    const umbrellaTask = service.createTask({ projectId: project.id, title: "Code Map", status: "in_progress" }, human);
    const directTask = service.createTask({ projectId: project.id, title: "Shared cleanup", status: "ready" }, human);
    const nestedTask = service.createTask({ projectId: project.id, title: "SCIP semantics", status: "planned" }, human);
    const node = service.createInvestigationNode({ projectId: project.id, title: "SCIP transition" }, human);
    const foreignTask = service.createTask({ projectId: otherProject.id, title: "Foreign task", status: "ready" }, human);
    const foreignNode = service.createInvestigationNode({ projectId: otherProject.id, title: "Foreign" }, human);
    const foreignParent = service.createFlowWorkGroup({ projectId: otherProject.id, title: "Foreign group" }, human);

    const parent = service.createFlowWorkGroup({
      projectId: project.id,
      title: "Code Map",
      goal: "Keep Code Map work spatially legible",
      linkedTaskId: umbrellaTask.id,
      x: 80,
      y: 60,
      width: 900,
      height: 600,
    }, human);
    const child = service.createFlowWorkGroup({
      projectId: project.id,
      title: "SCIP",
      parentGroupId: parent.id,
      x: 140,
      y: 180,
      width: 460,
      height: 300,
    }, human);

    service.setFlowWorkGroupMembership({ groupId: parent.id, entityType: "task", entityId: directTask.id }, human);
    service.setFlowWorkGroupMembership({ groupId: child.id, entityType: "task", entityId: nestedTask.id }, human);
    service.setFlowWorkGroupMembership({ groupId: child.id, entityType: "investigation_node", entityId: node.id }, human);

    const graph = service.getInvestigationGraph(project.id);
    assert.equal(graph.flowWorkGroups.find((group) => group.id === child.id)?.parentGroupId, parent.id);
    assert.equal(graph.flowWorkGroups.find((group) => group.id === parent.id)?.linkedTaskId, umbrellaTask.id);
    assert.deepEqual(
      graph.flowWorkGroupMemberships
        .map((membership) => [membership.groupId, membership.entityType, membership.entityId])
        .sort((left, right) => left.join(":").localeCompare(right.join(":"))),
      [
        [parent.id, "task", directTask.id],
        [child.id, "task", nestedTask.id],
        [child.id, "investigation_node", node.id],
      ].sort((left, right) => left.join(":").localeCompare(right.join(":"))),
    );
    assert.equal(service.getTaskHierarchy(project.id).parentByChild[directTask.id], undefined);
    assert.equal(service.getTaskHierarchy(project.id).parentByChild[nestedTask.id], undefined);

    service.setFlowWorkGroupMembership({ groupId: child.id, entityType: "task", entityId: directTask.id }, human);
    assert.deepEqual(
      repository.listFlowWorkGroupMemberships(project.id)
        .filter((membership) => membership.entityId === directTask.id)
        .map((membership) => membership.groupId),
      [child.id],
    );

    assert.throws(
      () => service.setFlowWorkGroupMembership({ groupId: parent.id, entityType: "investigation_node", entityId: foreignNode.id }, human),
      /same project/,
    );
    assert.throws(
      () => service.setFlowWorkGroupMembership({ groupId: parent.id, entityType: "task", entityId: foreignTask.id }, human),
      /same project/,
    );
    assert.throws(
      () => service.createFlowWorkGroup({ projectId: project.id, title: "Foreign parent", parentGroupId: foreignParent.id }, human),
      /same project/,
    );
    assert.throws(
      () => service.createFlowWorkGroup({ projectId: project.id, title: "Foreign linked task", linkedTaskId: foreignTask.id }, human),
      /same project/,
    );
    assert.throws(
      () => service.updateFlowWorkGroup(parent.id, { parentGroupId: child.id, expectedRevision: parent.revision }, human),
      /cycle/,
    );

    const movedChild = service.updateFlowWorkGroup(child.id, {
      x: 210,
      y: 240,
      expectedRevision: child.revision,
    }, agent);
    assert.equal(movedChild.x, 210);
    assert.equal(movedChild.y, 240);
    assert.equal(movedChild.parentGroupId, parent.id);

    const parentOnlyTask = service.createTask({ projectId: project.id, title: "Parent-only", status: "inbox" }, human);
    service.setFlowWorkGroupMembership({ groupId: parent.id, entityType: "task", entityId: parentOnlyTask.id }, human);
    service.deleteFlowWorkGroup(parent.id, human, { expectedRevision: parent.revision });
    assert.equal(service.getFlowWorkGroup(child.id).parentGroupId, undefined);
    assert.equal(service.getTask(parentOnlyTask.id).id, parentOnlyTask.id);
    assert.equal(
      repository.listFlowWorkGroupMemberships(project.id).some((membership) => membership.entityId === parentOnlyTask.id),
      false,
    );

    service.deleteInvestigationNode(node.id, human);
    assert.equal(
      repository.listFlowWorkGroupMemberships(project.id).some((membership) => membership.entityId === node.id),
      false,
    );
  } finally {
    repository.close();
  }
});

test("shared agent tools create visual groups and memberships without inventing Task hierarchy edges", () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  try {
    const project = service.createProject({ name: "Agent Flow" }, human);
    const task = service.createTask({ projectId: project.id, title: "Ungrouped task", status: "ready" }, human);

    const created = executeQuestBoardAgentTool(service, "questboard_create_flow_work_group", {
      projectId: project.id,
      title: "Code Map",
      x: 40,
      y: 50,
      width: 700,
      height: 420,
      actor: agent,
    }) as { group: { id: string } };

    executeQuestBoardAgentTool(service, "questboard_set_flow_work_group_member", {
      groupId: created.group.id,
      entityType: "task",
      entityId: task.id,
      actor: agent,
    });

    const graph = executeQuestBoardAgentTool(service, "questboard_get_investigation_graph", {
      projectId: project.id,
    }) as { flowWorkGroups: Array<{ id: string }>; flowWorkGroupMemberships: Array<{ groupId: string; entityId: string }> };
    assert.equal(graph.flowWorkGroups[0]?.id, created.group.id);
    assert.deepEqual(graph.flowWorkGroupMemberships.map((membership) => membership.entityId), [task.id]);
    assert.equal(service.getTaskHierarchy(project.id).parentByChild[task.id], undefined);
  } finally {
    repository.close();
  }
});