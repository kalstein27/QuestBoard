import { createHash, randomUUID } from "node:crypto";
import type {
  Activity,
  ActivityType,
  ActorRef,
  Artifact,
  ArtifactType,
  BoardNodePosition,
  Claim,
  Project,
  ProjectStatus,
  Relation,
  RelationEntityType,
  Task,
  TaskPriority,
  TaskStatus,
} from "../core/domain.js";
import {
  ClaimConflictError,
  ClaimGenerationConflictError,
  ClaimNotFoundError,
  ClaimOwnershipError,
  EntityNotFoundError,
  MutationRequestConflictError,
  RevisionConflictError,
} from "../core/errors.js";
import type { ConcurrencyDiagnosticEvent, ConcurrencyDiagnosticSink } from "../observability/concurrency-log.js";
import { NOOP_CONCURRENCY_DIAGNOSTIC_SINK } from "../observability/concurrency-log.js";
import type { MutationRequest, QuestBoardRepository, TaskListFilter } from "./quest-board-repository.js";

const MAX_INTERNAL_UPDATE_ATTEMPTS = 4;

export interface CreateProjectInput {
  name: string;
  description?: string;
  rootPath?: string;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  rootPath?: string;
  status?: ProjectStatus;
}

export interface CreateTaskInput {
  projectId: string;
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  tags?: string[];
}

export interface UpdateTaskInput {
  expectedRevision?: number;
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  tags?: string[];
}

export interface MutationOptions {
  requestId?: string;
}

export interface ReleaseTaskOptions extends MutationOptions {
  claimId?: string;
}

export interface CreateArtifactInput {
  taskId: string;
  type: ArtifactType;
  title: string;
  locator: string;
  description?: string;
}

export interface CreateRelationInput {
  fromType: RelationEntityType;
  fromId: string;
  toType: RelationEntityType;
  toId: string;
  kind: string;
  label?: string;
}

export interface SetBoardPositionInput {
  entityType: RelationEntityType;
  entityId: string;
  x: number;
  y: number;
}

type Now = () => string;
type IdFactory = () => string;

export class QuestBoardService {
  constructor(
    private readonly repository: QuestBoardRepository,
    private readonly now: Now = () => new Date().toISOString(),
    private readonly newId: IdFactory = randomUUID,
    private readonly diagnostics: ConcurrencyDiagnosticSink = NOOP_CONCURRENCY_DIAGNOSTIC_SINK,
  ) {}

  createProject(input: CreateProjectInput, actor: ActorRef, options: MutationOptions = {}): Project {
    return this.runMutation("project.create", actor, options, input, undefined, () => {
      const timestamp = this.now();
      const rootPath = input.rootPath?.trim();
      const project: Project = {
        id: this.newId(),
        name: requiredText(input.name, "Project name"),
        description: input.description?.trim() ?? "",
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(rootPath ? { rootPath } : {}),
      };

      this.repository.createProject(project);
      return project;
    });
  }

  getProject(projectId: string): Project {
    const project = this.repository.getProject(projectId);
    if (!project) throw new EntityNotFoundError("Project", projectId);
    return project;
  }

  listProjects(): Project[] {
    return this.repository.listProjects();
  }

  updateProject(projectId: string, patch: UpdateProjectInput, actor: ActorRef, options: MutationOptions = {}): Project {
    return this.runMutation("project.update", actor, options, { projectId, patch }, undefined, () => {
      const current = this.getProject(projectId);
      const timestamp = this.now();
      const rootPath = patch.rootPath !== undefined ? patch.rootPath.trim() : current.rootPath;
      const updated: Project = {
        id: current.id,
        name: patch.name !== undefined ? requiredText(patch.name, "Project name") : current.name,
        description: patch.description !== undefined ? patch.description.trim() : current.description,
        status: patch.status ?? current.status,
        createdAt: current.createdAt,
        updatedAt: timestamp,
        ...(rootPath ? { rootPath } : {}),
      };

      this.repository.updateProject(updated);
      return updated;
    });
  }

  createTask(input: CreateTaskInput, actor: ActorRef, options: MutationOptions = {}): Task {
    return this.runMutation("task.create", actor, options, input, undefined, () => {
      if (!this.repository.getProject(input.projectId)) {
        throw new EntityNotFoundError("Project", input.projectId);
      }

      const timestamp = this.now();
      const task: Task = {
        id: this.newId(),
        projectId: input.projectId,
        title: requiredText(input.title, "Task title"),
        description: input.description?.trim() ?? "",
        status: input.status ?? "inbox",
        priority: input.priority ?? "normal",
        tags: normalizeTags(input.tags ?? []),
        createdBy: actor.id,
        createdAt: timestamp,
        updatedAt: timestamp,
        revision: 1,
      };

      this.repository.createTask(
        task,
        this.activityFor(task, actor, "task_created", "Task created", undefined, task.revision, timestamp),
      );
      return task;
    });
  }

