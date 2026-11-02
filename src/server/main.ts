import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { QuestBoardService } from "../application/quest-board-service.js";
import { CodeMapInvestigationSyncService } from "../application/code-map-investigation-sync.js";
import { SourceStructureFlowSyncService } from "../application/source-structure-flow-sync.js";
import { SourceStructureChannelError } from "../application/source-structure-channel.js";
import { CodeMapAugmentationService } from "../application/code-map-augmentation.js";
import { CodeScopeBindingService } from "../application/code-scope-binding.js";
import { AgentFocusService } from "../application/agent-focus.js";
import { createStderrConcurrencyDiagnosticSink } from "../observability/concurrency-log.js";
import { SqliteQuestBoardRepository } from "../storage/sqlite/sqlite-quest-board-repository.js";
import { createConfiguredCodeMapRuntime, withManagedServiceCodeMapDefault } from "./code-map-config.js";
import { pinQuestBoardDaemonIdentity, QUESTBOARD_DAEMON_PROTOCOL } from "./daemon-identity.js";
import { createIsolatedCodeMapReadExecutor } from "./code-map-isolated-read.js";
import { createIsolatedCodeMapRefreshExecutor } from "./code-map-isolated-refresh.js";
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
const daemonGenerationId = randomUUID();
const service = new QuestBoardService(repository, undefined, undefined, createStderrConcurrencyDiagnosticSink());
service.setDiagnosticContext({ daemonGenerationId, databaseId: repository.databaseId });
const codeMapEnv = withManagedServiceCodeMapDefault(process.env, managedServiceMode);
const codeMapRuntime = createConfiguredCodeMapRuntime(codeMapEnv, repository);
// Heavy background refreshes run in a disposable process. Keep direct service
// APIs unchanged and allow an explicit opt-out during phased rollout.
if (codeMapRuntime.service && codeMapEnv.QUESTBOARD_CODE_MAP_ISOLATED_REFRESH !== "0") {
  codeMapRuntime.service.setIsolatedRefreshExecutor(
    createIsolatedCodeMapRefreshExecutor(codeMapEnv),
  );
}
if (codeMapRuntime.service && codeMapEnv.QUESTBOARD_CODE_MAP_ISOLATED_READ !== "0") {
  // Bounded reads and server-owned P2 mutation preflights use disposable
  // workers. Flow Apply still commits synchronously in SQLite, with an exact
  // persisted-snapshot revision fence before and after transactional writes.
  codeMapRuntime.service.setIsolatedReadExecutor(
    createIsolatedCodeMapReadExecutor(codeMapEnv),
  );
}
const codeMapInvestigationSyncService = codeMapRuntime.service
  ? new CodeMapInvestigationSyncService(codeMapRuntime.service, repository)
  : undefined;
const sourceStructureFlowSyncService = codeMapRuntime.service
  ? new SourceStructureFlowSyncService(repository, {
      read(projectId) {
        const cached = codeMapRuntime.service!.getCached(projectId);
        const snapshotId = codeMapRuntime.service!.snapshotIdentity(projectId)?.snapshotId;
        if (!cached || !snapshotId) {
          throw new SourceStructureChannelError("source_structure_not_indexed",
            "An exact trusted Code Map snapshot is required for Source Structure sync");
        }
        return { graph: cached.graph, snapshotId };
      },
    })
  : undefined;
const codeMapAugmentationService = codeMapRuntime.service
  ? new CodeMapAugmentationService(codeMapRuntime.service, repository)
  : undefined;
const codeScopeBindingService = codeMapRuntime.service
  ? new CodeScopeBindingService(codeMapRuntime.service, repository, service)
  : undefined;
const agentFocusService = new AgentFocusService(
  repository,
  undefined,
  undefined,
  codeMapRuntime.service
    ? (projectId, codeNodeId) => {
        try {
          codeMapRuntime.service!.query(projectId, { operation: "get_node", nodeId: codeNodeId, limit: 1 });
          return true;
        } catch {
          return false;
        }
      }
    : undefined,
);
const tailnetMode = process.argv.includes("--tailnet") || process.env.QUESTBOARD_TAILNET === "1";
const httpRuntime = await startQuestBoardHttpRuntime(service, {
  tailnetMode,
  daemonIdentity,
  ...(codeMapRuntime.service ? { codeMapService: codeMapRuntime.service } : {}),
  ...(codeMapInvestigationSyncService ? { codeMapInvestigationSyncService } : {}),
  ...(sourceStructureFlowSyncService ? { sourceStructureFlowSyncService } : {}),
  ...(codeMapAugmentationService ? { codeMapAugmentationService } : {}),
  ...(codeScopeBindingService ? { codeScopeBindingService } : {}),
  agentFocusService,
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