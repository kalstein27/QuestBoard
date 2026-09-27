import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ClaimConflictError,
  ClaimGenerationConflictError,
  MutationRequestConflictError,
  RevisionConflictError,
  QuestBoardService,
  SqliteQuestBoardRepository,
  type ActorRef,
} from "../src/index.js";
import type { ConcurrencyDiagnosticEvent } from "../src/index.js";

const human: ActorRef = { id: "human:owner", provider: "human" };
const chatgpt: ActorRef = { id: "agent:chatgpt", provider: "chatgpt" };
const claude: ActorRef = { id: "agent:claude", provider: "claude" };

test("persists the first Project/Task/Claim/Activity vertical slice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "questboard-"));
  const databasePath = join(directory, "questboard.sqlite");

  try {
    const repository = new SqliteQuestBoardRepository(databasePath);
    const service = new QuestBoardService(repository);

    const project = service.createProject(
      { name: "QuestBoard", description: "Shared local work board" },
      human,
    );
    const task = service.createTask(
      {
        projectId: project.id,
        title: "Implement first foundation",
        description: "Ship the smallest persistence foundation",
        status: "ready",
        priority: "high",
        tags: ["foundation", "sqlite", "foundation"],
      },
      human,
    );

    assert.equal(service.getTask(task.id).status, "ready");
    assert.deepEqual(service.getTask(task.id).tags, ["foundation", "sqlite"]);
    assert.equal(service.getTask(task.id).goal, "Ship the smallest persistence foundation");
    assert.equal(service.getTask(task.id).now, "Task status: ready");
    assert.equal(service.getTask(task.id).next, "Next action has not been recorded yet.");
    assert.equal(Object.hasOwn(service.getTask(task.id), "blocked"), false);

    const updated = service.updateTask(task.id, {
      status: "in_progress",
      now: "Foundation persistence path verified",
      next: "Attach verification evidence",
      guardrail: "Keep Activity append-only",
      expectedRevision: 1,
    }, chatgpt);
    assert.equal(updated.status, "in_progress");
    assert.equal(updated.now, "Foundation persistence path verified");
    assert.equal(updated.next, "Attach verification evidence");
    assert.equal(updated.guardrail, "Keep Activity append-only");
    assert.equal(updated.revision, 2);
    assert.throws(
      () => service.updateTask(task.id, { status: "review", expectedRevision: 1 }, claude),
      RevisionConflictError,
    );

    const claim = service.claimTask(task.id, chatgpt);
    assert.equal(claim.state, "active");
    assert.equal(claim.agentId, chatgpt.id);

    assert.throws(() => service.claimTask(task.id, claude), ClaimConflictError);

    const released = service.releaseTask(task.id, chatgpt);
    assert.equal(released.state, "released");

    service.appendTaskActivity(task.id, "note_added", "Foundation verification recorded", chatgpt);
    const artifact = service.createArtifact(
      {
        taskId: task.id,
        type: "log",
        title: "Foundation verification log",
        locator: "logs/foundation.txt",
        description: "Evidence produced by the foundation test",
      },
      chatgpt,
    );
    const relation = service.createRelation(
      {
        fromType: "task",
        fromId: task.id,
        toType: "artifact",
        toId: artifact.id,
        kind: "evidence_for",
        label: "Foundation verification",
      },
      chatgpt,
    );
    assert.equal(service.getArtifact(artifact.id).locator, "logs/foundation.txt");
    assert.deepEqual(service.listTaskArtifacts(task.id).map((item) => item.id), [artifact.id]);
    assert.deepEqual(service.listTaskRelations(task.id).map((item) => item.id), [relation.id]);
    assert.deepEqual(service.listProjectArtifacts(project.id).map((item) => item.id), [artifact.id]);
    assert.deepEqual(service.listProjectRelations(project.id).map((item) => item.id), [relation.id]);
    const taskPosition = service.setBoardPosition(
      project.id,
      { entityType: "task", entityId: task.id, x: 240, y: 180 },
      chatgpt,
    );
    const artifactPosition = service.setBoardPosition(
      project.id,
      { entityType: "artifact", entityId: artifact.id, x: 620.5, y: 320.25 },
      chatgpt,
    );
    assert.equal(taskPosition.x, 240);
    assert.equal(artifactPosition.y, 320.25);
    assert.deepEqual(
      service.listBoardPositions(project.id).map((item) => `${item.entityType}:${item.entityId}`),
      [`artifact:${artifact.id}`, `task:${task.id}`],
    );
    assert.equal(service.getTask(task.id).revision, 2);

    const loginNode = service.createInvestigationNode(
      { projectId: project.id, title: "Login flow", description: "Authentication to session creation" },
      human,
    );
    const tokenItem = service.createInvestigationItem(
      { nodeId: loginNode.id, title: "Validate token", description: "JWT, expiry, and refresh" },
      human,
    );
    const reorderedTokenItem = service.updateInvestigationItem(tokenItem.id, { sortOrder: 3 }, human);
    const fallbackItem = service.createInvestigationItem({ nodeId: loginNode.id, title: "Fallback path" }, human);
    assert.equal(reorderedTokenItem.sortOrder, 3);
    assert.equal(fallbackItem.sortOrder, 4);
    const sessionNode = service.createInvestigationNode({ projectId: project.id, title: "Session creation" }, human);
    const taskLink = service.linkTaskToInvestigationItem(tokenItem.id, task.id, human);
    const duplicateTaskLink = service.linkTaskToInvestigationItem(tokenItem.id, task.id, human);
    assert.deepEqual(duplicateTaskLink, taskLink);
    const flowLink = service.createInvestigationItemLink(
      { fromItemId: tokenItem.id, toNodeId: sessionNode.id, label: "valid" },
      human,
    );
    service.setBoardPosition(project.id, { entityType: "investigation_node", entityId: loginNode.id, x: 80, y: 90 }, human);
    const graph = service.getInvestigationGraph(project.id);
    assert.deepEqual(graph.nodes.map((node) => node.id), [loginNode.id, sessionNode.id]);
    assert.deepEqual(graph.items.map((item) => item.id), [tokenItem.id, fallbackItem.id]);
    assert.equal(graph.itemTaskLinks.length, 1);
    assert.equal(graph.itemTaskLinks[0]?.taskId, taskLink.taskId);
    assert.equal(graph.itemLinks[0]?.id, flowLink.id);
    const activityTypes = service.listTaskActivity(task.id).map((activity) => activity.type);
    assert.deepEqual(activityTypes, [
      "task_created",
      "status_changed",
      "task_claimed",
      "task_released",
      "note_added",
      "artifact_attached",
      "relation_added",
    ]);

    repository.close();

    const reopenedRepository = new SqliteQuestBoardRepository(databasePath);
    const reopenedService = new QuestBoardService(reopenedRepository);
    const persisted = reopenedService.getTask(task.id);
    assert.equal(persisted.status, "in_progress");
    assert.equal(persisted.goal, "Ship the smallest persistence foundation");
    assert.equal(persisted.now, "Foundation persistence path verified");
    assert.equal(persisted.next, "Attach verification evidence");
    assert.equal(persisted.guardrail, "Keep Activity append-only");
    assert.equal(persisted.revision, 2);
    assert.equal(reopenedService.listTaskActivity(task.id).length, 7);
    assert.equal(reopenedService.listTaskArtifacts(task.id)[0]?.id, artifact.id);
    assert.equal(reopenedService.listTaskRelations(task.id)[0]?.kind, "evidence_for");
    assert.equal(reopenedService.listBoardPositions(project.id).length, 3);
    const reopenedGraph = reopenedService.getInvestigationGraph(project.id);
    assert.equal(reopenedGraph.nodes.length, 2);
    assert.equal(reopenedGraph.items[0]?.description, "JWT, expiry, and refresh");
    assert.equal(reopenedGraph.itemTaskLinks[0]?.taskId, task.id);
    assert.equal(reopenedGraph.itemLinks[0]?.toNodeId, sessionNode.id);
    assert.equal(reopenedService.getTask(task.id).revision, 2);
    reopenedRepository.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migrates legacy Tasks into the minimal continuity contract without inventing duplicate state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "questboard-legacy-continuity-"));
  const databasePath = join(directory, "questboard.sqlite");

  try {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        root_path TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
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
      INSERT INTO projects (id, name, description, status, created_at, updated_at)
      VALUES ('legacy-project', 'Legacy project', '', 'active', '2026-09-26T00:00:00.000Z', '2026-09-26T00:00:00.000Z');
      INSERT INTO tasks (
        id, project_id, title, description, status, priority, tags_json,
        created_by, created_at, updated_at, revision
      ) VALUES (
        'legacy-task', 'legacy-project', 'Resume legacy work', 'Preserve existing task meaning',
        'ready', 'normal', '[]', 'human:owner',
        '2026-09-26T00:00:00.000Z', '2026-09-26T00:00:00.000Z', 1
      );
    `);
    legacy.close();

    const repository = new SqliteQuestBoardRepository(databasePath);
    const service = new QuestBoardService(repository);
    const migrated = service.getTask("legacy-task");
    assert.equal(migrated.goal, "Preserve existing task meaning");
    assert.equal(migrated.now, "Task status: ready");
    assert.equal(migrated.next, "Next action has not been recorded yet.");
    assert.equal(Object.hasOwn(migrated, "state"), false);
    assert.equal(Object.hasOwn(migrated, "blocked"), false);
    assert.deepEqual(service.resumeTask("legacy-task"), {
      taskId: "legacy-task",
      projectId: "legacy-project",
      status: "ready",
      goal: "Preserve existing task meaning",
      now: "Task status: ready",
      next: "Next action has not been recorded yet.",
    });

    service.checkpointTask("legacy-task", {
      now: "Legacy migration verified",
      next: "Use the continuity contract from the next session",
    }, chatgpt);
    repository.close();

    const reopenedRepository = new SqliteQuestBoardRepository(databasePath);
    const persisted = new QuestBoardService(reopenedRepository).getTask("legacy-task");
    assert.equal(persisted.goal, "Preserve existing task meaning");
    assert.equal(persisted.now, "Legacy migration verified");
    assert.equal(persisted.next, "Use the continuity contract from the next session");
    reopenedRepository.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("builds a bounded Resume Capsule from normalized Task state without expanding history or graphs", () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  try {
    const project = service.createProject({ name: "Resume read" }, human);
    const task = service.createTask({
      projectId: project.id,
      title: "Resume only what matters",
      goal: "Return enough state for the next worker to act",
      now: "The canonical continuity state is persisted",
      next: "Read one Resume Capsule",
      status: "blocked",
      blocked: "Waiting for the read boundary",
      guardrail: "Do not reconstruct current state from history",
    }, human);
    const artifact = service.createArtifact({
      taskId: task.id,
      type: "log",
      title: "Detailed evidence",
      locator: "logs/resume-evidence.log",
      description: "This detail must stay behind drill-down",
    }, human);
    service.createRelation({
      fromType: "task",
      fromId: task.id,
      toType: "artifact",
      toId: artifact.id,
      kind: "evidence_for",
    }, human);
    const node = service.createInvestigationNode({ projectId: project.id, title: "Detailed flow" }, human);
    const item = service.createInvestigationItem({ nodeId: node.id, title: "Detailed checkpoint" }, human);
    service.linkTaskToInvestigationItem(item.id, task.id, human);

    repository.listTaskActivity = () => { throw new Error("Resume must not read Activity history"); };
    repository.listTaskArtifacts = () => { throw new Error("Resume must not expand Artifacts"); };
    repository.listTaskRelations = () => { throw new Error("Resume must not expand Relations"); };
    repository.listInvestigationNodes = () => { throw new Error("Resume must not read Investigation graph"); };
    repository.listInvestigationItems = () => { throw new Error("Resume must not read Investigation graph"); };
    repository.listInvestigationItemLinks = () => { throw new Error("Resume must not read Investigation graph"); };
    repository.listInvestigationItemTaskLinks = () => { throw new Error("Resume must not read Investigation graph"); };
    repository.listBoardPositions = () => { throw new Error("Resume must not read board state"); };

    assert.deepEqual(service.resumeTask(task.id), {
      taskId: task.id,
      projectId: project.id,
      status: "blocked",
      goal: "Return enough state for the next worker to act",
      now: "The canonical continuity state is persisted",
      next: "Read one Resume Capsule",
      blocked: "Waiting for the read boundary",
      guardrail: "Do not reconstruct current state from history",
    });

    const leanTask = service.createTask({
      projectId: project.id,
      title: "Lean resume",
      goal: "Keep optional metadata absent",
      now: "Ready for a small read",
      next: "Continue",
      status: "ready",
    }, human);
    const leanResume = service.resumeTask(leanTask.id);
    assert.equal(Object.hasOwn(leanResume, "blocked"), false);
    assert.equal(Object.hasOwn(leanResume, "guardrail"), false);
    assert.equal(Object.hasOwn(leanResume, "activity"), false);
    assert.equal(Object.hasOwn(leanResume, "artifacts"), false);
    assert.equal(Object.hasOwn(leanResume, "relations"), false);
    assert.equal(Object.hasOwn(leanResume, "investigation"), false);
    assert.equal(Object.hasOwn(leanResume, "codeMap"), false);
    assert.equal(Object.hasOwn(leanResume, "state"), false);
    assert.equal(Object.hasOwn(leanResume, "currentFocus"), false);
    assert.equal(Object.hasOwn(leanResume, "decision"), false);
  } finally {
    repository.close();
  }
});

test("checkpoint atomically updates minimal continuity with explicit clear and existing idempotency semantics", () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  try {
    const project = service.createProject({ name: "Checkpoint" }, human);
    const task = service.createTask({
      projectId: project.id,
      title: "Leave a resumable checkpoint",
      goal: "Resume the same work with minimal state",
      now: "Checkpoint contract is being defined",
      next: "Verify preserve, set, and clear semantics",
      status: "blocked",
      blocked: "Waiting for checkpoint semantics",
      guardrail: "Do not add a second workflow state",
    }, human);

    const preserved = service.checkpointTask(task.id, {
      now: "Checkpoint service path exists",
      next: "Set optional continuity explicitly",
    }, chatgpt);
    assert.equal(preserved.blocked, "Waiting for checkpoint semantics");
    assert.equal(preserved.guardrail, "Do not add a second workflow state");
    assert.equal(service.getTask(task.id).revision, 2);
    assert.equal(service.listTaskActivity(task.id).length, 1);

    const set = service.checkpointTask(task.id, {
      now: "Optional continuity is being verified",
      next: "Clear optional continuity explicitly",
      blocked: "A narrower blocker",
      guardrail: "Reuse continuity_json and Activity",
      activity: { type: "note_added", summary: "Checkpoint contract verified through set semantics" },
    }, chatgpt);
    assert.equal(set.blocked, "A narrower blocker");
    assert.equal(set.guardrail, "Reuse continuity_json and Activity");
    assert.equal(service.getTask(task.id).revision, 3);
    assert.equal(service.listTaskActivity(task.id).length, 2);
    assert.equal(service.listTaskActivity(task.id).at(-1)?.type, "note_added");

    const cleared = service.checkpointTask(task.id, {
      now: "Optional continuity can be removed explicitly",
      next: "Verify retry and rollback behavior",
      blocked: null,
      guardrail: null,
      activity: { type: "agent_handoff", summary: "Optional checkpoint fields cleared for the next worker" },
    }, chatgpt);
    assert.equal(Object.hasOwn(cleared, "blocked"), false);
    assert.equal(Object.hasOwn(cleared, "guardrail"), false);
    assert.deepEqual(cleared, service.resumeTask(task.id));
    assert.equal(service.getTask(task.id).revision, 4);
    assert.equal(service.listTaskActivity(task.id).length, 3);
    assert.equal(service.listTaskActivity(task.id).at(-1)?.type, "agent_handoff");
    assert.equal(service.getTaskClaim(task.id), undefined);

    assert.throws(
      () => service.checkpointTask(task.id, {
        now: "Blank clear must fail",
        next: "Keep explicit null as the only clear signal",
        guardrail: "   ",
      }, chatgpt),
      /Task guardrail must not be empty/,
    );
    assert.equal(service.getTask(task.id).revision, 4);
    assert.equal(service.listTaskActivity(task.id).length, 3);

    const idempotentInput = {
      now: "Idempotent checkpoint applied",
      next: "Prove exact retry does not duplicate state",
      activity: { type: "note_added" as const, summary: "One meaningful checkpoint" },
    };
    const first = service.checkpointTask(task.id, idempotentInput, chatgpt, { requestId: "test:checkpoint:0001" });
    const replayed = service.checkpointTask(task.id, idempotentInput, chatgpt, { requestId: "test:checkpoint:0001" });
    assert.deepEqual(replayed, first);
    assert.equal(service.getTask(task.id).revision, 5);
    assert.equal(service.listTaskActivity(task.id).length, 4);
    assert.throws(
      () => service.checkpointTask(task.id, { ...idempotentInput, next: "Different input" }, chatgpt, { requestId: "test:checkpoint:0001" }),
      MutationRequestConflictError,
    );

    const beforeAtomic = service.resumeTask(task.id);
    const beforeRevision = service.getTask(task.id).revision;
    const beforeActivityCount = service.listTaskActivity(task.id).length;
    const originalUpdateTask = repository.updateTask.bind(repository);
    repository.updateTask = (updatedTask, activity, expectedRevision) => {
      originalUpdateTask(updatedTask, activity, expectedRevision);
      throw new Error("checkpoint tail failed");
    };
    assert.throws(
      () => service.checkpointTask(task.id, {
        now: "This write must roll back",
        next: "This Activity must roll back too",
        activity: { type: "note_added", summary: "Must not survive rollback" },
      }, chatgpt, { requestId: "test:checkpoint:atomic" }),
      /checkpoint tail failed/,
    );
    repository.updateTask = originalUpdateTask;
    assert.deepEqual(service.resumeTask(task.id), beforeAtomic);
    assert.equal(service.getTask(task.id).revision, beforeRevision);
    assert.equal(service.listTaskActivity(task.id).length, beforeActivityCount);

    const recovered = service.checkpointTask(task.id, {
      now: "This write must roll back",
      next: "This Activity must roll back too",
      activity: { type: "note_added", summary: "Must not survive rollback" },
    }, chatgpt, { requestId: "test:checkpoint:atomic" });
    assert.deepEqual(recovered, service.resumeTask(task.id));
    assert.equal(service.getTask(task.id).revision, beforeRevision + 1);
    assert.equal(service.listTaskActivity(task.id).length, beforeActivityCount + 1);
  } finally {
    repository.close();
  }
});

test("keeps continuity state minimal while reusing Task status and Activity history", () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  try {
    const project = service.createProject({ name: "Continuity" }, human);
    const task = service.createTask({
      projectId: project.id,
      title: "Resume a worker",
      goal: "Let the next worker resume without rereading history",
      now: "Current-state storage is being defined",
      next: "Verify persistence and adapter contracts",
      status: "in_progress",
    }, human);

    assert.deepEqual(
      { goal: task.goal, now: task.now, next: task.next },
      {
        goal: "Let the next worker resume without rereading history",
        now: "Current-state storage is being defined",
        next: "Verify persistence and adapter contracts",
      },
    );
    assert.equal(Object.hasOwn(task, "state"), false);
    assert.equal(Object.hasOwn(task, "blocked"), false);
    assert.equal(Object.hasOwn(task, "guardrail"), false);

    const blocked = service.updateTask(task.id, {
      status: "blocked",
      now: "Adapter verification is waiting on a fixture",
      next: "Repair the fixture and rerun the adapter contract",
      blocked: "Fixture is missing",
      guardrail: "Do not reconstruct state from full Activity history",
    }, chatgpt);
    assert.equal(blocked.blocked, "Fixture is missing");
    assert.equal(blocked.guardrail, "Do not reconstruct state from full Activity history");
    assert.equal(service.listTaskActivity(task.id).length, 2);

    const resumed = service.updateTask(task.id, { status: "in_progress", now: "Fixture repaired" }, chatgpt);
    assert.equal(Object.hasOwn(resumed, "blocked"), false);
    assert.equal(resumed.guardrail, "Do not reconstruct state from full Activity history");
    assert.equal(service.listTaskActivity(task.id).length, 3);
  } finally {
    repository.close();
  }
});

test("Investigation Task links keep stable ordering across unlink and relink", () => {
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  try {
    const project = service.createProject({ name: "Investigation ordering" }, human);
    const node = service.createInvestigationNode({ projectId: project.id, title: "Flow" }, human);
    const item = service.createInvestigationItem({ nodeId: node.id, title: "Step" }, human);
    const first = service.createTask({ projectId: project.id, title: "First" }, human);
    const second = service.createTask({ projectId: project.id, title: "Second" }, human);

    const firstLink = service.linkTaskToInvestigationItem(item.id, first.id, human);
    const secondLink = service.linkTaskToInvestigationItem(item.id, second.id, human);
    assert.equal(firstLink.sortOrder, 0);
    assert.equal(secondLink.sortOrder, 1);

    service.unlinkTaskFromInvestigationItem(item.id, first.id, human);
    const relinked = service.linkTaskToInvestigationItem(item.id, first.id, human);
    assert.equal(relinked.sortOrder, 2);
    assert.deepEqual(service.linkTaskToInvestigationItem(item.id, first.id, human), relinked);
    assert.deepEqual(
      service.getInvestigationGraph(project.id).itemTaskLinks.map((link) => [link.taskId, link.sortOrder]),
      [[second.id, 1], [first.id, 2]],
    );
  } finally {
    repository.close();
  }
});

test("hides concurrency plumbing while preserving idempotency and stale-claim safety", () => {
  const repository = new SqliteQuestBoardRepository();
  const diagnostics: ConcurrencyDiagnosticEvent[] = [];
  const service = new QuestBoardService(repository, undefined, undefined, (event) => diagnostics.push(event));
  try {
    const project = service.createProject({ name: "Invisible concurrency" }, human);
    const task = service.createTask({ projectId: project.id, title: "Update without a lock token", status: "ready" }, human);

    const requestId = "test:update:0001";
    const updated = service.updateTask(task.id, { status: "in_progress" }, chatgpt, { requestId });
    assert.equal(updated.revision, 2);
    const replayed = service.updateTask(task.id, { status: "in_progress" }, chatgpt, { requestId });
    assert.equal(replayed.revision, 2);
    assert.equal(service.listTaskActivity(task.id).length, 2);
    assert.throws(
      () => service.updateTask(task.id, { status: "review" }, chatgpt, { requestId }),
      MutationRequestConflictError,
    );

    const firstClaim = service.claimTask(task.id, chatgpt, { requestId: "test:claim:0001" });
    service.releaseTask(task.id, chatgpt, { claimId: firstClaim.id, requestId: "test:release:0001" });
    const secondClaim = service.claimTask(task.id, chatgpt, { requestId: "test:claim:0002" });
    assert.notEqual(secondClaim.id, firstClaim.id);
    assert.throws(
      () => service.releaseTask(task.id, chatgpt, { claimId: firstClaim.id, requestId: "test:release:stale" }),
      ClaimGenerationConflictError,
    );
    assert.equal(service.getTaskClaim(task.id)?.id, secondClaim.id);

    const events = diagnostics.map((event) => event.event);
    assert.ok(events.includes("mutation.replayed"));
    assert.ok(events.includes("mutation.request.conflict"));
    assert.ok(events.includes("claim.release.stale"));
    assert.ok(events.includes("task.update.applied"));
  } finally {
    repository.close();
  }
});