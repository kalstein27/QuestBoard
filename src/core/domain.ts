export const TASK_STATUSES = [
  "inbox",
  "planned",
  "ready",
  "in_progress",
  "blocked",
  "review",
  "done",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const ARTIFACT_TYPES = ["file", "url", "commit", "screenshot", "operation", "log", "other"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const RELATION_ENTITY_TYPES = ["task", "artifact"] as const;
export type RelationEntityType = (typeof RELATION_ENTITY_TYPES)[number];

export type ProjectStatus = "active" | "archived";
export type ClaimState = "active" | "released";

export type ActivityType =
  | "task_created"
  | "task_updated"
  | "status_changed"
  | "task_claimed"
  | "task_released"
  | "note_added"
  | "artifact_attached"
  | "relation_added"
  | "agent_handoff";

export interface ActorRef {
  id: string;
  provider: string;
  displayName?: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  rootPath?: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  tags: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface Claim {
  id: string;
  taskId: string;
  agentId: string;
  state: ClaimState;
  claimedAt: string;
  releasedAt?: string;
}

export interface Artifact {
  id: string;
  projectId: string;
  taskId: string;
  type: ArtifactType;
  title: string;
  locator: string;
  description: string;
  createdBy: string;
  createdAt: string;
}

export interface Relation {
  id: string;
  projectId: string;
  fromType: RelationEntityType;
  fromId: string;
  toType: RelationEntityType;
  toId: string;
  kind: string;
  label: string;
  createdBy: string;
  createdAt: string;
}

export interface BoardNodePosition {
  projectId: string;
  entityType: RelationEntityType;
  entityId: string;
  x: number;
  y: number;
  updatedBy: string;
  updatedAt: string;
}

export interface Activity {
  id: string;
  projectId: string;
  taskId?: string;
  actorId: string;
  actorProvider: string;
  type: ActivityType;
  summary: string;
  beforeRevision?: number;
  afterRevision?: number;
  createdAt: string;
}