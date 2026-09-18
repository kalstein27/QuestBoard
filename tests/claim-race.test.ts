import assert from "node:assert/strict";
import test from "node:test";
import { runClaimRaceScenario } from "../src/testing/claim-race.js";

test("two independent workers preserve strict CAS and support lockless Task updates", async () => {
  const report = await runClaimRaceScenario();

  assert.equal(report.firstRound.filter((result) => result.ok).length, 1);
  assert.equal(report.firstRound.filter((result) => result.errorCode === "claim_conflict").length, 1);
  assert.equal(report.finalClaimAgentId, report.loserActorId);
  assert.equal(report.updateRound.filter((result) => result.ok).length, 1);
  assert.equal(report.updateRound.filter((result) => result.errorCode === "revision_conflict").length, 1);
  assert.equal(report.finalUpdateRevision, 2);
  assert.ok(report.finalUpdateStatus === "in_progress" || report.finalUpdateStatus === "review");
  assert.equal(report.locklessUpdateRound.filter((result) => result.ok).length, 2);
  assert.equal(report.finalLocklessRevision, 3);
  assert.ok(report.finalLocklessStatus === "in_progress" || report.finalLocklessStatus === "review");
  assert.deepEqual(report.activityTypes, [
    "task_created",
    "task_claimed",
    "agent_handoff",
    "task_released",
    "task_claimed",
  ]);
});
