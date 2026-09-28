import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  createQuestBoardHttpServer,
  QuestBoardService,
  SqliteQuestBoardRepository,
  type ActorRef,
} from "../src/index.js";

const human: ActorRef = { id: "human:owner", provider: "human" };
const html = readFileSync(resolve("web/index.html"), "utf8");
const app = readFileSync(resolve("web/app.js"), "utf8");
const css = readFileSync(resolve("web/styles.css"), "utf8");

test("Quest stays flat while Flow Work Groups are an explicit nested visual hierarchy", () => {
  assert.match(html, /id="quest-board"/);
  assert.doesNotMatch(html, /id="quest-scope-bar"/);
  assert.match(html, /id="investigation-groups"/);
  assert.match(html, /id="investigation-add-group"/);
  assert.doesNotMatch(html, /id="investigation-groups"[^>]*aria-hidden/);
  assert.match(app, /api\(`\/projects\/\$\{encodeURIComponent\(state\.projectId\)\}\/task-hierarchy`\)/);
  assert.doesNotMatch(app, /questScopeTaskId/);
  assert.doesNotMatch(app, /function renderQuestScopeBar\(\)/);
  assert.match(app, /const statusTasks = state\.tasks\.filter\(\(task\) => task\.status === status\)/);
  assert.match(app, /tasks\.forEach\(\(task\) => list\.append\(renderTaskCard\(task\)\)\)/);
  assert.doesNotMatch(app, /function investigationGroupTaskForNode\(nodeId\)/);
  assert.match(app, /flowWorkGroups/);
  assert.match(app, /flowWorkGroupMemberships/);
  assert.match(app, /function flowWorkGroupDescendantIds\(groupId\)/);
  assert.match(app, /function flowWorkGroupDirectMemberships\(groupId\)/);
  assert.match(app, /function flowWorkGroupPathLabel\(group\)/);
  assert.match(app, /function renderInvestigationGroups\(\)/);
  assert.match(app, /investigation-group-progress/);
  assert.match(app, /investigation-group-goal/);
  assert.match(app, /flow-work-group-task/);
  assert.match(app, /function attachInvestigationGroupDrag\(head, shell, group\)/);
  assert.match(app, /state\.investigationZoom/);
  assert.match(app, /flowWorkGroupSubtreeIds\(group\.id\)/);
  assert.match(app, /entityType: "flow_work_group"/);
  assert.match(app, /persistFlowWorkGroupPosition/);
  assert.match(app, /function commitInvestigationGroupMove\(moves\)/);
  assert.match(app, /state\.investigationUndo\.push\(\{ moves: historyEntries \}\)/);
  assert.match(app, /applyInvestigationHistoryAction\(entry, "from"\)/);
  assert.match(app, /applyInvestigationHistoryAction\(entry, "to"\)/);
  assert.match(app, /const moves = Array\.isArray\(entry\.moves\) \? entry\.moves : \[entry\]/);
  assert.match(app, /renderFlowWorkGroupMembershipSection\("investigation_node", graphNode\.id\)/);
  assert.match(app, /renderFlowWorkGroupMembershipSection\("task", task\.id\)/);
  assert.match(css, /\.quest-board \{/);
  assert.doesNotMatch(css, /\.quest-scope-bar \{/);
  assert.match(css, /\.investigation-groups \{/);
  assert.match(css, /\.investigation-group \{/);
  assert.match(css, /\.investigation-group-head[^}]*touch-action: none/);
  assert.match(css, /\.investigation-group-goal \{/);
  assert.match(css, /\.flow-work-group-task-rail \{/);
});

test("canonical Task hierarchy stays separate from visual Flow group membership", () => {
  assert.match(app, /function renderWorkGroupSection\(task\)/);
  assert.match(app, /"Task hierarchy"/);
  assert.match(app, /"Add to group"/);
  assert.match(app, /"Remove"/);
  assert.match(app, /"Create group"/);
  assert.match(app, /async function addTaskToGroup\(taskId, parentTaskId\)/);
  assert.match(app, /async function removeTaskFromGroup\(taskId, relationId\)/);
  assert.match(app, /async function createGroupAroundTask\(taskId, title\)/);
  assert.match(app, /kind: "contains"/);
  assert.match(app, /api\(`\/relations\/\$\{encodeURIComponent\(relationId\)\}`[\s\S]*method: "DELETE"/);
  assert.match(app, /This does not change the canonical Task hierarchy/);
  assert.match(app, /detailsContent\.append\(summary, claimSection, evidenceSection, activitySection\)/);
  assert.match(css, /\.work-group-section/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.work-group-form \{ grid-template-columns: 1fr; \}/);
});

test("HTTP persists nested visual Flow groups and direct memberships independently of Task hierarchy", async () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  const server = createQuestBoardHttpServer(service, { webRoot: resolve("web") });

  try {
    const project = service.createProject({ name: "Visual Flow" }, human);
    const umbrella = service.createTask({ projectId: project.id, title: "Code Map", status: "in_progress" }, human);
    const looseTask = service.createTask({ projectId: project.id, title: "Cross-cutting cleanup", status: "ready" }, human);
    const nestedTask = service.createTask({ projectId: project.id, title: "SCIP semantics", status: "ready" }, human);
    const graphNode = service.createInvestigationNode({ projectId: project.id, title: "SCIP transition" }, human);

    await listen(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const parentRead = await jsonRequest<{ group: { id: string; linkedTaskId?: string; revision: number } }>(
      `${baseUrl}/projects/${project.id}/flow-work-groups`,
      { method: "POST", actor: human, body: { title: "Code Map", linkedTaskId: umbrella.id, x: 80, y: 70, width: 820, height: 520 } },
    );
    assert.equal(parentRead.response.status, 201);
    assert.equal(parentRead.body.group.linkedTaskId, umbrella.id);
    const parentId = parentRead.body.group.id;

    const childRead = await jsonRequest<{ group: { id: string; parentGroupId?: string } }>(
      `${baseUrl}/projects/${project.id}/flow-work-groups`,
      { method: "POST", actor: human, body: { title: "SCIP", parentGroupId: parentId, x: 120, y: 170, width: 420, height: 260 } },
    );
    assert.equal(childRead.body.group.parentGroupId, parentId);
    const childId = childRead.body.group.id;

    await jsonRequest(`${baseUrl}/flow-work-groups/${parentId}/members/task/${looseTask.id}`, { method: "PUT", actor: human });
    await jsonRequest(`${baseUrl}/flow-work-groups/${childId}/members/task/${nestedTask.id}`, { method: "PUT", actor: human });
    await jsonRequest(`${baseUrl}/flow-work-groups/${childId}/members/investigation_node/${graphNode.id}`, { method: "PUT", actor: human });

    const graph = await jsonRequest<{
      flowWorkGroups: Array<{ id: string; parentGroupId?: string }>;
      flowWorkGroupMemberships: Array<{ groupId: string; entityType: string; entityId: string }>;
    }>(`${baseUrl}/projects/${project.id}/investigation/graph`);
    assert.equal(graph.body.flowWorkGroups.find((group) => group.id === childId)?.parentGroupId, parentId);
    assert.deepEqual(
      graph.body.flowWorkGroupMemberships
        .map((membership) => [membership.groupId, membership.entityType, membership.entityId])
        .sort((left, right) => left.join(":").localeCompare(right.join(":"))),
      [
        [parentId, "task", looseTask.id],
        [childId, "task", nestedTask.id],
        [childId, "investigation_node", graphNode.id],
      ].sort((left, right) => left.join(":").localeCompare(right.join(":"))),
    );

    assert.equal(service.getTask(looseTask.id).id, looseTask.id);
    assert.equal(service.getTask(nestedTask.id).id, nestedTask.id);
    assert.equal(service.getTaskHierarchy(project.id).parentByChild[looseTask.id], undefined);
  } finally {
    await closeServer(server);
    repository.close();
  }
});

test("HTTP exposes derived Task hierarchy and semantic relation removal", async () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  const server = createQuestBoardHttpServer(service, { webRoot: resolve("web") });

  try {
    const project = service.createProject({ name: "Scoped Quest" }, human);
    const parent = service.createTask({ projectId: project.id, title: "Code Map", status: "in_progress" }, human);
    const child = service.createTask({ projectId: project.id, title: "SCIP", status: "ready" }, human);
    const relation = service.createRelation({
      fromType: "task",
      fromId: parent.id,
      toType: "task",
      toId: child.id,
      kind: "contains",
    }, human);

    await listen(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const hierarchyRead = await jsonRequest<{
      hierarchy: {
        parentByChild: Record<string, string>;
        childrenByParent: Record<string, string[]>;
        progressByTask: Record<string, { total: number; active: number }>;
      };
    }>(`${baseUrl}/projects/${project.id}/task-hierarchy`);
    assert.equal(hierarchyRead.response.status, 200);
    assert.equal(hierarchyRead.body.hierarchy.parentByChild[child.id], parent.id);
    assert.deepEqual(hierarchyRead.body.hierarchy.childrenByParent[parent.id], [child.id]);
    assert.equal(hierarchyRead.body.hierarchy.progressByTask[parent.id]?.total, 1);
    assert.equal(hierarchyRead.body.hierarchy.progressByTask[parent.id]?.active, 1);

    const deleted = await jsonRequest<{ deleted: boolean }>(`${baseUrl}/relations/${relation.id}`, {
      method: "DELETE",
      actor: human,
    });
    assert.equal(deleted.response.status, 200);
    assert.equal(deleted.body.deleted, true);

    const afterDelete = await jsonRequest<{
      hierarchy: { parentByChild: Record<string, string>; rootTaskIds: string[] };
    }>(`${baseUrl}/projects/${project.id}/task-hierarchy`);
    assert.equal(afterDelete.body.hierarchy.parentByChild[child.id], undefined);
    assert.equal(afterDelete.body.hierarchy.rootTaskIds.includes(child.id), true);
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
  body?: unknown;
}

async function jsonRequest<T>(url: string, options: RequestOptions = {}): Promise<{ response: Response; body: T }> {
  const headers = new Headers();
  if (options.actor) {
    headers.set("x-questboard-actor-id", options.actor.id);
    headers.set("x-questboard-actor-provider", options.actor.provider);
  }
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { response, body: (await response.json()) as T };
}
