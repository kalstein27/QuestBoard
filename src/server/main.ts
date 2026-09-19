import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { QuestBoardService } from "../application/quest-board-service.js";
import { createStderrConcurrencyDiagnosticSink } from "../observability/concurrency-log.js";
import { SqliteQuestBoardRepository } from "../storage/sqlite/sqlite-quest-board-repository.js";
import { startQuestBoardHttpRuntime } from "./runtime.js";

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
  log: (message) => console.log(message),
});

let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  void httpRuntime.close().finally(() => repository.close());
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);