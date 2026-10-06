import type { QuestBoardRepository } from "./quest-board-repository.js";

export const AGENT_FOCUS_SURFACES = ["quest", "flow", "code", "wiki"] as const;
export type AgentFocusSurface = (typeof AGENT_FOCUS_SURFACES)[number];

export const AGENT_NAVIGATION_INTENTS = ["inspect", "focus", "navigate", "idle"] as const;
export type AgentNavigationIntent = (typeof AGENT_NAVIGATION_INTENTS)[number];

export const AGENT_FOCUS_ENTITY_TYPES = ["task", "work_group", "flow_node", "code_scope", "wiki"] as const;
export type AgentFocusEntityType = (typeof AGENT_FOCUS_ENTITY_TYPES)[number];

export const AGENT_FOCUS_TTL_MS = 60_000;

export interface AgentFocus {
  projectId: string;
  sessionId: string;
  activeSurface?: AgentFocusSurface;
  focusedEntityType?: AgentFocusEntityType;
  focusedEntityId?: string;
  navigationIntent: AgentNavigationIntent;
  sequence: number;
  taskId?: string;
  workGroupId?: string;
  flowNodeId?: string;
  codeScopeId?: string;
  updatedAt: string;
  expiresAt: string;
}

export interface SetAgentFocusInput {
  projectId: string;
  sessionId: string;
  sequence?: number;
  activeSurface?: AgentFocusSurface;
  navigationIntent?: AgentNavigationIntent;
  taskId?: string;
  workGroupId?: string;
  flowNodeId?: string;
  codeScopeId?: string;
}

export type AgentFocusCodeNodeResolver = (projectId: string, codeNodeId: string) => boolean;

export class AgentFocusService {
  private readonly byProject = new Map<string, Map<string, AgentFocus>>();

  constructor(
    private readonly repository: QuestBoardRepository,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly ttlMs: number = AGENT_FOCUS_TTL_MS,
    private readonly codeNodeExists?: AgentFocusCodeNodeResolver,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError("ttlMs must be a positive finite number");
  }

