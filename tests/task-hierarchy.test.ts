import assert from "node:assert/strict";
import test from "node:test";
import {
  QuestBoardService,
  SqliteQuestBoardRepository,
  taskHierarchyEdgeFromRelation,
  type ActorRef,
  type Relation,
} from "../src/index.js";

const human: ActorRef = { id: "human:owner", provider: "human" };

function relation(overrides: Partial<Relation> & Pick<Relation, "fromId" | "toId" | "kind">): Relation {
  return {
    id: overrides.id ?? `relation:${overrides.fromId}:${overrides.toId}:${overrides.kind}`,
    projectId: overrides.projectId ?? "project:test",
    fromType: overrides.fromType ?? "task",
    fromId: overrides.fromId,
    toType: overrides.toType ?? "task",
    toId: overrides.toId,
    kind: overrides.kind,
    label: overrides.label ?? "",
    createdBy: overrides.createdBy ?? human.id,
    createdAt: overrides.createdAt ?? "2026-09-28T00:00:00.000Z",
  };
}

test("normalizes legacy hierarchy relation spellings to one parent-child meaning", () => {
  assert.deepEqual(
    taskHierarchyEdgeFromRelation(relation({ fromId: "parent", toId: "child", kind: "contains" })),
    { parentTaskId: "parent", childTaskId: "child", relationKind: "contains" },
  );
  assert.deepEqual(
    taskHierarchyEdgeFromRelation(relation({ fromId: "child", toId: "parent", kind: "part-of" })),
    { parentTaskId: "parent", childTaskId: "child", relationKind: "part-of" },
  );
  assert.deepEqual(
    taskHierarchyEdgeFromRelation(relation({ fromId: "child", toId: "parent", kind: "part_of" })),
    { parentTaskId: "parent", childTaskId: "child", relationKind: "part_of" },
  );
});

test("canonicalizes new hierarchy writes, rejects cycles and multiple parents, and derives Group progress", () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  try {
    const project = service.createProject({ name: "Task hierarchy" }, human);
    const parent = service.createTask({
      projectId: project.id,
      title: "Code Map",
      status: "in_progress",
    }, human);
    const subgroup = service.createTask({
      projectId: project.id,
      title: "SCIP",
      status: "planned",
    }, human);
    const active = service.createTask({
      projectId: project.id,
      title: "Current implementation",
      status: "ready",
    }, human);
    const done = service.createTask({
      projectId: project.id,
      title: "Completed child",
      status: "done",
    }, human);
    const review = service.createTask({
      projectId: project.id,
      title: "Review child",
      status: "review",
    }, human);
    const blocked = service.createTask({
      projectId: project.id,
      title: "Blocked child",
      status: "blocked",
    }, human);
    const loose = service.createTask({
      projectId: project.id,
      title: "Ungrouped",
      status: "inbox",
    }, human);

    const normalized = service.createRelation({
      fromType: "task",
      fromId: subgroup.id,
      toType: "task",
      toId: parent.id,
      kind: "part_of",
    }, human);
    assert.equal(normalized.kind, "contains");
    assert.equal(normalized.fromId, parent.id);
    assert.equal(normalized.toId, subgroup.id);

    service.createRelation({
      fromType: "task",
      fromId: parent.id,
      toType: "task",
      toId: active.id,
      kind: "contains",
    }, human);
    for (const child of [done, review, blocked]) {
      service.createRelation({
        fromType: "task",
        fromId: subgroup.id,
        toType: "task",
        toId: child.id,
        kind: "contains",
      }, human);
    }

    const hierarchy = service.getTaskHierarchy(project.id);
    assert.deepEqual(new Set(hierarchy.rootTaskIds), new Set([parent.id, loose.id]));
    assert.deepEqual(new Set(hierarchy.rootGroupTaskIds), new Set([parent.id]));
    assert.deepEqual(new Set(hierarchy.ungroupedTaskIds), new Set([loose.id]));
    assert.equal(hierarchy.parentByChild[subgroup.id], parent.id);
    assert.deepEqual(new Set(hierarchy.childrenByParent[parent.id]), new Set([subgroup.id, active.id]));
    assert.deepEqual(hierarchy.ancestryByTask[done.id], [parent.id, subgroup.id]);
    assert.deepEqual(hierarchy.progressByTask[parent.id], {
      total: 5,
      done: 1,
      active: 2,
      review: 1,
      blocked: 1,
    });
    assert.deepEqual(hierarchy.progressByTask[subgroup.id], {
      total: 3,
      done: 1,
      active: 0,
      review: 1,
      blocked: 1,
    });

    const secondParent = service.createTask({
      projectId: project.id,
      title: "Another group",
      status: "planned",
    }, human);
    assert.throws(
      () => service.createRelation({
        fromType: "task",
        fromId: secondParent.id,
        toType: "task",
        toId: active.id,
        kind: "contains",
      }, human),
      /different parent/,
    );
    assert.throws(
      () => service.createRelation({
        fromType: "task",
        fromId: done.id,
        toType: "task",
        toId: parent.id,
        kind: "contains",
      }, human),
      /cycle/,
    );
  } finally {
    repository.close();
  }
});

test("Resume accepts pre-existing part_of hierarchy relations without rewriting legacy data", () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  try {
    const project = service.createProject({ name: "Legacy hierarchy" }, human);
    const parent = service.createTask({
      projectId: project.id,
      title: "Legacy umbrella",
      next: "Continue with the legacy child",
      status: "in_progress",
    }, human);
    const child = service.createTask({
      projectId: project.id,
      title: "Legacy child",
      status: "ready",
    }, human);

    repository.createRelation(
      relation({
        id: "legacy-part-of",
        projectId: project.id,
        fromId: child.id,
        toId: parent.id,
        kind: "part_of",
      }),
      {
        id: "legacy-part-of-activity",
        projectId: project.id,
        taskId: child.id,
        actorId: human.id,
        actorProvider: human.provider,
        type: "relation_added",
        summary: "Legacy relation imported",
        beforeRevision: child.revision,
        afterRevision: child.revision,
        createdAt: "2026-09-28T00:00:00.000Z",
      },
    );
    service.createRelation({
      fromType: "task",
      fromId: parent.id,
      toType: "task",
      toId: child.id,
      kind: "next-task",
    }, human);

    assert.equal(service.resumeTask(parent.id).nextTaskId, child.id);
    const hierarchy = service.getTaskHierarchy(project.id);
    assert.equal(hierarchy.parentByChild[child.id], parent.id);
  } finally {
    repository.close();
  }
});
