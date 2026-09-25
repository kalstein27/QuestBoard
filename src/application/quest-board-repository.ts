import type {
  Activity,
  Artifact,
  BoardNodePosition,
  Claim,
  InvestigationItem,
  InvestigationItemLink,
  InvestigationItemTaskLink,
  InvestigationNode,
  Project,
  Relation,
  Task,
  TaskStatus,
} from "../core/domain.js";
import type {
  CodeMapInvestigationNodeBinding,
  CodeMapInvestigationRelationBinding,
} from "./code-map-investigation-sync.js";

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
  deleteTask(taskId: string): void;

  getClaim(taskId: string): Claim | undefined;
  listProjectClaims(projectId: string): Claim[];
  claimTask(claim: Claim, activity: Activity): Claim;
  releaseClaim(taskId: string, agentId: string, claimId: string, releasedAt: string, activity: Activity): Claim;

  appendActivity(activity: Activity): void;
  listTaskActivity(taskId: string): Activity[];

  createArtifact(artifact: Artifact, activity: Activity): void;
  getArtifact(artifactId: string): Artifact | undefined;
  listTaskArtifacts(taskId: string): Artifact[];
  listProjectArtifacts(projectId: string): Artifact[];
  deleteArtifact(artifactId: string): void;

  createRelation(relation: Relation, activity: Activity): void;
  listTaskRelations(taskId: string): Relation[];
  listProjectRelations(projectId: string): Relation[];
  deleteRelation(relationId: string): void;

  createInvestigationNode(node: InvestigationNode): void;
  getInvestigationNode(nodeId: string): InvestigationNode | undefined;
  listInvestigationNodes(projectId: string): InvestigationNode[];
  updateInvestigationNode(node: InvestigationNode, expectedRevision: number): void;
  deleteInvestigationNode(nodeId: string): void;

  createInvestigationItem(item: InvestigationItem): void;
  getInvestigationItem(itemId: string): InvestigationItem | undefined;
  listInvestigationItems(projectId: string): InvestigationItem[];
  listInvestigationNodeItems(nodeId: string): InvestigationItem[];
  updateInvestigationItem(item: InvestigationItem, expectedRevision: number): void;
  deleteInvestigationItem(itemId: string): void;

  createInvestigationItemLink(link: InvestigationItemLink): void;
  listInvestigationItemLinks(projectId: string): InvestigationItemLink[];
  deleteInvestigationItemLink(linkId: string): void;

  createInvestigationItemTaskLink(link: InvestigationItemTaskLink): InvestigationItemTaskLink;
  listInvestigationItemTaskLinks(projectId: string): InvestigationItemTaskLink[];
  deleteInvestigationItemTaskLink(itemId: string, taskId: string): void;

  getCodeMapInvestigationNodeBinding(projectId: string, codeNodeId: string): CodeMapInvestigationNodeBinding | undefined;
  listCodeMapInvestigationNodeBindings(projectId: string): CodeMapInvestigationNodeBinding[];
  upsertCodeMapInvestigationNodeBinding(binding: CodeMapInvestigationNodeBinding): CodeMapInvestigationNodeBinding;
  deleteCodeMapInvestigationNodeBinding(projectId: string, codeNodeId: string): void;

  getCodeMapInvestigationRelationBinding(projectId: string, codeRelationId: string): CodeMapInvestigationRelationBinding | undefined;
  listCodeMapInvestigationRelationBindings(projectId: string): CodeMapInvestigationRelationBinding[];
  upsertCodeMapInvestigationRelationBinding(binding: CodeMapInvestigationRelationBinding): CodeMapInvestigationRelationBinding;
  deleteCodeMapInvestigationRelationBinding(projectId: string, codeRelationId: string): void;

  listBoardPositions(projectId: string): BoardNodePosition[];
  upsertBoardPosition(position: BoardNodePosition): BoardNodePosition;

  close(): void;
}