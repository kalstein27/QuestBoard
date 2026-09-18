import type { Activity, Artifact, BoardNodePosition, Claim, Project, Relation, Task, TaskStatus } from "../core/domain.js";

export interface MutationRequest {
  requestId: string;
  operation: string;
  actorId: string;
  fingerprint: string;
  createdAt: string;
}

export interface MutationExecution<T> {
  value: T;
  replayed: boolean;
}

export interface TaskListFilter {
  projectId?: string;
  status?: TaskStatus;
}

export interface QuestBoardRepository {
  runIdempotentMutation<T>(request: MutationRequest | undefined, operation: () => T): MutationExecution<T>;

  createProject(project: Project): void;
  getProject(projectId: string): Project | undefined;
  listProjects(): Project[];
  updateProject(project: Project): void;

  createTask(task: Task, activity: Activity): void;
  getTask(taskId: string): Task | undefined;
  listTasks(filter?: TaskListFilter): Task[];
  updateTask(task: Task, activity: Activity, expectedRevision: number): void;

  getClaim(taskId: string): Claim | undefined;
  claimTask(claim: Claim, activity: Activity): Claim;
  releaseClaim(taskId: string, agentId: string, claimId: string, releasedAt: string, activity: Activity): Claim;

  appendActivity(activity: Activity): void;
  listTaskActivity(taskId: string): Activity[];

  createArtifact(artifact: Artifact, activity: Activity): void;
  getArtifact(artifactId: string): Artifact | undefined;
  listTaskArtifacts(taskId: string): Artifact[];
  listProjectArtifacts(projectId: string): Artifact[];

  createRelation(relation: Relation, activity: Activity): void;
  listTaskRelations(taskId: string): Relation[];
  listProjectRelations(projectId: string): Relation[];

  listBoardPositions(projectId: string): BoardNodePosition[];
  upsertBoardPosition(position: BoardNodePosition): BoardNodePosition;

  close(): void;
}