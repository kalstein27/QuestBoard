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

test("Quest Group Web scopes the board to direct children and keeps Group progress/read state derived", () => {
  assert.match(html, /id="quest-board"/);
  assert.match(html, /id="quest-scope-bar"/);
  assert.match(app, /api\(`\/projects\/\$\{encodeURIComponent\(state\.projectId\)\}\/task-hierarchy`\)/);
  assert.match(app, /function questDirectTaskIds\(\)[\s\S]*rootTaskIds/);
  assert.match(app, /if \(state\.questScopeTaskId\) return hierarchyChildren\(state\.questScopeTaskId\)/);
  assert.match(app, /function renderQuestScopeBar\(\)/);
  assert.match(app, /quest-breadcrumb/);
  assert.match(app, /aria-label", "Quest group breadcrumb/);
  assert.match(app, /function renderQuestCard\(task\)[\s\S]*renderGroupCard\(task\)/);
  assert.match(app, /function renderGroupCard\(task\)/);
  assert.match(app, /progress\.done[}\/$\s\{]*progress\.total|\$\{progress\.done\}\/\$\{progress\.total\} done/);
  assert.match(app, /unseenDoneDescendantCount\(task\.id\)/);
  assert.match(app, /groupFocusChild\(task\.id\)/);
  assert.match(app, /relation\.kind === "next-task"/);
  assert.match(app, /function shouldShowQuestTask\(task\)[\s\S]*hasOpenDescendant[\s\S]*unseenDoneDescendantCount/);
  assert.match(css, /\.quest-board \{/);
  assert.match(css, /\.quest-scope-bar \{/);
  assert.match(css, /\.quest-group-card \{/);
  assert.match(css, /\.quest-group-signal\.new/);
});

test("Quest Group Web exposes semantic membership actions without replacing generic Relations", () => {
  assert.match(app, /function renderWorkGroupSection\(task\)/);
  assert.match(app, /"Add to group"/);
  assert.match(app, /"Remove"/);
  assert.match(app, /"Create group"/);
  assert.match(app, /async function addTaskToGroup\(taskId, parentTaskId\)/);
  assert.match(app, /async function removeTaskFromGroup\(taskId, relationId\)/);
  assert.match(app, /async function createGroupAroundTask\(taskId, title\)/);
  assert.match(app, /kind: "contains"/);
  assert.match(app, /api\(`\/relations\/\$\{encodeURIComponent\(relationId\)\}`[\s\S]*method: "DELETE"/);
  assert.match(app, /state\.questScopeTaskId[\s\S]*label: "Created inside scoped Quest group"/);
  assert.match(app, /detailsContent\.append\(summary, claimSection, evidenceSection, activitySection\)/);
  assert.match(css, /\.work-group-section/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.work-group-form \{ grid-template-columns: 1fr; \}/);
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
}

async function jsonRequest<T>(url: string, options: RequestOptions = {}): Promise<{ response: Response; body: T }> {
  const headers = new Headers();
  if (options.actor) {
    headers.set("x-questboard-actor-id", options.actor.id);
    headers.set("x-questboard-actor-provider", options.actor.provider);
  }
  const response = await fetch(url, { method: options.method ?? "GET", headers });
  return { response, body: (await response.json()) as T };
}
