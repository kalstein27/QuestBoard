import { DatabaseSync } from "node:sqlite";
import type {
  Activity,
  ActivityType,
  Artifact,
  ArtifactType,
  BoardNodePosition,
  Claim,
  ClaimState,
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
  entity_type: RelationEntityType;
  entity_id: string;
  x: number;
  y: number;
  updated_by: string;
  updated_at: string;
};

export class SqliteQuestBoardRepository implements QuestBoardRepository {
  private readonly db: DatabaseSync;
  private transactionDepth = 0;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  runIdempotentMutation<T>(request: MutationRequest | undefined, operation: () => T): MutationExecution<T> {
    if (!request) return { value: operation(), replayed: false };

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

  getClaim(taskId: string): Claim | undefined {
    const row = this.db.prepare("SELECT * FROM claims WHERE task_id = ?").get(taskId) as ClaimRow | undefined;
    return row ? mapClaim(row) : undefined;
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

      CREATE TABLE IF NOT EXISTS board_positions (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('task', 'artifact')),
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