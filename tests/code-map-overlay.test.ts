import assert from "node:assert/strict";
import test from "node:test";
import {
  overlayCodeMapTasks,
  type CodeArchitectureProjection,
  type CodeMapTaskLink,
} from "../src/index.js";

function projection(): CodeArchitectureProjection {
  return {
    projectId: "questboard",
    sourceIndexedAt: "2026-09-22T13:00:00.000Z",
    nodes: [
      {
        id: "code-map:node:application",
        kind: "application_service",
        title: "Application Service",
        memberNodeIds: ["raw:service"],
      },
      {
        id: "code-map:node:sqlite",
        kind: "sqlite_repository",
        title: "SQLite Repository",
        memberNodeIds: ["raw:sqlite"],
      },
    ],
    relations: [],
  };
}

test("Task overlay attaches links only to stable architecture node ids", () => {
  const links: CodeMapTaskLink[] = [
    { taskId: "task-1", codeNodeId: "code-map:node:application", kind: "affects" },
    { taskId: "task-1", codeNodeId: "code-map:node:sqlite", kind: "implemented_in" },
    { taskId: "task-1", codeNodeId: "code-map:node:application", kind: "affects" },
  ];

  const overlay = overlayCodeMapTasks(projection(), links);

  assert.equal(overlay.orphanedLinks.length, 0);
  assert.deepEqual(overlay.nodes[0]?.taskLinks, [links[0]]);
  assert.deepEqual(overlay.nodes[1]?.taskLinks, [links[1]]);
});

test("Task overlay survives raw member reindex when macro node identity stays stable", () => {
  const link: CodeMapTaskLink = {
    taskId: "task-2",
    codeNodeId: "code-map:node:application",
    kind: "investigates",
  };
  const first = overlayCodeMapTasks(projection(), [link]);
  const refreshed = projection();
  refreshed.nodes = refreshed.nodes.map((node) => ({
    ...node,
    memberNodeIds: node.memberNodeIds.map((id) => `reindexed:${id}`),
  }));
  const second = overlayCodeMapTasks(refreshed, [link]);

  assert.deepEqual(first.nodes[0]?.taskLinks, second.nodes[0]?.taskLinks);
});

test("Task overlay reports stale links instead of silently attaching them elsewhere", () => {
  const stale: CodeMapTaskLink = {
    taskId: "task-3",
    codeNodeId: "code-map:node:removed",
    kind: "affects",
  };

  const overlay = overlayCodeMapTasks(projection(), [stale]);

  assert.deepEqual(overlay.orphanedLinks, [stale]);
  assert.equal(overlay.nodes.every((node) => node.taskLinks.length === 0), true);
});
