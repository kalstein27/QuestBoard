import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { executeQuestBoardAgentTool } from "../adapters/agent-tools.js";
import { QuestBoardService } from "../application/quest-board-service.js";
import type { ActorRef, TaskStatus } from "../core/domain.js";
import { SqliteQuestBoardRepository } from "../storage/sqlite/sqlite-quest-board-repository.js";

const OWNER: ActorRef = { id: "human:race-owner", provider: "race-test" };
const ACTOR_A: ActorRef = { id: "agent:race-a", provider: "race-test" };
const ACTOR_B: ActorRef = { id: "agent:race-b", provider: "race-test" };

export interface ClaimRaceWorkerInput {
  dbPath: string;
  taskId: string;
  actor: ActorRef;
  startBarrier: SharedArrayBuffer;
  operation: "claim" | "update";
  expectedRevision?: number;
  updateStatus?: TaskStatus;
}

export interface ClaimRaceWorkerResult {
  actorId: string;
  ok: boolean;
  claimAgentId?: string;
  taskRevision?: number;
  taskStatus?: TaskStatus;
  errorCode?: string;
  errorMessage?: string;
}

export interface ClaimRaceReport {
  projectId: string;
  taskId: string;
  winnerActorId: string;
  loserActorId: string;
  firstRound: ClaimRaceWorkerResult[];
  finalClaimAgentId: string;
  activityTypes: string[];
  updateTaskId: string;
  updateRound: ClaimRaceWorkerResult[];
  finalUpdateRevision: number;
  finalUpdateStatus: TaskStatus;
  locklessUpdateTaskId: string;
  locklessUpdateRound: ClaimRaceWorkerResult[];
  finalLocklessRevision: number;
  finalLocklessStatus: TaskStatus;
}

interface WorkerHandle {
  ready: Promise<void>;
  result: Promise<ClaimRaceWorkerResult>;
}

