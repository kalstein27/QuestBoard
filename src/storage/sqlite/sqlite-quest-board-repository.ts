import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  Activity,
  ActivityType,
  Artifact,
  ArtifactType,
  BoardEntityType,
  BoardNodePosition,
  Claim,
  ClaimState,
  InvestigationItem,
  InvestigationItemLink,
  InvestigationItemTaskLink,
  InvestigationNode,
  Project,
  ProjectStatus,
  Relation,
  RelationEntityType,
  Task,
  TaskPriority,
  TaskStatus,
} from "../../core/domain.js";
import {
  ClaimConflictError,
  ClaimGenerationConflictError,
  ClaimNotFoundError,
  ClaimOwnershipError,
  EntityNotFoundError,
  EntityRevisionConflictError,
  MutationRequestConflictError,
  RevisionConflictError,
} from "../../core/errors.js";
import type {
  MutationExecution,
  MutationRequest,
  QuestBoardRepository,
  TaskListFilter,
} from "../../application/quest-board-repository.js";

type ProjectRow = {
  id: string;
  name: string;
  description: string;
  root_path: string | null;
  status: ProjectStatus;
  created_at: string;
  updated_at: string;
};

type TaskRow = {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  tags_json: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  revision: number;
};

type ClaimRow = {
  claim_id: string | null;
  task_id: string;
  agent_id: string;
  state: ClaimState;
  claimed_at: string;
  released_at: string | null;
};

type MutationReceiptRow = {
  request_id: string;
  operation: string;
  actor_id: string;
  fingerprint: string;
  result_json: string;
  created_at: string;
};

type ActivityRow = {
  id: string;
  project_id: string;
  task_id: string | null;
  actor_id: string;
  actor_provider: string;
  event_type: ActivityType;
  summary: string;
  before_revision: number | null;
  after_revision: number | null;
  created_at: string;
};

type ArtifactRow = {
  id: string;
  project_id: string;
  task_id: string;
  artifact_type: ArtifactType;
  title: string;
  locator: string;
  description: string;
  created_by: string;
  created_at: string;
};

type RelationRow = {
  id: string;
  project_id: string;
  from_type: RelationEntityType;
  from_id: string;
  to_type: RelationEntityType;
  to_id: string;
  kind: string;
  label: string;
  created_by: string;
  created_at: string;
};

type BoardPositionRow = {
  project_id: string;
  entity_type: BoardEntityType;
  entity_id: string;
  x: number;
  y: number;
  updated_by: string;
  updated_at: string;
};

type InvestigationNodeRow = {
  id: string;
  project_id: string;
  title: string;
  description: string;
  kind: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
};

type InvestigationItemRow = {
  id: string;
  node_id: string;
  title: string;
  description: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  revision: number;
};

type InvestigationItemLinkRow = {
  id: string;
  project_id: string;
  from_item_id: string;
  to_node_id: string;
  label: string;
  kind: string;
  created_by: string;
  created_at: string;
};

type InvestigationItemTaskLinkRow = {
  item_id: string;
  task_id: string;
  sort_order: number;
  created_at: string;
};

