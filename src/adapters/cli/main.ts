import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ActorRef } from "../../core/domain.js";
import { QuestBoardService } from "../../application/quest-board-service.js";
import { createStderrConcurrencyDiagnosticSink } from "../../observability/concurrency-log.js";
import { SqliteQuestBoardRepository } from "../../storage/sqlite/sqlite-quest-board-repository.js";
import { runQuestBoardCli } from "./cli.js";

const configuredDatabasePath = process.env.QUESTBOARD_DB_PATH;
const databasePath = configuredDatabasePath
  ? resolve(configuredDatabasePath)
  : resolve(".questboard/questboard.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });

const repository = new SqliteQuestBoardRepository(databasePath);
const service = new QuestBoardService(repository, undefined, undefined, createStderrConcurrencyDiagnosticSink());
const defaultActor: ActorRef = {
  id: process.env.QUESTBOARD_ACTOR_ID?.trim() || "cli:local",
  provider: process.env.QUESTBOARD_ACTOR_PROVIDER?.trim() || "cli",
};

try {
  process.exitCode = runQuestBoardCli(service, process.argv.slice(2), { defaultActor });
} finally {
  repository.close();
}
