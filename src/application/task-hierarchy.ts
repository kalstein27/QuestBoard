import type { Relation, RelationEntityType, Task, TaskStatus } from "../core/domain.js";

export const TASK_HIERARCHY_CANONICAL_KIND = "contains";
const TASK_HIERARCHY_LEGACY_KINDS = new Set(["part-of", "part_of"]);

export interface TaskHierarchyRelationLike {
  fromType: RelationEntityType;
  fromId: string;
  toType: RelationEntityType;
  toId: string;
  kind: string;
}

export interface TaskHierarchyEdge {
  parentTaskId: string;
  childTaskId: string;
  relationKind: string;
}

export interface TaskHierarchyProgress {
  total: number;
  done: number;
  active: number;
  review: number;
  blocked: number;
}

export interface TaskHierarchySnapshot {
  projectId: string;
  rootTaskIds: string[];
  rootGroupTaskIds: string[];
  ungroupedTaskIds: string[];
  parentByChild: Record<string, string>;
  childrenByParent: Record<string, string[]>;
  ancestryByTask: Record<string, string[]>;
  progressByTask: Record<string, TaskHierarchyProgress>;
}

export function taskHierarchyEdgeFromRelation(
  relation: TaskHierarchyRelationLike,
): TaskHierarchyEdge | undefined {
  if (relation.fromType !== "task" || relation.toType !== "task") return undefined;

  if (relation.kind === TASK_HIERARCHY_CANONICAL_KIND) {
    return {
      parentTaskId: relation.fromId,
      childTaskId: relation.toId,
      relationKind: relation.kind,
    };
  }

  if (TASK_HIERARCHY_LEGACY_KINDS.has(relation.kind)) {
    return {
      parentTaskId: relation.toId,
      childTaskId: relation.fromId,
      relationKind: relation.kind,
    };
  }

  return undefined;
}

export function canonicalTaskHierarchyRelation(
  relation: TaskHierarchyRelationLike,
): TaskHierarchyRelationLike | undefined {
  const edge = taskHierarchyEdgeFromRelation(relation);
  if (!edge) return undefined;

  return {
    fromType: "task",
    fromId: edge.parentTaskId,
    toType: "task",
    toId: edge.childTaskId,
    kind: TASK_HIERARCHY_CANONICAL_KIND,
  };
}

export function assertCanAddTaskHierarchyEdge(
  parentTaskId: string,
  childTaskId: string,
  relations: readonly Relation[],
): void {
  const edges = relations
    .map(taskHierarchyEdgeFromRelation)
    .filter((edge): edge is TaskHierarchyEdge => edge !== undefined);

  const existingParents = new Set(
    edges
      .filter((edge) => edge.childTaskId === childTaskId)
      .map((edge) => edge.parentTaskId),
  );
  if ([...existingParents].some((existingParentId) => existingParentId !== parentTaskId)) {
    throw new TypeError("Task hierarchy child already has a different parent");
  }

  const childrenByParent = new Map<string, Set<string>>();
  for (const edge of edges) {
    const children = childrenByParent.get(edge.parentTaskId) ?? new Set<string>();
    children.add(edge.childTaskId);
    childrenByParent.set(edge.parentTaskId, children);
  }

  const pending = [childTaskId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    if (current === parentTaskId) {
      throw new TypeError("Task hierarchy relation would create a cycle");
    }
    visited.add(current);
    for (const child of childrenByParent.get(current) ?? []) pending.push(child);
  }
}

