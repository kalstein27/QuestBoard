import { runClaimRaceScenario } from "./claim-race.js";

try {
  const report = await runClaimRaceScenario();
  process.stdout.write(`${JSON.stringify({ status: "ok", ...report }, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