  getTask(taskId: string): Task {
    const task = this.repository.getTask(taskId);
    if (!task) throw new EntityNotFoundError("Task", taskId);
    return task;
  }

  getTaskClaim(taskId: string): Claim | undefined {
    this.getTask(taskId);
    const claim = this.repository.getClaim(taskId);
    return claim?.state === "active" ? claim : undefined;
  }

  listTasks(filter: TaskListFilter = {}): Task[] {
    return this.repository.listTasks(filter);
  }

  updateTask(taskId: string, patch: UpdateTaskInput, actor: ActorRef, options: MutationOptions = {}): Task {
    const explicitExpectedRevision = patch.expectedRevision === undefined
      ? undefined
      : requireRevision(patch.expectedRevision);
    return this.runMutation("task.update", actor, options, { taskId, patch }, taskId, () => {
      for (let attempt = 1; attempt <= MAX_INTERNAL_UPDATE_ATTEMPTS; attempt += 1) {
        const current = this.getTask(taskId);
        if (explicitExpectedRevision !== undefined && current.revision !== explicitExpectedRevision) {
          this.log({
            event: "task.update.conflict",
            operation: "task.update",
            actorId: actor.id,
            actorProvider: actor.provider,
            taskId,
            requestId: options.requestId,
            expectedRevision: explicitExpectedRevision,
            actualRevision: current.revision,
            attempt,
          });
          throw new RevisionConflictError(taskId, explicitExpectedRevision, current.revision);
        }

        const expectedRevision = explicitExpectedRevision ?? current.revision;
        const timestamp = this.now();
        const updated: Task = {
          ...current,
          ...(patch.title !== undefined ? { title: requiredText(patch.title, "Task title") } : {}),
          ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
          ...(patch.tags !== undefined ? { tags: normalizeTags(patch.tags) } : {}),
          updatedAt: timestamp,
          revision: current.revision + 1,
        };
        const statusChanged = current.status !== updated.status;
        const type: ActivityType = statusChanged ? "status_changed" : "task_updated";
        const summary = statusChanged
          ? `Task status changed from ${current.status} to ${updated.status}`
          : "Task updated";

        try {
          this.repository.updateTask(
            updated,
            this.activityFor(updated, actor, type, summary, current.revision, updated.revision, timestamp),
            expectedRevision,
          );
          this.log({
            event: "task.update.applied",
            operation: "task.update",
            actorId: actor.id,
            actorProvider: actor.provider,
            taskId,
            requestId: options.requestId,
            expectedRevision,
            actualRevision: updated.revision,
            attempt,
          });
          return updated;
        } catch (error) {
          if (!(error instanceof RevisionConflictError) || explicitExpectedRevision !== undefined || attempt === MAX_INTERNAL_UPDATE_ATTEMPTS) {
            if (error instanceof RevisionConflictError) {
              this.log({
                event: "task.update.conflict",
                operation: "task.update",
                actorId: actor.id,
                actorProvider: actor.provider,
                taskId,
                requestId: options.requestId,
                expectedRevision: error.expectedRevision,
                actualRevision: error.actualRevision,
                attempt,
              });
            }
            throw error;
          }
          this.log({
            event: "task.update.retry",
            operation: "task.update",
            actorId: actor.id,
            actorProvider: actor.provider,
            taskId,
            requestId: options.requestId,
            expectedRevision: error.expectedRevision,
            actualRevision: error.actualRevision,
            attempt,
          });
        }
      }
      throw new Error("Task update retry loop exhausted");
    });
  }

  claimTask(taskId: string, actor: ActorRef, options: MutationOptions = {}): Claim {
    return this.runMutation("task.claim", actor, options, { taskId }, taskId, () => {
      const task = this.getTask(taskId);
      const currentClaim = this.repository.getClaim(taskId);
      if (currentClaim?.state === "active") {
        if (currentClaim.agentId === actor.id) return currentClaim;
        this.log({
          event: "claim.conflict",
          operation: "task.claim",
          actorId: actor.id,
          actorProvider: actor.provider,
          taskId,
          claimId: currentClaim.id,
          requestId: options.requestId,
          detail: "claimed-by-other-actor",
        });
        throw new ClaimConflictError(taskId, currentClaim.agentId);
      }

      const timestamp = this.now();
      const claim: Claim = {
        id: this.newId(),
        taskId,
        agentId: actor.id,
        state: "active",
        claimedAt: timestamp,
      };
      const claimed = this.repository.claimTask(
        claim,
        this.activityFor(task, actor, "task_claimed", `Task claimed by ${actor.id}`, task.revision, task.revision, timestamp),
      );
      this.log({
        event: "claim.acquired",
        operation: "task.claim",
        actorId: actor.id,
        actorProvider: actor.provider,
        taskId,
        claimId: claimed.id,
        requestId: options.requestId,
      });
      return claimed;
    });
  }

