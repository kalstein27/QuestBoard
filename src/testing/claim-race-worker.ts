import { parentPort, workerData } from "node:worker_threads";
import { describeQuestBoardError, executeQuestBoardAgentTool } from "../adapters/agent-tools.js";
import { QuestBoardService } from "../application/quest-board-service.js";
import { SqliteQuestBoardRepository } from "../storage/sqlite/sqlite-quest-board-repository.js";
import type { ClaimRaceWorkerInput, ClaimRaceWorkerResult } from "./claim-race.js";

if (!parentPort) throw new Error("Claim race worker requires a parent port");

const input = workerData as ClaimRaceWorkerInput;
const repository = new SqliteQuestBoardRepository(input.dbPath);
const service = new QuestBoardService(repository);
const gate = new Int32Array(input.startBarrier);

parentPort.postMessage({ type: "ready" });
while (Atomics.load(gate, 0) === 0) Atomics.wait(gate, 0, 0);

let result: ClaimRaceWorkerResult;
try {
  if (input.operation === "claim") {
    const claimed = executeQuestBoardAgentTool(service, "questboard_claim_task", {
      taskId: input.taskId,
      actor: input.actor,
    }) as { claim: { agentId: string } };
    result = { actorId: input.actor.id, ok: true, claimAgentId: claimed.claim.agentId };
  } else {
    const updated = executeQuestBoardAgentTool(service, "questboard_update_task", {
      taskId: input.taskId,
      expectedRevision: input.expectedRevision,
      status: input.updateStatus,
      actor: input.actor,
    }) as { task: { revision: number; status: ClaimRaceWorkerResult["taskStatus"] } };
    result = {
      actorId: input.actor.id,
      ok: true,
      taskRevision: updated.task.revision,
      ...(updated.task.status ? { taskStatus: updated.task.status } : {}),
    };
  }
} catch (error) {
  const described = describeQuestBoardError(error);
  result = {
    actorId: input.actor.id,
    ok: false,
    errorCode: described.code,
    errorMessage: described.message,
  };
} finally {
  repository.close();
}

parentPort.postMessage({ type: "result", result });
