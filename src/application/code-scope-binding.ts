import { createHash, randomUUID } from "node:crypto";
import type { ActorRef, Task } from "../core/domain.js";
import { EntityNotFoundError, EntityRevisionConflictError } from "../core/errors.js";
import type { CodeGraphSnapshot, CodeNode } from "./code-intelligence.js";
import type { CodeMapService } from "./code-map-service.js";
import type { CreateTaskInput, QuestBoardService } from "./quest-board-service.js";
import type { MutationRequest, QuestBoardRepository } from "./quest-board-repository.js";

export const CODE_SCOPE_BINDING_KINDS = ["targets", "implemented_in", "affects", "investigates"] as const;
export type CodeScopeBindingKind = (typeof CODE_SCOPE_BINDING_KINDS)[number];

export const CODE_SCOPE_BINDING_STATES = ["active", "relinkable", "stale", "unindexed"] as const;
export type CodeScopeBindingState = (typeof CODE_SCOPE_BINDING_STATES)[number];

export interface TaskCodeScopeBinding {
  id: string;
  projectId: string;
  taskId: string;
  codeNodeId: string;
  codeCanonicalIdentity: string;
  codeKind?: CodeNode["kind"];
  codeLanguage?: string;
  codePath?: string;
  codeSignature?: string;
  codeName?: string;
  kind: CodeScopeBindingKind;
  createdBy: string;
  createdByProvider: string;
  createdAt: string;
  updatedBy: string;
  updatedByProvider: string;
  updatedAt: string;
  revision: number;
}

export interface TaskCodeScopeBindingView extends TaskCodeScopeBinding {
  state: CodeScopeBindingState;
  staleReason?: "code_map_not_indexed" | "target_missing" | "target_identity_changed" | "relink_ambiguous";
  codeNode?: CodeNode;
  relink?: { strategy: "canonical_identity" | "file_path" | "path_signature"; candidate: CodeNode };
  task: Task;
}

export interface AttachTaskCodeScopeInput {
  projectId: string;
  taskId: string;
  codeNodeId: string;
  kind?: CodeScopeBindingKind;
}

export interface CreateTaskForCodeScopeInput {
  projectId: string;
  codeNodeId: string;
  kind?: CodeScopeBindingKind;
  task: Omit<CreateTaskInput, "projectId">;
}

export interface CodeScopeBindingMutationOptions {
  requestId?: string;
  expectedRevision?: number;
}

export interface CodeScopeBindingListFilter {
  taskId?: string;
  codeNodeId?: string;
}

export class CodeScopeBindingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CodeScopeBindingError";
  }
}

function bindingState(
  binding: TaskCodeScopeBinding,
  graph: CodeGraphSnapshot | undefined,
): Pick<TaskCodeScopeBindingView, "state" | "staleReason" | "codeNode" | "relink"> {
  if (!graph) return { state: "unindexed", staleReason: "code_map_not_indexed" };
  const node = graph.nodes.find((candidate) => candidate.id === binding.codeNodeId);
  if (node?.canonicalIdentity === binding.codeCanonicalIdentity) return { state: "active", codeNode: node };

  const canonical = graph.nodes.filter((candidate) => candidate.canonicalIdentity === binding.codeCanonicalIdentity);
  if (canonical.length === 1) {
    return { state: "relinkable", ...(node ? { codeNode: node } : {}), relink: { strategy: "canonical_identity", candidate: canonical[0]! } };
  }
  if (canonical.length > 1) {
    return { state: "stale", staleReason: "relink_ambiguous", ...(node ? { codeNode: node } : {}) };
  }

  const anchored = relinkFallbackCandidates(binding, graph);
  if (anchored.length === 1) {
    return { state: "relinkable", ...(node ? { codeNode: node } : {}), relink: anchored[0]! };
  }
  if (anchored.length > 1) {
    return { state: "stale", staleReason: "relink_ambiguous", ...(node ? { codeNode: node } : {}) };
  }
  return node
    ? { state: "stale", staleReason: "target_identity_changed", codeNode: node }
    : { state: "stale", staleReason: "target_missing" };
}

function relinkFallbackCandidates(
  binding: TaskCodeScopeBinding,
  graph: CodeGraphSnapshot,
): Array<{ strategy: "file_path" | "path_signature"; candidate: CodeNode }> {
  if (!binding.codePath) return [];
  const base = graph.nodes.filter((candidate) =>
    candidate.location?.path === binding.codePath
    && (!binding.codeKind || candidate.kind === binding.codeKind)
    && (!binding.codeLanguage || candidate.language === binding.codeLanguage),
  );
  if (binding.codeKind === "file") return base.map((candidate) => ({ strategy: "file_path" as const, candidate }));
  if (!binding.codeSignature) return [];
  return base
    .filter((candidate) => candidate.signature === binding.codeSignature)
    .map((candidate) => ({ strategy: "path_signature" as const, candidate }));
}

