import type { ActorRef } from "../../core/domain.js";
import { QuestBoardDaemonClient, resolveQuestBoardDaemonUrl } from "../daemon-client.js";
import { runQuestBoardCli } from "./cli.js";

const defaultActor: ActorRef = {
  id: process.env.QUESTBOARD_ACTOR_ID?.trim() || "cli:local",
  provider: process.env.QUESTBOARD_ACTOR_PROVIDER?.trim() || "cli",
};
const daemonUrl = resolveQuestBoardDaemonUrl();
const client = new QuestBoardDaemonClient(daemonUrl);

try {
  await client.assertHealthy();
  process.exitCode = await runQuestBoardCli(
    (name, input) => client.callAgentTool(name, input),
    process.argv.slice(2),
    { defaultActor },
  );
} catch (error) {
  const message = error instanceof Error ? error.message : "QuestBoard daemon connection failed";
  process.stderr.write(`${JSON.stringify({ error: { code: "daemon_unavailable", message } }, null, 2)}\n`);
  process.exitCode = 1;
}