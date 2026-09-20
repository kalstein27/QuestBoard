import { QuestBoardDaemonClient, resolveQuestBoardDaemonUrl } from "../daemon-client.js";
import { runQuestBoardMcpProxyStdio } from "./mcp-proxy.js";

const daemonUrl = resolveQuestBoardDaemonUrl();
const client = new QuestBoardDaemonClient(daemonUrl);

try {
  await client.assertHealthy();
  await runQuestBoardMcpProxyStdio(client);
} catch (error) {
  const message = error instanceof Error ? error.message : "QuestBoard daemon connection failed";
  process.stderr.write(`${message}\nStart the shared QuestBoard daemon first with: npm run daemon\n`);
  process.exitCode = 1;
}