  releaseTask(taskId: string, actor: ActorRef, options: ReleaseTaskOptions = {}): Claim {
    return this.runMutation("task.release", actor, options, { taskId, claimId: options.claimId }, taskId, () => {
      const task = this.getTask(taskId);
      const claim = this.repository.getClaim(taskId);
      if (!claim || claim.state !== "active") throw new ClaimNotFoundError(taskId);
      if (claim.agentId !== actor.id) {
        throw new ClaimOwnershipError(taskId, claim.agentId, actor.id);
      }
      if (options.claimId !== undefined && options.claimId !== claim.id) {
        this.log({
          event: "claim.release.stale",
          operation: "task.release",
          actorId: actor.id,
          actorProvider: actor.provider,
          taskId,
          claimId: options.claimId,
          requestId: options.requestId,
          detail: "claim-generation-changed",
        });
        throw new ClaimGenerationConflictError(taskId, options.claimId, claim.id);
      }

      const timestamp = this.now();
      const released = this.repository.releaseClaim(
        taskId,
        actor.id,
        claim.id,
        timestamp,
        this.activityFor(task, actor, "task_released", `Task released by ${actor.id}`, task.revision, task.revision, timestamp),
      );
      this.log({
        event: "claim.released",
        operation: "task.release",
        actorId: actor.id,
        actorProvider: actor.provider,
        taskId,
        claimId: claim.id,
        requestId: options.requestId,
      });
      return released;
    });
  }

  appendTaskActivity(taskId: string, type: ActivityType, summary: string, actor: ActorRef, options: MutationOptions = {}): Activity {
    return this.runMutation("activity.append", actor, options, { taskId, type, summary }, taskId, () => {
      const task = this.getTask(taskId);
      const timestamp = this.now();
      const activity = this.activityFor(
        task,
        actor,
        type,
        requiredText(summary, "Activity summary"),
        task.revision,
        task.revision,
        timestamp,
      );
      this.repository.appendActivity(activity);
      return activity;
    });
  }

  listTaskActivity(taskId: string): Activity[] {
    this.getTask(taskId);
    return this.repository.listTaskActivity(taskId);
  }

  createArtifact(input: CreateArtifactInput, actor: ActorRef, options: MutationOptions = {}): Artifact {
    return this.runMutation("artifact.create", actor, options, input, input.taskId, () => {
      const task = this.getTask(input.taskId);
      const timestamp = this.now();
      const artifact: Artifact = {
        id: this.newId(),
        projectId: task.projectId,
        taskId: task.id,
        type: input.type,
        title: requiredText(input.title, "Artifact title"),
        locator: requiredText(input.locator, "Artifact locator"),
        description: input.description?.trim() ?? "",
        createdBy: actor.id,
        createdAt: timestamp,
      };

      this.repository.createArtifact(
        artifact,
        this.activityFor(
          task,
          actor,
          "artifact_attached",
          `Artifact attached: ${artifact.title}`,
          task.revision,
          task.revision,
          timestamp,
        ),
      );
      return artifact;
    });
  }

  getArtifact(artifactId: string): Artifact {
    const artifact = this.repository.getArtifact(artifactId);
    if (!artifact) throw new EntityNotFoundError("Artifact", artifactId);
    return artifact;
  }

  listTaskArtifacts(taskId: string): Artifact[] {
    this.getTask(taskId);
    return this.repository.listTaskArtifacts(taskId);
  }

  listProjectArtifacts(projectId: string): Artifact[] {
    this.getProject(projectId);
    return this.repository.listProjectArtifacts(projectId);
  }

  createRelation(input: CreateRelationInput, actor: ActorRef, options: MutationOptions = {}): Relation {
    return this.runMutation("relation.create", actor, options, input, undefined, () => {
      if (input.fromType === input.toType && input.fromId === input.toId) {
        throw new TypeError("Relation endpoints must be different");
      }

      const from = this.resolveRelationEndpoint(input.fromType, input.fromId);
      const to = this.resolveRelationEndpoint(input.toType, input.toId);
      if (from.projectId !== to.projectId) {
        throw new TypeError("Relation endpoints must belong to the same project");
      }

      const timestamp = this.now();
      const relation: Relation = {
        id: this.newId(),
        projectId: from.projectId,
        fromType: input.fromType,
        fromId: input.fromId,
        toType: input.toType,
        toId: input.toId,
        kind: requiredText(input.kind, "Relation kind"),
        label: input.label?.trim() ?? "",
        createdBy: actor.id,
        createdAt: timestamp,
      };

      this.repository.createRelation(
        relation,
        this.activityFor(
          from.task,
          actor,
          "relation_added",
          `Relation added: ${relation.kind}`,
          from.task.revision,
          from.task.revision,
          timestamp,
        ),
      );
      return relation;
    });
  }

