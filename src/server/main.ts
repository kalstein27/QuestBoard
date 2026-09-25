import { mkdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { QuestBoardService } from "../application/quest-board-service.js";
import { CodeMapInvestigationSyncService } from "../application/code-map-investigation-sync.js";
import { createStderrConcurrencyDiagnosticSink } from "../observability/concurrency-log.js";
import { SqliteQuestBoardRepository } from "../storage/sqlite/sqlite-quest-board-repository.js";
import { createConfiguredCodeMapRuntime } from "./code-map-config.js";
import { pinQuestBoardDaemonIdentity, QUESTBOARD_DAEMON_PROTOCOL } from "./daemon-identity.js";
import { startQuestBoardHttpRuntime } from "./runtime.js";
import {
  parseManagedServiceHealthPort,
  resolveQuestBoardRuntimePaths,
  startManagedServiceHealthRuntime,
} from "./managed-service.js";

const managedServiceMode = process.argv.includes("--managed-service");
const runtimePaths = resolveQuestBoardRuntimePaths(process.env, process.cwd(), managedServiceMode);
const databasePath = runtimePaths.databasePath;
mkdirSync(dirname(databasePath), { recursive: true });

const repository = new SqliteQuestBoardRepository(databasePath);
const workspacePath = runtimePaths.workspacePath;
const canonicalDatabasePath = realpathSync.native(databasePath);
const daemonIdentity = pinQuestBoardDaemonIdentity({
  protocol: QUESTBOARD_DAEMON_PROTOCOL,
  databaseId: repository.databaseId,
  workspacePath,
  databasePath: canonicalDatabasePath,
});
const service = new QuestBoardService(repository, undefined, undefined, createStderrConcurrencyDiagnosticSink());
const codeMapRuntime = createConfiguredCodeMapRuntime();
const codeMapInvestigationSyncService = codeMapRuntime.service
  ? new CodeMapInvestigationSyncService(codeMapRuntime.service, repository)
  : undefined;
const tailnetMode = process.argv.includes("--tailnet") || process.env.QUESTBOARD_TAILNET === "1";
const httpRuntime = await startQuestBoardHttpRuntime(service, {
  tailnetMode,
  daemonIdentity,
  ...(codeMapRuntime.service ? { codeMapService: codeMapRuntime.service } : {}),
  ...(codeMapInvestigationSyncService ? { codeMapInvestigationSyncService } : {}),
  codeMapAvailability: codeMapRuntime.availability,
  log: (message) => console.log(message),
});
const managedHealthRuntime = managedServiceMode
  ? await startManagedServiceHealthRuntime(
      () => httpRuntime.server.listening,
      { port: parseManagedServiceHealthPort(process.env.QUESTBOARD_MANAGED_HEALTH_PORT) },
    )
  : null;
if (managedHealthRuntime) {
  console.log(`QuestBoard managed-service health listening on ${managedHealthRuntime.url}`);
}

let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  void (async () => {
    try {
      if (managedHealthRuntime) await managedHealthRuntime.close();
    } finally {
      await httpRuntime.close();
      repository.close();
    }
  })();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);