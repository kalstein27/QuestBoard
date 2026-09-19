import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { QuestBoardService } from "../../application/quest-board-service.js";
import { createStderrConcurrencyDiagnosticSink } from "../../observability/concurrency-log.js";
import { SqliteQuestBoardRepository } from "../../storage/sqlite/sqlite-quest-board-repository.js";
import { runQuestBoardMcpStdio } from "./mcp-server.js";
import { startQuestBoardHttpRuntime } from "../../server/runtime.js";

const configuredDatabasePath = process.env.QUESTBOARD_DB_PATH;
const databasePath = configuredDatabasePath
  ? resolve(configuredDatabasePath)
  : resolve(".questboard/questboard.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });

const repository = new SqliteQuestBoardRepository(databasePath);
const service = new QuestBoardService(repository, undefined, undefined, createStderrConcurrencyDiagnosticSink());

const tailnetMode = process.argv.includes("--tailnet") || process.env.QUESTBOARD_TAILNET === "1";
const httpRuntime = await startQuestBoardHttpRuntime(service, {
  tailnetMode,
  log: (message) => process.stderr.write(`${message}\n`),
});

try {
  await runQuestBoardMcpStdio(service);
} finally {
  await httpRuntime.close();
  repository.close();
}