  listTaskRelations(taskId: string): Relation[] {
    this.getTask(taskId);
    return this.repository.listTaskRelations(taskId);
  }

  listProjectRelations(projectId: string): Relation[] {
    this.getProject(projectId);
    return this.repository.listProjectRelations(projectId);
  }

  listBoardPositions(projectId: string): BoardNodePosition[] {
    this.getProject(projectId);
    return this.repository.listBoardPositions(projectId);
  }

  setBoardPosition(projectId: string, input: SetBoardPositionInput, actor: ActorRef, options: MutationOptions = {}): BoardNodePosition {
    return this.runMutation("board.position", actor, options, { projectId, input }, undefined, () => {
      this.getProject(projectId);
      const endpoint = this.resolveRelationEndpoint(input.entityType, input.entityId);
      if (endpoint.projectId !== projectId) {
        throw new TypeError("Board node must belong to the requested project");
      }
      const position: BoardNodePosition = {
        projectId,
        entityType: input.entityType,
        entityId: input.entityId,
        x: requireFiniteCoordinate(input.x, "x"),
        y: requireFiniteCoordinate(input.y, "y"),
        updatedBy: actor.id,
        updatedAt: this.now(),
      };
      return this.repository.upsertBoardPosition(position);
    });
  }

  private runMutation<T>(
    operation: string,
    actor: ActorRef,
    options: MutationOptions,
    fingerprintInput: unknown,
    taskId: string | undefined,
    execute: () => T,
  ): T {
    const requestId = normalizeRequestId(options.requestId);
    const request: MutationRequest | undefined = requestId
      ? {
          requestId,
          operation,
          actorId: actor.id,
          fingerprint: mutationFingerprint({ operation, actor: { id: actor.id, provider: actor.provider }, input: fingerprintInput }),
          createdAt: this.now(),
        }
      : undefined;
    try {
      const execution = this.repository.runIdempotentMutation(request, execute);
      if (requestId) {
        this.log({
          event: execution.replayed ? "mutation.replayed" : "mutation.receipt.persisted",
          operation,
          actorId: actor.id,
          actorProvider: actor.provider,
          taskId,
          requestId,
        });
      }
      return execution.value;
    } catch (error) {
      if (error instanceof MutationRequestConflictError) {
        this.log({
          event: "mutation.request.conflict",
          operation,
          actorId: actor.id,
          actorProvider: actor.provider,
          taskId,
          requestId: error.requestId,
          detail: "request-id-reused-with-different-input",
        });
      }
      throw error;
    }
  }

  private log(event: Omit<ConcurrencyDiagnosticEvent, "at">): void {
    this.diagnostics({ at: this.now(), ...event });
  }

  private resolveRelationEndpoint(
    type: RelationEntityType,
    id: string,
  ): { projectId: string; task: Task } {
    if (type === "task") {
      const task = this.getTask(id);
      return { projectId: task.projectId, task };
    }
    const artifact = this.getArtifact(id);
    const task = this.getTask(artifact.taskId);
    return { projectId: artifact.projectId, task };
  }

  private activityFor(
    task: Task,
    actor: ActorRef,
    type: ActivityType,
    summary: string,
    beforeRevision: number | undefined,
    afterRevision: number | undefined,
    timestamp: string,
  ): Activity {
    return {
      id: this.newId(),
      projectId: task.projectId,
      taskId: task.id,
      actorId: actor.id,
      actorProvider: actor.provider,
      type,
      summary,
      createdAt: timestamp,
      ...(beforeRevision !== undefined ? { beforeRevision } : {}),
      ...(afterRevision !== undefined ? { afterRevision } : {}),
    };
  }
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} must not be empty`);
  return normalized;
}

function requireRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("expectedRevision must be a positive integer");
  }
  return value;
}

function normalizeRequestId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(normalized)) {
    throw new TypeError("requestId must be 8-128 characters using letters, numbers, dot, underscore, colon, or hyphen");
  }
  return normalized;
}

function mutationFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requireFiniteCoordinate(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be a finite number`);
  return value;
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}