function nodeAnchors(node: CodeNode): Pick<TaskCodeScopeBinding, "codeKind" | "codeLanguage" | "codePath" | "codeSignature" | "codeName"> {
  return {
    codeKind: node.kind,
    ...(node.language ? { codeLanguage: node.language } : {}),
    ...(node.location?.path ? { codePath: node.location.path } : {}),
    ...(node.signature ? { codeSignature: node.signature } : {}),
    codeName: node.name,
  };
}

function requireKind(value: string): CodeScopeBindingKind {
  if (!CODE_SCOPE_BINDING_KINDS.includes(value as CodeScopeBindingKind)) {
    throw new TypeError(`Unsupported CodeScope binding kind: ${value}`);
  }
  return value as CodeScopeBindingKind;
}

function normalizeRequestId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length < 8 || normalized.length > 128) {
    throw new TypeError("requestId must be between 8 and 128 characters");
  }
  return normalized;
}

function fingerprint(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export class CodeScopeBindingService {
  constructor(
    private readonly codeMap: CodeMapService,
    private readonly repository: QuestBoardRepository,
    private readonly tasks: QuestBoardService,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly newId: () => string = randomUUID,
  ) {}

  list(projectId: string, filter: CodeScopeBindingListFilter = {}): TaskCodeScopeBindingView[] {
    if (!this.repository.getProject(projectId)) throw new EntityNotFoundError("Project", projectId);
    const graph = this.codeMap.getCached(projectId)?.graph;
    return this.repository
      .listTaskCodeScopeBindings(projectId)
      .filter((binding) => filter.taskId === undefined || binding.taskId === filter.taskId)
      .filter((binding) => filter.codeNodeId === undefined || binding.codeNodeId === filter.codeNodeId)
      .map((binding) => this.view(binding, graph));
  }

  attach(
    input: AttachTaskCodeScopeInput,
    actor: ActorRef,
    options: CodeScopeBindingMutationOptions = {},
  ): TaskCodeScopeBindingView {
    return this.runMutation("code-scope.binding.attach", actor, options.requestId, input, () => {
      const task = this.requireTaskInProject(input.taskId, input.projectId);
      const graph = this.requireGraph(input.projectId);
      const node = this.requireNode(graph, input.codeNodeId);
      const kind = requireKind(input.kind ?? "targets");
      const existing = this.repository.listTaskCodeScopeBindings(input.projectId).find((binding) =>
        binding.taskId === task.id && binding.codeNodeId === node.id && binding.kind === kind,
      );
      if (existing) return this.view(existing, graph);
      const timestamp = this.now();
      const binding: TaskCodeScopeBinding = {
        id: this.newId(),
        projectId: input.projectId,
        taskId: task.id,
        codeNodeId: node.id,
        codeCanonicalIdentity: node.canonicalIdentity,
        ...nodeAnchors(node),
        kind,
        createdBy: actor.id,
        createdByProvider: actor.provider,
        createdAt: timestamp,
        updatedBy: actor.id,
        updatedByProvider: actor.provider,
        updatedAt: timestamp,
        revision: 1,
      };
      return this.view(this.repository.createTaskCodeScopeBinding(binding), graph);
    });
  }

  detach(
    bindingId: string,
    actor: ActorRef,
    options: CodeScopeBindingMutationOptions = {},
  ): { deleted: true; bindingId: string } {
    return this.runMutation("code-scope.binding.detach", actor, options.requestId, {
      bindingId,
      expectedRevision: options.expectedRevision,
    }, () => {
      const binding = this.repository.getTaskCodeScopeBinding(bindingId);
      if (!binding) throw new EntityNotFoundError("Task CodeScope binding", bindingId);
      this.repository.deleteTaskCodeScopeBinding(bindingId, options.expectedRevision ?? binding.revision);
      return { deleted: true as const, bindingId };
    });
  }

  relink(
    bindingId: string,
    actor: ActorRef,
    options: CodeScopeBindingMutationOptions = {},
  ): TaskCodeScopeBindingView {
    return this.runMutation("code-scope.binding.relink", actor, options.requestId, {
      bindingId,
      expectedRevision: options.expectedRevision,
    }, () => {
      const binding = this.repository.getTaskCodeScopeBinding(bindingId);
      if (!binding) throw new EntityNotFoundError("Task CodeScope binding", bindingId);
      const graph = this.requireGraph(binding.projectId);
      const view = this.view(binding, graph);
      if (view.state === "active") return view;
      if (view.state !== "relinkable" || !view.relink) {
        throw new CodeScopeBindingError("code_scope_relink_unavailable", `CodeScope binding ${bindingId} has no unique relink target`);
      }
      const target = view.relink.candidate;
      const collision = this.repository.listTaskCodeScopeBindings(binding.projectId).find((candidate) =>
        candidate.id !== binding.id
        && candidate.taskId === binding.taskId
        && candidate.codeNodeId === target.id
        && candidate.kind === binding.kind,
      );
      if (collision) {
        throw new CodeScopeBindingError("code_scope_relink_conflict", `Relink target ${target.id} is already bound to Task ${binding.taskId}`);
      }
      const updated: TaskCodeScopeBinding = {
        ...binding,
        codeNodeId: target.id,
        codeCanonicalIdentity: target.canonicalIdentity,
        ...nodeAnchors(target),
        updatedBy: actor.id,
        updatedByProvider: actor.provider,
        updatedAt: this.now(),
        revision: binding.revision + 1,
      };
      return this.view(this.repository.updateTaskCodeScopeBinding(
        updated,
        options.expectedRevision ?? binding.revision,
      ), graph);
    });
  }

  createTaskForScope(
    input: CreateTaskForCodeScopeInput,
    actor: ActorRef,
    options: CodeScopeBindingMutationOptions = {},
  ): { task: Task; binding: TaskCodeScopeBindingView } {
    return this.runMutation("code-scope.task.create", actor, options.requestId, input, () => {
      if (!this.repository.getProject(input.projectId)) throw new EntityNotFoundError("Project", input.projectId);
      const graph = this.requireGraph(input.projectId);
      const node = this.requireNode(graph, input.codeNodeId);
      const kind = requireKind(input.kind ?? "targets");
      const task = this.tasks.createTask({ ...input.task, projectId: input.projectId }, actor);
      const timestamp = this.now();
      const binding: TaskCodeScopeBinding = {
        id: this.newId(),
        projectId: input.projectId,
        taskId: task.id,
        codeNodeId: node.id,
        codeCanonicalIdentity: node.canonicalIdentity,
        ...nodeAnchors(node),
        kind,
        createdBy: actor.id,
        createdByProvider: actor.provider,
        createdAt: timestamp,
        updatedBy: actor.id,
        updatedByProvider: actor.provider,
        updatedAt: timestamp,
        revision: 1,
      };
      return { task, binding: this.view(this.repository.createTaskCodeScopeBinding(binding), graph) };
    });
  }

  private view(binding: TaskCodeScopeBinding, graph: CodeGraphSnapshot | undefined): TaskCodeScopeBindingView {
    const task = this.repository.getTask(binding.taskId);
    if (!task) throw new EntityNotFoundError("Task", binding.taskId);
    return { ...binding, ...bindingState(binding, graph), task };
  }

  private requireTaskInProject(taskId: string, projectId: string): Task {
    const task = this.repository.getTask(taskId);
    if (!task) throw new EntityNotFoundError("Task", taskId);
    if (task.projectId !== projectId) {
      throw new CodeScopeBindingError("task_project_mismatch", `Task ${taskId} does not belong to project ${projectId}`);
    }
    return task;
  }

  private requireGraph(projectId: string): CodeGraphSnapshot {
    const graph = this.codeMap.getCached(projectId)?.graph;
    if (!graph) {
      throw new CodeScopeBindingError("code_map_not_indexed", `Code Map has not been indexed for project ${projectId}`);
    }
    return graph;
  }

  private requireNode(graph: CodeGraphSnapshot, nodeId: string): CodeNode {
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new CodeScopeBindingError("code_map_node_not_found", `Unknown Code Map node ${nodeId}`);
    return node;
  }

  private runMutation<T>(
    operation: string,
    actor: ActorRef,
    requestIdValue: string | undefined,
    input: unknown,
    execute: () => T,
  ): T {
    const requestId = normalizeRequestId(requestIdValue);
    const request: MutationRequest | undefined = requestId
      ? {
          requestId,
          operation,
          actorId: actor.id,
          fingerprint: fingerprint({ operation, actor: { id: actor.id, provider: actor.provider }, input }),
          createdAt: this.now(),
        }
      : undefined;
    return this.repository.runIdempotentMutation(request, execute).value;
  }
}

export function assertTaskCodeScopeBindingRevision(binding: TaskCodeScopeBinding, expectedRevision: number): void {
  if (binding.revision !== expectedRevision) {
    throw new EntityRevisionConflictError("Task CodeScope binding", binding.id, expectedRevision, binding.revision);
  }
}
