import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
        status: "ready",
        priority: "high",
        tags: ["foundation", "sqlite", "foundation"],
      },
      human,
    );

    assert.equal(service.getTask(task.id).status, "ready");
    assert.deepEqual(service.getTask(task.id).tags, ["foundation", "sqlite"]);

    const updated = service.updateTask(task.id, { status: "in_progress", expectedRevision: 1 }, chatgpt);
    assert.equal(updated.status, "in_progress");
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
    assert.equal(persisted.revision, 2);
    assert.equal(reopenedService.listTaskActivity(task.id).length, 7);
    assert.equal(reopenedService.listTaskArtifacts(task.id)[0]?.id, artifact.id);
    assert.equal(reopenedService.listTaskRelations(task.id)[0]?.kind, "evidence_for");
    assert.equal(reopenedService.listBoardPositions(project.id).length, 2);
    assert.equal(reopenedService.getTask(task.id).revision, 2);
    reopenedRepository.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
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