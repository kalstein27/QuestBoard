import { isAbsolute, resolve } from "node:path";
import { realpathSync } from "node:fs";
import type { CodeIndexRequest } from "../application/code-intelligence.js";
import type { CodeMapIsolatedRefreshReceipt } from "../application/code-map-service.js";
import type { CodeMapManualRelationReader } from "../application/code-map-augmentation.js";
import type { QuestBoardRepository } from "../application/quest-board-repository.js";
import { createConfiguredCodeMapRuntime } from "./code-map-config.js";

/**
 * Dedicated, single-use Code Map index process.
 * No operational SQLite handle, network server, or Flow write APIs are created.
 * The full graph never crosses IPC. The normal persistence store atomically
 * publishes the final snapshot outside of the checked-out repository.
 */
type Start = { type: "start"; request: CodeIndexRequest };
type Finish =
  | { type: "complete"; receipt: CodeMapIsolatedRefreshReceipt; childMaxRssMiB: number }
  | { type: "failed"; code: "index_failed" };

let started = false;
function finish(message: Finish): void {
  if (!process.send) {
    process.exitCode = 1;
    return;
  }
  process.send(message, () => {
    process.disconnect();
    if (message.type === "failed") process.exitCode = 1;
  });
}

process.once("message", (data: unknown) => {
  if (started) return;
  started = true;
  void (async () => {
    if (!data || typeof data !== "object" || (data as Start).type !== "start") {
      throw new Error("Invalid isolated Code Map start message");
    }
    const request = (data as Start).request;
    if (!request || typeof request.projectId !== "string"
      || request.projectId.length < 1 || request.projectId.length > 120
      || typeof request.rootPath !== "string" || !isAbsolute(request.rootPath)) {
      throw new Error("Invalid isolated Code Map project identity");
    }
    const canonicalRoot = realpathSync.native(request.rootPath);
    if (canonicalRoot !== resolve(request.rootPath)) {
      throw new Error("Isolated Code Map root must be canonical");
    }
    if (request.changes?.length) throw new Error("Isolated Code Map supports full refresh only");

    // Preserve previous change-count semantics without opening SQLite:
    // a repository-shaped readonly root lookup is solely used for hydration.
    const rootReader = {
      listCodeMapManualRelations: () => [],
      getProject: (id: string) =>
        id === request.projectId ? { id, rootPath: request.rootPath } : undefined,
    } as unknown as CodeMapManualRelationReader & Pick<QuestBoardRepository, "getProject">;
    const runtime = createConfiguredCodeMapRuntime(process.env, rootReader);
    if (!runtime.service) throw new Error("Isolated Code Map runtime is not configured");
    const result = await runtime.service.refresh(request);
    const snapshotId = runtime.service.snapshotIdentity(request.projectId)?.snapshotId;
    if (!snapshotId) throw new Error("Isolated Code Map snapshot was not persisted and pinned");
    const receipt: CodeMapIsolatedRefreshReceipt = {
      projectId: request.projectId,
      indexedAt: result.graph.indexedAt,
      snapshotId,
      mode: result.mode,
      nodeCount: result.graph.nodes.length,
      relationCount: result.graph.relations.length,
      changedCodeNodeCount: result.changedCodeNodeIds.length,
      changedArchitectureNodeCount: result.changedArchitectureNodeIds.length,
    };
    finish({
      type: "complete",
      receipt,
      childMaxRssMiB: +(process.resourceUsage().maxRSS / 1024).toFixed(1),
    });
  })().catch(() => finish({ type: "failed", code: "index_failed" }));
});
