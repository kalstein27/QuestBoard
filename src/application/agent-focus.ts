import type { QuestBoardRepository } from "./quest-board-repository.js";

export interface AgentFocus {
  projectId: string;
  sessionId: string;
  taskId?: string;
  workGroupId?: string;
  flowNodeId?: string;
  codeScopeId?: string;
  updatedAt: string;
}

export interface SetAgentFocusInput {
  projectId: string;
  sessionId: string;
  taskId?: string;
  workGroupId?: string;
  flowNodeId?: string;
  codeScopeId?: string;
}

export class AgentFocusService {
  private readonly byProject = new Map<string, Map<string, AgentFocus>>();

  constructor(
    private readonly repository: QuestBoardRepository,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  list(projectId: string): AgentFocus[] {
    this.requireProject(projectId);
    return [...(this.byProject.get(projectId)?.values() ?? [])]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 20);
  }

  latest(projectId: string): AgentFocus | null {
    return this.list(projectId)[0] ?? null;
  }

  set(input: SetAgentFocusInput): AgentFocus {
    this.requireProject(input.projectId);
    const sessionId = input.sessionId.trim();
    if (!sessionId) throw new TypeError("sessionId must be a non-empty string");
    if (input.taskId) {
      const task = this.repository.getTask(input.taskId);
      if (!task || task.projectId !== input.projectId) throw new TypeError(`Task ${input.taskId} does not belong to project ${input.projectId}`);
    }
    const focus: AgentFocus = {
      projectId: input.projectId,
      sessionId,
      ...optionalTrimmed("taskId", input.taskId),
      ...optionalTrimmed("workGroupId", input.workGroupId),
      ...optionalTrimmed("flowNodeId", input.flowNodeId),
      ...optionalTrimmed("codeScopeId", input.codeScopeId),
      updatedAt: this.now(),
    };
    let sessions = this.byProject.get(input.projectId);
    if (!sessions) {
      sessions = new Map();
      this.byProject.set(input.projectId, sessions);
    }
    sessions.set(sessionId, focus);
    return focus;
  }

  clear(projectId: string, sessionId: string): { cleared: boolean } {
    this.requireProject(projectId);
    const sessions = this.byProject.get(projectId);
    const cleared = sessions?.delete(sessionId.trim()) ?? false;
    if (sessions && sessions.size === 0) this.byProject.delete(projectId);
    return { cleared };
  }

  private requireProject(projectId: string): void {
    if (!this.repository.getProject(projectId)) throw new TypeError(`Unknown project ${projectId}`);
  }
}

function optionalTrimmed<K extends "taskId" | "workGroupId" | "flowNodeId" | "codeScopeId">(
  key: K,
  value: string | undefined,
): Partial<Record<K, string>> {
  const trimmed = value?.trim();
  return trimmed ? { [key]: trimmed } as Partial<Record<K, string>> : {};
}