export async function runClaimRaceScenario(): Promise<ClaimRaceReport> {
  const tempDirectory = mkdtempSync(join(tmpdir(), "questboard-claim-race-"));
  const dbPath = join(tempDirectory, "race.sqlite");

  try {
    const seeded = withService(dbPath, (service) => {
      const project = service.createProject({ name: "Claim race fixture" }, OWNER);
      const task = service.createTask(
        {
          projectId: project.id,
          title: "Two agents compete for one Ready task",
          status: "ready",
          priority: "high",
          tags: ["race-test"],
        },
        OWNER,
      );
      const updateTask = service.createTask(
        {
          projectId: project.id,
          title: "Two agents update the same revision",
          status: "ready",
          priority: "normal",
          tags: ["revision-race-test"],
        },
        OWNER,
      );
      const locklessUpdateTask = service.createTask(
        {
          projectId: project.id,
          title: "Two agents update without exposing a revision token",
          status: "ready",
          priority: "normal",
          tags: ["lockless-race-test"],
        },
        OWNER,
      );
      return {
        projectId: project.id,
        taskId: task.id,
        updateTaskId: updateTask.id,
        locklessUpdateTaskId: locklessUpdateTask.id,
      };
    });

    const startBarrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const gate = new Int32Array(startBarrier);
    const workerA = startRaceWorker({
      dbPath,
      taskId: seeded.taskId,
      actor: ACTOR_A,
      startBarrier,
      operation: "claim",
    });
    const workerB = startRaceWorker({
      dbPath,
      taskId: seeded.taskId,
      actor: ACTOR_B,
      startBarrier,
      operation: "claim",
    });

    await Promise.all([workerA.ready, workerB.ready]);
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0, 2);

    const firstRound = await Promise.all([workerA.result, workerB.result]);
    const successes = firstRound.filter((result) => result.ok);
    const conflicts = firstRound.filter((result) => !result.ok && result.errorCode === "claim_conflict");
    if (successes.length !== 1 || conflicts.length !== 1) {
      throw new Error(`Claim race invariant failed: ${JSON.stringify(firstRound)}`);
    }

    const winnerActorId = successes[0]?.actorId;
    const loserActorId = conflicts[0]?.actorId;
    if (!winnerActorId || !loserActorId) throw new Error("Claim race did not identify winner and loser");
    const winner = actorById(winnerActorId);
    const loser = actorById(loserActorId);

    withService(dbPath, (service) => {
      executeQuestBoardAgentTool(service, "questboard_add_activity", {
        taskId: seeded.taskId,
        type: "agent_handoff",
        summary: `Race winner ${winner.id} handing work to ${loser.id}`,
        actor: winner,
      });
      executeQuestBoardAgentTool(service, "questboard_release_task", {
        taskId: seeded.taskId,
        actor: winner,
      });
    });

    withService(dbPath, (service) => {
      executeQuestBoardAgentTool(service, "questboard_claim_task", {
        taskId: seeded.taskId,
        actor: loser,
      });
    });

    const verification = withService(dbPath, (service) => ({
      finalClaimAgentId: service.getTaskClaim(seeded.taskId)?.agentId,
      activityTypes: service.listTaskActivity(seeded.taskId).map((activity) => activity.type),
    }));
    if (verification.finalClaimAgentId !== loser.id) {
      throw new Error(`Expected loser ${loser.id} to reclaim task, got ${verification.finalClaimAgentId ?? "none"}`);
    }

    const updateBarrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const updateGate = new Int32Array(updateBarrier);
    const updateWorkerA = startRaceWorker({
      dbPath,
      taskId: seeded.updateTaskId,
      actor: ACTOR_A,
      startBarrier: updateBarrier,
      operation: "update",
      expectedRevision: 1,
      updateStatus: "in_progress",
    });
    const updateWorkerB = startRaceWorker({
      dbPath,
      taskId: seeded.updateTaskId,
      actor: ACTOR_B,
      startBarrier: updateBarrier,
      operation: "update",
      expectedRevision: 1,
      updateStatus: "review",
    });
    await Promise.all([updateWorkerA.ready, updateWorkerB.ready]);
    Atomics.store(updateGate, 0, 1);
    Atomics.notify(updateGate, 0, 2);

    const updateRound = await Promise.all([updateWorkerA.result, updateWorkerB.result]);
    const updateSuccesses = updateRound.filter((result) => result.ok);
    const revisionConflicts = updateRound.filter(
      (result) => !result.ok && result.errorCode === "revision_conflict",
    );
    if (updateSuccesses.length !== 1 || revisionConflicts.length !== 1) {
      throw new Error(`Revision race invariant failed: ${JSON.stringify(updateRound)}`);
    }
    const finalUpdatedTask = withService(dbPath, (service) => service.getTask(seeded.updateTaskId));
    if (finalUpdatedTask.revision !== 2) {
      throw new Error(`Expected revision race to finish at revision 2, got ${finalUpdatedTask.revision}`);
    }
    if (finalUpdatedTask.status !== updateSuccesses[0]?.taskStatus) {
      throw new Error(
        `Revision race winner status ${updateSuccesses[0]?.taskStatus ?? "unknown"} did not persist`,
      );
    }

    const locklessBarrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const locklessGate = new Int32Array(locklessBarrier);
    const locklessWorkerA = startRaceWorker({
      dbPath,
      taskId: seeded.locklessUpdateTaskId,
      actor: ACTOR_A,
      startBarrier: locklessBarrier,
      operation: "update",
      updateStatus: "in_progress",
    });
    const locklessWorkerB = startRaceWorker({
      dbPath,
      taskId: seeded.locklessUpdateTaskId,
      actor: ACTOR_B,
      startBarrier: locklessBarrier,
      operation: "update",
      updateStatus: "review",
    });
    await Promise.all([locklessWorkerA.ready, locklessWorkerB.ready]);
    Atomics.store(locklessGate, 0, 1);
    Atomics.notify(locklessGate, 0, 2);

    const locklessUpdateRound = await Promise.all([locklessWorkerA.result, locklessWorkerB.result]);
    if (locklessUpdateRound.some((result) => !result.ok)) {
      throw new Error(`Lockless update race invariant failed: ${JSON.stringify(locklessUpdateRound)}`);
    }
    const finalLocklessTask = withService(dbPath, (service) => service.getTask(seeded.locklessUpdateTaskId));
    if (finalLocklessTask.revision !== 3) {
      throw new Error(`Expected lockless race to finish at revision 3, got ${finalLocklessTask.revision}`);
    }

    return {
      projectId: seeded.projectId,
      taskId: seeded.taskId,
      winnerActorId,
      loserActorId,
      firstRound,
      finalClaimAgentId: verification.finalClaimAgentId,
      activityTypes: verification.activityTypes,
      updateTaskId: seeded.updateTaskId,
      updateRound,
      finalUpdateRevision: finalUpdatedTask.revision,
      finalUpdateStatus: finalUpdatedTask.status,
      locklessUpdateTaskId: seeded.locklessUpdateTaskId,
      locklessUpdateRound,
      finalLocklessRevision: finalLocklessTask.revision,
      finalLocklessStatus: finalLocklessTask.status,
    };
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

function startRaceWorker(input: ClaimRaceWorkerInput): WorkerHandle {
  const worker = new Worker(new URL("./claim-race-worker.js", import.meta.url), { workerData: input });
  let readySettled = false;
  let resultSettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveResult!: (result: ClaimRaceWorkerResult) => void;
  let rejectResult!: (error: Error) => void;

  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<ClaimRaceWorkerResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  worker.on("message", (message: unknown) => {
    if (!isWorkerMessage(message)) return;
    if (message.type === "ready") {
      readySettled = true;
      resolveReady();
      return;
    }
    if (message.type === "result") {
      resultSettled = true;
      resolveResult(message.result);
    }
  });
  worker.once("error", (error) => {
    if (!readySettled) rejectReady(error);
    if (!resultSettled) rejectResult(error);
  });
  worker.once("exit", (code) => {
    if (code === 0 || resultSettled) return;
    const error = new Error(`Claim race worker exited with code ${code}`);
    if (!readySettled) rejectReady(error);
    rejectResult(error);
  });

  return { ready, result };
}

function isWorkerMessage(value: unknown): value is
  | { type: "ready" }
  | { type: "result"; result: ClaimRaceWorkerResult } {
  if (value === null || typeof value !== "object") return false;
  const message = value as { type?: unknown; result?: unknown };
  return message.type === "ready" || (message.type === "result" && message.result !== undefined);
}

function actorById(actorId: string): ActorRef {
  if (actorId === ACTOR_A.id) return ACTOR_A;
  if (actorId === ACTOR_B.id) return ACTOR_B;
  throw new Error(`Unknown race actor: ${actorId}`);
}

function withService<T>(dbPath: string, callback: (service: QuestBoardService) => T): T {
  const repository = new SqliteQuestBoardRepository(dbPath);
  try {
    return callback(new QuestBoardService(repository));
  } finally {
    repository.close();
  }
}