export function buildTaskHierarchySnapshot(
  projectId: string,
  tasks: readonly Task[],
  relations: readonly Relation[],
): TaskHierarchySnapshot {
  const projectTasks = tasks.filter((task) => task.projectId === projectId);
  const taskIds = new Set(projectTasks.map((task) => task.id));
  const orderByTaskId = new Map(projectTasks.map((task, index) => [task.id, index] as const));
  const parentByChild = new Map<string, string>();
  const childrenByParentSets = new Map<string, Set<string>>();

  for (const relation of relations) {
    if (relation.projectId !== projectId) continue;
    const edge = taskHierarchyEdgeFromRelation(relation);
    if (!edge) continue;
    if (!taskIds.has(edge.parentTaskId) || !taskIds.has(edge.childTaskId)) continue;

    const existingParent = parentByChild.get(edge.childTaskId);
    if (existingParent && existingParent !== edge.parentTaskId) {
      throw new TypeError("Task hierarchy child has multiple parents");
    }
    parentByChild.set(edge.childTaskId, edge.parentTaskId);

    const children = childrenByParentSets.get(edge.parentTaskId) ?? new Set<string>();
    children.add(edge.childTaskId);
    childrenByParentSets.set(edge.parentTaskId, children);
  }

  const childrenFor = (taskId: string): string[] =>
    [...(childrenByParentSets.get(taskId) ?? [])].sort(
      (left, right) => (orderByTaskId.get(left) ?? 0) - (orderByTaskId.get(right) ?? 0),
    );

  const visitState = new Map<string, "visiting" | "visited">();
  const assertAcyclic = (taskId: string): void => {
    const state = visitState.get(taskId);
    if (state === "visiting") throw new TypeError("Task hierarchy contains a cycle");
    if (state === "visited") return;

    visitState.set(taskId, "visiting");
    for (const childTaskId of childrenFor(taskId)) assertAcyclic(childTaskId);
    visitState.set(taskId, "visited");
  };
  for (const task of projectTasks) assertAcyclic(task.id);

  const ancestryByTask: Record<string, string[]> = {};
  for (const task of projectTasks) {
    const ancestry: string[] = [];
    let parentTaskId = parentByChild.get(task.id);
    while (parentTaskId) {
      ancestry.unshift(parentTaskId);
      parentTaskId = parentByChild.get(parentTaskId);
    }
    ancestryByTask[task.id] = ancestry;
  }

  const taskById = new Map(projectTasks.map((task) => [task.id, task] as const));
  const progressByTask: Record<string, TaskHierarchyProgress> = {};
  for (const task of projectTasks) {
    const descendants = new Set<string>();
    const pending = [...childrenFor(task.id)];
    while (pending.length > 0) {
      const descendantTaskId = pending.pop();
      if (!descendantTaskId || descendants.has(descendantTaskId)) continue;
      descendants.add(descendantTaskId);
      pending.push(...childrenFor(descendantTaskId));
    }

    const progress: TaskHierarchyProgress = {
      total: descendants.size,
      done: 0,
      active: 0,
      review: 0,
      blocked: 0,
    };
    for (const descendantTaskId of descendants) {
      const status = taskById.get(descendantTaskId)?.status;
      if (!status) continue;
      incrementProgress(progress, status);
    }
    progressByTask[task.id] = progress;
  }

  const rootTaskIds = projectTasks
    .filter((task) => !parentByChild.has(task.id))
    .map((task) => task.id);
  const rootGroupTaskIds = rootTaskIds.filter((taskId) => childrenFor(taskId).length > 0);
  const ungroupedTaskIds = rootTaskIds.filter((taskId) => childrenFor(taskId).length === 0);

  return {
    projectId,
    rootTaskIds,
    rootGroupTaskIds,
    ungroupedTaskIds,
    parentByChild: Object.fromEntries(parentByChild),
    childrenByParent: Object.fromEntries(
      projectTasks.map((task) => [task.id, childrenFor(task.id)] as const),
    ),
    ancestryByTask,
    progressByTask,
  };
}

function incrementProgress(progress: TaskHierarchyProgress, status: TaskStatus): void {
  if (status === "done") {
    progress.done += 1;
  } else if (status === "review") {
    progress.review += 1;
  } else if (status === "blocked") {
    progress.blocked += 1;
  } else {
    progress.active += 1;
  }
}