export class SqliteQuestBoardRepository implements QuestBoardRepository {
  private readonly db: DatabaseSync;
  readonly databaseId: string;
  private transactionDepth = 0;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
    this.databaseId = this.ensureDatabaseId();
  }

  runIdempotentMutation<T>(request: MutationRequest | undefined, operation: () => T): MutationExecution<T> {
    if (!request) {
      return this.transaction(() => ({ value: operation(), replayed: false }));
    }

    return this.transaction(() => {
      const existing = this.db
        .prepare("SELECT * FROM mutation_receipts WHERE request_id = ?")
        .get(request.requestId) as MutationReceiptRow | undefined;
      if (existing) {
        if (
          existing.operation !== request.operation
          || existing.actor_id !== request.actorId
          || existing.fingerprint !== request.fingerprint
        ) {
          throw new MutationRequestConflictError(request.requestId);
        }
        return { value: JSON.parse(existing.result_json) as T, replayed: true };
      }

      const value = operation();
      this.db
        .prepare(`
          INSERT INTO mutation_receipts (request_id, operation, actor_id, fingerprint, result_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          request.requestId,
          request.operation,
          request.actorId,
          request.fingerprint,
          JSON.stringify(value),
          request.createdAt,
        );
      return { value, replayed: false };
    });
  }

  createProject(project: Project): void {
    this.db
      .prepare(`
        INSERT INTO projects (id, name, description, root_path, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        project.id,
        project.name,
        project.description,
        project.rootPath ?? null,
        project.status,
        project.createdAt,
        project.updatedAt,
      );
  }

  getProject(projectId: string): Project | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
    return row ? mapProject(row) : undefined;
  }

  listProjects(): Project[] {
    const rows = this.db
      .prepare("SELECT * FROM projects ORDER BY created_at ASC, id ASC")
      .all() as ProjectRow[];
    return rows.map(mapProject);
  }

  updateProject(project: Project): void {
    this.db
      .prepare(`
        UPDATE projects
        SET name = ?, description = ?, root_path = ?, status = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        project.name,
        project.description,
        project.rootPath ?? null,
        project.status,
        project.updatedAt,
        project.id,
      );
  }

  createTask(task: Task, activity: Activity): void {
    this.transaction(() => {
      this.db
        .prepare(`
          INSERT INTO tasks (
            id, project_id, title, description, status, priority, tags_json,
            created_by, created_at, updated_at, revision
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          task.id,
          task.projectId,
          task.title,
          task.description,
          task.status,
          task.priority,
          JSON.stringify(task.tags),
          task.createdBy,
          task.createdAt,
          task.updatedAt,
          task.revision,
        );
      this.insertActivity(activity);
    });
  }

  getTask(taskId: string): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
    return row ? mapTask(row) : undefined;
  }

  listTasks(filter: TaskListFilter = {}): Task[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.projectId !== undefined) {
      clauses.push("project_id = ?");
      params.push(filter.projectId);
    }
    if (filter.status !== undefined) {
      clauses.push("status = ?");
      params.push(filter.status);
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM tasks${where} ORDER BY created_at ASC, id ASC`)
      .all(...params) as TaskRow[];
    return rows.map(mapTask);
  }

  updateTask(task: Task, activity: Activity, expectedRevision: number): void {
    this.transaction(() => {
      const result = this.db
        .prepare(`
          UPDATE tasks
          SET title = ?, description = ?, status = ?, priority = ?, tags_json = ?, updated_at = ?, revision = ?
          WHERE id = ? AND revision = ?
        `)
        .run(
          task.title,
          task.description,
          task.status,
          task.priority,
          JSON.stringify(task.tags),
          task.updatedAt,
          task.revision,
          task.id,
          expectedRevision,
        );
      if (Number(result.changes) !== 1) {
        const current = this.getTask(task.id);
        if (!current) throw new EntityNotFoundError("Task", task.id);
        throw new RevisionConflictError(task.id, expectedRevision, current.revision);
      }
      this.insertActivity(activity);
    });
  }

  deleteTask(taskId: string): void {
    this.transaction(() => {
      const artifactIds = (this.db
        .prepare("SELECT id FROM artifacts WHERE task_id = ?")
        .all(taskId) as Array<{ id: string }>).map((row) => row.id);

      this.db.prepare(`
        DELETE FROM relations
        WHERE (from_type = 'task' AND from_id = ?)
           OR (to_type = 'task' AND to_id = ?)
           OR (from_type = 'artifact' AND from_id IN (SELECT id FROM artifacts WHERE task_id = ?))
           OR (to_type = 'artifact' AND to_id IN (SELECT id FROM artifacts WHERE task_id = ?))
      `).run(taskId, taskId, taskId, taskId);
      this.db.prepare("DELETE FROM board_positions WHERE entity_type = 'task' AND entity_id = ?").run(taskId);
      for (const artifactId of artifactIds) {
        this.db.prepare("DELETE FROM board_positions WHERE entity_type = 'artifact' AND entity_id = ?").run(artifactId);
      }
      this.db.prepare("DELETE FROM claims WHERE task_id = ?").run(taskId);
      this.db.prepare("DELETE FROM artifacts WHERE task_id = ?").run(taskId);
      this.db.prepare("UPDATE activities SET task_id = NULL WHERE task_id = ?").run(taskId);
      const result = this.db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
      if (Number(result.changes) !== 1) throw new EntityNotFoundError("Task", taskId);
    });
  }

  getClaim(taskId: string): Claim | undefined {
    const row = this.db.prepare("SELECT * FROM claims WHERE task_id = ?").get(taskId) as ClaimRow | undefined;
    return row ? mapClaim(row) : undefined;
  }

  listProjectClaims(projectId: string): Claim[] {
    const rows = this.db.prepare(`
      SELECT c.* FROM claims c
      JOIN tasks t ON t.id = c.task_id
      WHERE t.project_id = ? AND c.state = 'active'
      ORDER BY t.created_at ASC, t.id ASC
    `).all(projectId) as ClaimRow[];
    return rows.map(mapClaim);
  }

  claimTask(claim: Claim, activity: Activity): Claim {
    return this.transaction(() => {
      const existing = this.getClaim(claim.taskId);
      if (existing?.state === "active") {
        throw new ClaimConflictError(claim.taskId, existing.agentId);
      }

      this.db
        .prepare(`
          INSERT INTO claims (task_id, claim_id, agent_id, state, claimed_at, released_at)
          VALUES (?, ?, ?, 'active', ?, NULL)
          ON CONFLICT(task_id) DO UPDATE SET
            claim_id = excluded.claim_id,
            agent_id = excluded.agent_id,
            state = 'active',
            claimed_at = excluded.claimed_at,
            released_at = NULL
        `)
        .run(claim.taskId, claim.id, claim.agentId, claim.claimedAt);
      this.insertActivity(activity);
      return claim;
    });
  }

  releaseClaim(taskId: string, agentId: string, claimId: string, releasedAt: string, activity: Activity): Claim {
    return this.transaction(() => {
      const current = this.getClaim(taskId);
      if (!current || current.state !== "active") throw new ClaimNotFoundError(taskId);
      if (current.agentId !== agentId) {
        throw new ClaimOwnershipError(taskId, current.agentId, agentId);
      }
      if (current.id !== claimId) {
        throw new ClaimGenerationConflictError(taskId, claimId, current.id);
      }

      const result = this.db
        .prepare(`
          UPDATE claims SET state = 'released', released_at = ?
          WHERE task_id = ? AND agent_id = ? AND claim_id = ? AND state = 'active'
        `)
        .run(releasedAt, taskId, agentId, claimId);
      if (Number(result.changes) !== 1) {
        const fresh = this.getClaim(taskId);
        if (!fresh || fresh.state !== "active") throw new ClaimNotFoundError(taskId);
        if (fresh.agentId !== agentId) throw new ClaimOwnershipError(taskId, fresh.agentId, agentId);
        throw new ClaimGenerationConflictError(taskId, claimId, fresh.id);
      }
      this.insertActivity(activity);
      return { ...current, state: "released", releasedAt };
    });
  }

  appendActivity(activity: Activity): void {
    this.insertActivity(activity);
  }

  listTaskActivity(taskId: string): Activity[] {
    const rows = this.db
      .prepare("SELECT * FROM activities WHERE task_id = ? ORDER BY seq ASC")
      .all(taskId) as ActivityRow[];
    return rows.map(mapActivity);
  }

  createArtifact(artifact: Artifact, activity: Activity): void {
    this.transaction(() => {
      this.db
        .prepare(`
          INSERT INTO artifacts (
            id, project_id, task_id, artifact_type, title, locator, description, created_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          artifact.id,
          artifact.projectId,
          artifact.taskId,
          artifact.type,
          artifact.title,
          artifact.locator,
          artifact.description,
          artifact.createdBy,
          artifact.createdAt,
        );
      this.insertActivity(activity);
    });
  }

  getArtifact(artifactId: string): Artifact | undefined {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(artifactId) as ArtifactRow | undefined;
    return row ? mapArtifact(row) : undefined;
  }

  listTaskArtifacts(taskId: string): Artifact[] {
    const rows = this.db
      .prepare("SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at ASC, id ASC")
      .all(taskId) as ArtifactRow[];
    return rows.map(mapArtifact);
  }

  listProjectArtifacts(projectId: string): Artifact[] {
    const rows = this.db
      .prepare("SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at ASC, id ASC")
      .all(projectId) as ArtifactRow[];
    return rows.map(mapArtifact);
  }

  deleteArtifact(artifactId: string): void {
    this.transaction(() => {
      this.db.prepare(`
        DELETE FROM relations
        WHERE (from_type = 'artifact' AND from_id = ?)
           OR (to_type = 'artifact' AND to_id = ?)
      `).run(artifactId, artifactId);
      this.db.prepare("DELETE FROM board_positions WHERE entity_type = 'artifact' AND entity_id = ?").run(artifactId);
      const result = this.db.prepare("DELETE FROM artifacts WHERE id = ?").run(artifactId);
      if (Number(result.changes) !== 1) throw new EntityNotFoundError("Artifact", artifactId);
    });
  }

  createRelation(relation: Relation, activity: Activity): void {
    this.transaction(() => {
      this.db
        .prepare(`
          INSERT INTO relations (
            id, project_id, from_type, from_id, to_type, to_id, kind, label, created_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          relation.id,
          relation.projectId,
          relation.fromType,
          relation.fromId,
          relation.toType,
          relation.toId,
          relation.kind,
          relation.label,
          relation.createdBy,
          relation.createdAt,
        );
      this.insertActivity(activity);
    });
  }

  listTaskRelations(taskId: string): Relation[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM relations
        WHERE (from_type = 'task' AND from_id = ?)
           OR (to_type = 'task' AND to_id = ?)
           OR (from_type = 'artifact' AND from_id IN (SELECT id FROM artifacts WHERE task_id = ?))
           OR (to_type = 'artifact' AND to_id IN (SELECT id FROM artifacts WHERE task_id = ?))
        ORDER BY created_at ASC, id ASC
      `)
      .all(taskId, taskId, taskId, taskId) as RelationRow[];
    return rows.map(mapRelation);
  }

  listProjectRelations(projectId: string): Relation[] {
    const rows = this.db
      .prepare("SELECT * FROM relations WHERE project_id = ? ORDER BY created_at ASC, id ASC")
      .all(projectId) as RelationRow[];
    return rows.map(mapRelation);
  }

  deleteRelation(relationId: string): void {
    const result = this.db.prepare("DELETE FROM relations WHERE id = ?").run(relationId);
    if (Number(result.changes) !== 1) throw new EntityNotFoundError("Relation", relationId);
  }

  createInvestigationNode(node: InvestigationNode): void {
    this.db.prepare(`
      INSERT INTO investigation_nodes (id, project_id, title, description, kind, created_at, updated_at, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(node.id, node.projectId, node.title, node.description, node.kind ?? null, node.createdAt, node.updatedAt, node.revision);
  }

  getInvestigationNode(nodeId: string): InvestigationNode | undefined {
    const row = this.db.prepare("SELECT * FROM investigation_nodes WHERE id = ?").get(nodeId) as InvestigationNodeRow | undefined;
    return row ? mapInvestigationNode(row) : undefined;
  }

  listInvestigationNodes(projectId: string): InvestigationNode[] {
    return (this.db.prepare("SELECT * FROM investigation_nodes WHERE project_id = ? ORDER BY created_at ASC, id ASC").all(projectId) as InvestigationNodeRow[])
      .map(mapInvestigationNode);
  }

  updateInvestigationNode(node: InvestigationNode, expectedRevision: number): void {
    const result = this.db.prepare(`
      UPDATE investigation_nodes SET title = ?, description = ?, kind = ?, updated_at = ?, revision = ?
      WHERE id = ? AND revision = ?
    `).run(node.title, node.description, node.kind ?? null, node.updatedAt, node.revision, node.id, expectedRevision);
    if (Number(result.changes) !== 1) {
      const current = this.getInvestigationNode(node.id);
      if (!current) throw new EntityNotFoundError("InvestigationNode", node.id);
      throw new EntityRevisionConflictError("InvestigationNode", node.id, expectedRevision, current.revision);
    }
  }

  deleteInvestigationNode(nodeId: string): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM board_positions WHERE entity_type = 'investigation_node' AND entity_id = ?").run(nodeId);
      const result = this.db.prepare("DELETE FROM investigation_nodes WHERE id = ?").run(nodeId);
      if (Number(result.changes) !== 1) throw new EntityNotFoundError("InvestigationNode", nodeId);
    });
  }

  createInvestigationItem(item: InvestigationItem): void {
    this.db.prepare(`
      INSERT INTO investigation_items (id, node_id, title, description, sort_order, created_at, updated_at, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(item.id, item.nodeId, item.title, item.description, item.sortOrder, item.createdAt, item.updatedAt, item.revision);
  }

  getInvestigationItem(itemId: string): InvestigationItem | undefined {
    const row = this.db.prepare("SELECT * FROM investigation_items WHERE id = ?").get(itemId) as InvestigationItemRow | undefined;
    return row ? mapInvestigationItem(row) : undefined;
  }

  listInvestigationItems(projectId: string): InvestigationItem[] {
    return (this.db.prepare(`
      SELECT i.* FROM investigation_items i
      JOIN investigation_nodes n ON n.id = i.node_id
      WHERE n.project_id = ?
      ORDER BY n.created_at ASC, i.sort_order ASC, i.created_at ASC, i.id ASC
    `).all(projectId) as InvestigationItemRow[]).map(mapInvestigationItem);
  }

  listInvestigationNodeItems(nodeId: string): InvestigationItem[] {
    return (this.db.prepare("SELECT * FROM investigation_items WHERE node_id = ? ORDER BY sort_order ASC, created_at ASC, id ASC").all(nodeId) as InvestigationItemRow[])
      .map(mapInvestigationItem);
  }

  updateInvestigationItem(item: InvestigationItem, expectedRevision: number): void {
    const result = this.db.prepare(`
      UPDATE investigation_items SET title = ?, description = ?, sort_order = ?, updated_at = ?, revision = ?
      WHERE id = ? AND revision = ?
    `).run(item.title, item.description, item.sortOrder, item.updatedAt, item.revision, item.id, expectedRevision);
    if (Number(result.changes) !== 1) {
      const current = this.getInvestigationItem(item.id);
      if (!current) throw new EntityNotFoundError("InvestigationItem", item.id);
      throw new EntityRevisionConflictError("InvestigationItem", item.id, expectedRevision, current.revision);
    }
  }

  deleteInvestigationItem(itemId: string): void {
    const result = this.db.prepare("DELETE FROM investigation_items WHERE id = ?").run(itemId);
    if (Number(result.changes) !== 1) throw new EntityNotFoundError("InvestigationItem", itemId);
  }

  createInvestigationItemLink(link: InvestigationItemLink): void {
    this.db.prepare(`
      INSERT INTO investigation_item_links (id, project_id, from_item_id, to_node_id, label, kind, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(link.id, link.projectId, link.fromItemId, link.toNodeId, link.label, link.kind, link.createdBy, link.createdAt);
  }

  listInvestigationItemLinks(projectId: string): InvestigationItemLink[] {
    return (this.db.prepare("SELECT * FROM investigation_item_links WHERE project_id = ? ORDER BY created_at ASC, id ASC").all(projectId) as InvestigationItemLinkRow[])
      .map(mapInvestigationItemLink);
  }

  deleteInvestigationItemLink(linkId: string): void {
    this.db.prepare("DELETE FROM investigation_item_links WHERE id = ?").run(linkId);
  }

  createInvestigationItemTaskLink(link: InvestigationItemTaskLink): InvestigationItemTaskLink {
    this.db.prepare(`
      INSERT INTO investigation_item_tasks (item_id, task_id, sort_order, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(item_id, task_id) DO NOTHING
    `).run(link.itemId, link.taskId, link.sortOrder, link.createdAt);
    const row = this.db.prepare("SELECT * FROM investigation_item_tasks WHERE item_id = ? AND task_id = ?")
      .get(link.itemId, link.taskId) as InvestigationItemTaskLinkRow | undefined;
    if (!row) throw new EntityNotFoundError("InvestigationItemTaskLink", `${link.itemId}:${link.taskId}`);
    return mapInvestigationItemTaskLink(row);
  }

  listInvestigationItemTaskLinks(projectId: string): InvestigationItemTaskLink[] {
    return (this.db.prepare(`
      SELECT it.* FROM investigation_item_tasks it
      JOIN investigation_items i ON i.id = it.item_id
      JOIN investigation_nodes n ON n.id = i.node_id
      WHERE n.project_id = ?
      ORDER BY i.sort_order ASC, it.sort_order ASC, it.created_at ASC
    `).all(projectId) as InvestigationItemTaskLinkRow[]).map(mapInvestigationItemTaskLink);
  }

  deleteInvestigationItemTaskLink(itemId: string, taskId: string): void {
    this.db.prepare("DELETE FROM investigation_item_tasks WHERE item_id = ? AND task_id = ?").run(itemId, taskId);
  }

  listBoardPositions(projectId: string): BoardNodePosition[] {
    const rows = this.db
      .prepare("SELECT * FROM board_positions WHERE project_id = ? ORDER BY entity_type ASC, entity_id ASC")
      .all(projectId) as BoardPositionRow[];
    return rows.map(mapBoardPosition);
  }

  upsertBoardPosition(position: BoardNodePosition): BoardNodePosition {
    this.db
      .prepare(`
        INSERT INTO board_positions (project_id, entity_type, entity_id, x, y, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, entity_type, entity_id) DO UPDATE SET
          x = excluded.x,
          y = excluded.y,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `)
      .run(
        position.projectId,
        position.entityType,
        position.entityId,
        position.x,
        position.y,
        position.updatedBy,
        position.updatedAt,
      );
    return position;
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        root_path TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('inbox', 'planned', 'ready', 'in_progress', 'blocked', 'review', 'done')),
        priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
        tags_json TEXT NOT NULL DEFAULT '[]',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1)
      );

      CREATE INDEX IF NOT EXISTS tasks_project_status_idx ON tasks(project_id, status);

      CREATE TABLE IF NOT EXISTS claims (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE RESTRICT,
        claim_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'released')),
        claimed_at TEXT NOT NULL,
        released_at TEXT
      );

      CREATE TABLE IF NOT EXISTS activities (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
        actor_id TEXT NOT NULL,
        actor_provider TEXT NOT NULL,
        event_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        before_revision INTEGER,
        after_revision INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS activities_task_seq_idx ON activities(task_id, seq);

      CREATE TABLE IF NOT EXISTS mutation_receipts (
        request_id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS mutation_receipts_created_idx ON mutation_receipts(created_at);

      CREATE TABLE IF NOT EXISTS questboard_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
        artifact_type TEXT NOT NULL CHECK (artifact_type IN ('file', 'url', 'commit', 'screenshot', 'operation', 'log', 'other')),
        title TEXT NOT NULL,
        locator TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS artifacts_task_created_idx ON artifacts(task_id, created_at);

      CREATE TABLE IF NOT EXISTS relations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        from_type TEXT NOT NULL CHECK (from_type IN ('task', 'artifact')),
        from_id TEXT NOT NULL,
        to_type TEXT NOT NULL CHECK (to_type IN ('task', 'artifact')),
        to_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        CHECK (from_type <> to_type OR from_id <> to_id)
      );

      CREATE INDEX IF NOT EXISTS relations_project_created_idx ON relations(project_id, created_at);
      CREATE INDEX IF NOT EXISTS relations_from_idx ON relations(from_type, from_id);
      CREATE INDEX IF NOT EXISTS relations_to_idx ON relations(to_type, to_id);

      CREATE TABLE IF NOT EXISTS investigation_nodes (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        kind TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1)
      );

      CREATE INDEX IF NOT EXISTS investigation_nodes_project_created_idx ON investigation_nodes(project_id, created_at);

      CREATE TABLE IF NOT EXISTS investigation_items (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL REFERENCES investigation_nodes(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1)
      );

      CREATE INDEX IF NOT EXISTS investigation_items_node_order_idx ON investigation_items(node_id, sort_order, created_at);

      CREATE TABLE IF NOT EXISTS investigation_item_links (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        from_item_id TEXT NOT NULL REFERENCES investigation_items(id) ON DELETE CASCADE,
        to_node_id TEXT NOT NULL REFERENCES investigation_nodes(id) ON DELETE CASCADE,
        label TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'flow',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS investigation_item_links_project_idx ON investigation_item_links(project_id, created_at);
      CREATE INDEX IF NOT EXISTS investigation_item_links_from_idx ON investigation_item_links(from_item_id);
      CREATE INDEX IF NOT EXISTS investigation_item_links_to_idx ON investigation_item_links(to_node_id);

      CREATE TABLE IF NOT EXISTS investigation_item_tasks (
        item_id TEXT NOT NULL REFERENCES investigation_items(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
        created_at TEXT NOT NULL,
        PRIMARY KEY (item_id, task_id)
      );

      CREATE INDEX IF NOT EXISTS investigation_item_tasks_task_idx ON investigation_item_tasks(task_id);

      CREATE TABLE IF NOT EXISTS board_positions (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('task', 'artifact', 'investigation_node')),
        entity_id TEXT NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, entity_type, entity_id)
      );
    `);

    const claimColumns = this.db.prepare("PRAGMA table_info(claims)").all() as Array<{ name: string }>;
    if (!claimColumns.some((column) => column.name === "claim_id")) {
      this.db.exec("ALTER TABLE claims ADD COLUMN claim_id TEXT");
      this.db.exec("UPDATE claims SET claim_id = 'legacy:' || task_id WHERE claim_id IS NULL");
    }

    const boardPositionDefinition = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'board_positions'").get() as { sql: string } | undefined;
    if (boardPositionDefinition && !boardPositionDefinition.sql.includes("investigation_node")) {
      this.transaction(() => {
        this.db.exec(`
          ALTER TABLE board_positions RENAME TO board_positions_legacy;
          CREATE TABLE board_positions (
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            entity_type TEXT NOT NULL CHECK (entity_type IN ('task', 'artifact', 'investigation_node')),
            entity_id TEXT NOT NULL,
            x REAL NOT NULL,
            y REAL NOT NULL,
            updated_by TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (project_id, entity_type, entity_id)
          );
          INSERT INTO board_positions (project_id, entity_type, entity_id, x, y, updated_by, updated_at)
          SELECT project_id, entity_type, entity_id, x, y, updated_by, updated_at FROM board_positions_legacy;
          DROP TABLE board_positions_legacy;
        `);
      });
    }
  }

  private ensureDatabaseId(): string {
    const existing = this.db
      .prepare("SELECT value FROM questboard_metadata WHERE key = 'database_id'")
      .get() as { value: string } | undefined;
    if (existing?.value) return existing.value;

    const generated = randomUUID();
    this.db
      .prepare("INSERT OR IGNORE INTO questboard_metadata (key, value) VALUES ('database_id', ?)")
      .run(generated);
    const stored = this.db
      .prepare("SELECT value FROM questboard_metadata WHERE key = 'database_id'")
      .get() as { value: string } | undefined;
    if (!stored?.value) throw new Error("QuestBoard database identity could not be initialized");
    return stored.value;
  }

  private insertActivity(activity: Activity): void {
    this.db
      .prepare(`
        INSERT INTO activities (
          id, project_id, task_id, actor_id, actor_provider, event_type,
          summary, before_revision, after_revision, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        activity.id,
        activity.projectId,
        activity.taskId ?? null,
        activity.actorId,
        activity.actorProvider,
        activity.type,
        activity.summary,
        activity.beforeRevision ?? null,
        activity.afterRevision ?? null,
        activity.createdAt,
      );
  }

  private transaction<T>(fn: () => T): T {
    if (this.transactionDepth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth += 1;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }
}

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.root_path ? { rootPath: row.root_path } : {}),
  };
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    tags: JSON.parse(row.tags_json) as string[],
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

function mapClaim(row: ClaimRow): Claim {
  return {
    id: row.claim_id ?? `legacy:${row.task_id}`,
    taskId: row.task_id,
    agentId: row.agent_id,
    state: row.state,
    claimedAt: row.claimed_at,
    ...(row.released_at ? { releasedAt: row.released_at } : {}),
  };
}

function mapActivity(row: ActivityRow): Activity {
  return {
    id: row.id,
    projectId: row.project_id,
    actorId: row.actor_id,
    actorProvider: row.actor_provider,
    type: row.event_type,
    summary: row.summary,
    createdAt: row.created_at,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.before_revision !== null ? { beforeRevision: row.before_revision } : {}),
    ...(row.after_revision !== null ? { afterRevision: row.after_revision } : {}),
  };
}

function mapArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    type: row.artifact_type,
    title: row.title,
    locator: row.locator,
    description: row.description,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function mapRelation(row: RelationRow): Relation {
  return {
    id: row.id,
    projectId: row.project_id,
    fromType: row.from_type,
    fromId: row.from_id,
    toType: row.to_type,
    toId: row.to_id,
    kind: row.kind,
    label: row.label,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function mapBoardPosition(row: BoardPositionRow): BoardNodePosition {
  return {
    projectId: row.project_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    x: row.x,
    y: row.y,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

function mapInvestigationNode(row: InvestigationNodeRow): InvestigationNode {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
    ...(row.kind ? { kind: row.kind } : {}),
  };
}

function mapInvestigationItem(row: InvestigationItemRow): InvestigationItem {
  return {
    id: row.id,
    nodeId: row.node_id,
    title: row.title,
    description: row.description,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

function mapInvestigationItemLink(row: InvestigationItemLinkRow): InvestigationItemLink {
  return {
    id: row.id,
    projectId: row.project_id,
    fromItemId: row.from_item_id,
    toNodeId: row.to_node_id,
    label: row.label,
    kind: row.kind,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function mapInvestigationItemTaskLink(row: InvestigationItemTaskLinkRow): InvestigationItemTaskLink {
  return { itemId: row.item_id, taskId: row.task_id, sortOrder: row.sort_order, createdAt: row.created_at };
}