  list(projectId: string): AgentFocus[] {
    this.requireProject(projectId);
    this.pruneExpired(projectId);
    return [...(this.byProject.get(projectId)?.values() ?? [])]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.sequence - left.sequence)
      .slice(0, 20);
  }

  latest(projectId: string): AgentFocus | null {
    return this.list(projectId)[0] ?? null;
  }

  set(input: SetAgentFocusInput): AgentFocus {
    this.requireProject(input.projectId);
    const sessionId = normalizeSessionId(input.sessionId);
    if (input.sequence !== undefined && (!Number.isSafeInteger(input.sequence) || input.sequence < 1)) {
      throw new TypeError("sequence must be a positive integer");
    }

    let sessions = this.byProject.get(input.projectId);
    if (!sessions) {
      sessions = new Map();
      this.byProject.set(input.projectId, sessions);
    }
    const previous = sessions.get(sessionId);
    if (previous && input.sequence !== undefined && input.sequence <= previous.sequence) return previous;

    const navigationIntent = input.navigationIntent ?? "navigate";
    const idle = navigationIntent === "idle";
    const taskId = idle ? undefined : trimmed(input.taskId);
    const workGroupId = idle ? undefined : trimmed(input.workGroupId);
    const flowNodeId = idle ? undefined : trimmed(input.flowNodeId);
    const codeScopeId = idle ? undefined : trimmed(input.codeScopeId);
    const activeSurface = idle ? undefined : input.activeSurface ?? inferActiveSurface({ taskId, workGroupId, flowNodeId, codeScopeId });

    if (!idle) {
      this.assertSurfaceTarget({
        projectId: input.projectId,
        navigationIntent,
        activeSurface,
        taskId,
        workGroupId,
        flowNodeId,
        codeScopeId,
      });
    }

    const focusedEntity = idle ? undefined : inferFocusedEntity({ taskId, workGroupId, flowNodeId, codeScopeId });
    const sequence = input.sequence ?? (previous?.sequence ?? 0) + 1;
    const updatedAt = this.now();
    const updatedAtMs = Date.parse(updatedAt);
    if (!Number.isFinite(updatedAtMs)) throw new TypeError("now() must return an ISO-compatible timestamp");
    const focus: AgentFocus = {
      projectId: input.projectId,
      sessionId,
      ...(activeSurface ? { activeSurface } : {}),
      ...(focusedEntity ? { focusedEntityType: focusedEntity.type, focusedEntityId: focusedEntity.id } : {}),
      navigationIntent,
      sequence,
      ...(taskId ? { taskId } : {}),
      ...(workGroupId ? { workGroupId } : {}),
      ...(flowNodeId ? { flowNodeId } : {}),
      ...(codeScopeId ? { codeScopeId } : {}),
      updatedAt,
      expiresAt: new Date(updatedAtMs + this.ttlMs).toISOString(),
    };
    sessions.set(sessionId, focus);
    return focus;
  }

  clear(projectId: string, sessionId: string): { cleared: boolean } {
    this.requireProject(projectId);
    const sessions = this.byProject.get(projectId);
    const cleared = sessions?.delete(normalizeSessionId(sessionId)) ?? false;
    if (sessions && sessions.size === 0) this.byProject.delete(projectId);
    return { cleared };
  }

  private assertSurfaceTarget(input: {
    projectId: string;
    navigationIntent: AgentNavigationIntent;
    activeSurface: AgentFocusSurface | undefined;
    taskId: string | undefined;
    workGroupId: string | undefined;
    flowNodeId: string | undefined;
    codeScopeId: string | undefined;
  }): void {
    const { projectId, navigationIntent, activeSurface, taskId, workGroupId, flowNodeId, codeScopeId } = input;
    if (!activeSurface) {
      if (navigationIntent === "inspect") return;
      throw new TypeError("focus/navigate presence requires an active surface target");
    }

    if (taskId) {
      const task = this.repository.getTask(taskId);
      if (!task || task.projectId !== projectId) throw new TypeError(`Task ${taskId} does not belong to project ${projectId}`);
    }
    if (workGroupId) {
      const group = this.repository.getFlowWorkGroup(workGroupId);
      if (!group || group.projectId !== projectId) throw new TypeError(`Work Group ${workGroupId} does not belong to project ${projectId}`);
    }
    if (flowNodeId) {
      const node = this.repository.getInvestigationNode(flowNodeId);
      if (!node || node.projectId !== projectId) throw new TypeError(`Flow node ${flowNodeId} does not belong to project ${projectId}`);
    }

    if (activeSurface === "quest") {
      if (!taskId || workGroupId || flowNodeId || codeScopeId) throw new TypeError("Quest focus requires exactly a Task target");
      return;
    }
    if (activeSurface === "flow") {
      if (codeScopeId || (!taskId && !workGroupId && !flowNodeId)) {
        throw new TypeError("Flow focus requires a Task, Work Group, or Flow node target and cannot use a CodeScope target");
      }
      return;
    }
    if (activeSurface === "code") {
      if (!codeScopeId || workGroupId || flowNodeId) throw new TypeError("Code focus requires a raw CodeScope target");
      if (!codeScopeId.startsWith("code:node:")) throw new TypeError("Code focus requires a raw code:node:* ID; derived code-map:node:* IDs are not valid Code targets");
      if (this.codeNodeExists && !this.codeNodeExists(projectId, codeScopeId)) {
        throw new TypeError(`Code node ${codeScopeId} is not available in the current Code Map snapshot`);
      }
      return;
    }
    if (activeSurface === "wiki" && navigationIntent !== "inspect") {
      throw new TypeError("Wiki focus publication is not available until a canonical Wiki entity target exists");
    }
  }

  private pruneExpired(projectId: string): void {
    const sessions = this.byProject.get(projectId);
    if (!sessions) return;
    const nowMs = Date.parse(this.now());
    if (!Number.isFinite(nowMs)) throw new TypeError("now() must return an ISO-compatible timestamp");
    for (const [sessionId, focus] of sessions) {
      if (Date.parse(focus.expiresAt) <= nowMs) sessions.delete(sessionId);
    }
    if (sessions.size === 0) this.byProject.delete(projectId);
  }

  private requireProject(projectId: string): void {
    if (!this.repository.getProject(projectId)) throw new TypeError(`Unknown project ${projectId}`);
  }
}

function normalizeSessionId(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError("sessionId must be a non-empty string");
  if (normalized.length > 128) throw new TypeError("sessionId must be at most 128 characters");
  if (/[\u0000-\u001f\u007f]/.test(normalized)) throw new TypeError("sessionId must not contain control characters");
  return normalized;
}

function trimmed(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function inferActiveSurface(input: {
  taskId: string | undefined;
  workGroupId: string | undefined;
  flowNodeId: string | undefined;
  codeScopeId: string | undefined;
}): AgentFocusSurface | undefined {
  if (input.codeScopeId) return "code";
  if (input.workGroupId || input.flowNodeId) return "flow";
  if (input.taskId) return "quest";
  return undefined;
}

function inferFocusedEntity(input: {
  taskId: string | undefined;
  workGroupId: string | undefined;
  flowNodeId: string | undefined;
  codeScopeId: string | undefined;
}): { type: AgentFocusEntityType; id: string } | undefined {
  if (input.codeScopeId) return { type: "code_scope", id: input.codeScopeId };
  if (input.flowNodeId) return { type: "flow_node", id: input.flowNodeId };
  if (input.workGroupId) return { type: "work_group", id: input.workGroupId };
  if (input.taskId) return { type: "task", id: input.taskId };
  return undefined;
}