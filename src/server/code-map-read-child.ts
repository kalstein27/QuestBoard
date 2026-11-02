import { isAbsolute, resolve } from "node:path";
import { realpathSync } from "node:fs";
import type { CodeIndexRequest } from "../application/code-intelligence.js";
import type {
  CodeMapIsolatedReadOperation,
  CodeMapIsolatedReadRequest,
} from "../application/code-map-service.js";
import type { CodeMapManualRelationReader } from "../application/code-map-augmentation.js";
import type { QuestBoardRepository } from "../application/quest-board-repository.js";
import { CodeMapQueryError } from "../application/code-map-query.js";
import { SourceStructureSelectionError, deriveSourceStructureSyncGraph } from "../application/source-structure-sync-graph.js";
import { resolveSourceStructureSelection, type SourceStructureChannelSelection } from "../application/source-structure-channel.js";
import type { CodeMapSourceTreeRequest } from "../application/code-map-web-read.js";
import { analyzeCodeScopeBinding, type TaskCodeScopeBinding } from "../application/code-scope-binding.js";
import { createConfiguredCodeMapRuntime } from "./code-map-config.js";

/** Disposable read worker: only a pinned snapshot is loaded, never operational SQLite. */
type Start = { type: "read"; request: CodeMapIsolatedReadRequest };
type Reply =
  | { type: "complete"; operation: CodeMapIsolatedReadOperation; value: unknown; childMaxRssMiB: number }
  | { type: "failed"; code: string; message: string };

const MAX_RESULT_BYTES = 1024 * 1024;
const OPERATIONS = new Set<CodeMapIsolatedReadOperation>([
  "query", "continuations", "subsystems", "subsystem_read", "status",
  "source_structure_preview", "web_bootstrap", "source_tree",
  "investigation_preview", "source_structure_apply", "code_scope_relink",
]);
let started = false;

function finish(message: Reply): void {
  if (!process.send) {
    process.exitCode = 1;
    return;
  }
  let serialized: string;
  try { serialized = JSON.stringify(message); } catch { serialized = ""; }
  if (!serialized || Buffer.byteLength(serialized) > MAX_RESULT_BYTES) {
    const failed: Reply = {
      type: "failed", code: "code_map_query_too_large",
      message: "Code Map read exceeded the bounded response size",
    };
    process.send(failed, () => {
      process.disconnect();
      process.exitCode = 1;
    });
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
    if (!data || typeof data !== "object" || (data as Start).type !== "read")
      throw new TypeError("Invalid isolated Code Map read request");
    const request = (data as Start).request;
    if (!request || typeof request.projectId !== "string"
      || request.projectId.length < 1 || request.projectId.length > 120
      || typeof request.rootPath !== "string" || !isAbsolute(request.rootPath)
      || !OPERATIONS.has(request.operation)
      || !Array.isArray(request.manualRelations)) {
      throw new TypeError("Invalid isolated Code Map project/read identity");
    }
    const root = realpathSync.native(request.rootPath);
    if (root !== resolve(request.rootPath))
      throw new TypeError("Isolated Code Map root must be canonical");
    const trustedRoot = request.rootPath;
    const projectId = request.projectId;
    const manualRelations = request.manualRelations;
    const projectReader = {
      getProject: (id: string) => id === projectId ? { id, rootPath: trustedRoot } : undefined,
      listCodeMapManualRelations: (id: string) => id === projectId ? manualRelations : [],
    } as unknown as CodeMapManualRelationReader & Pick<QuestBoardRepository, "getProject">;
    const runtime = createConfiguredCodeMapRuntime(process.env, projectReader);
    const service = runtime.service;
    if (!service) throw new CodeMapQueryError("code_map_not_indexed", "Code Map runtime is disabled");
    let value: unknown;
    switch (request.operation) {
      case "query":
        value = service.query(projectId, request.input as Parameters<typeof service.query>[1]);
        break;
      case "continuations":
        value = service.queryContinuations(projectId, request.input as Parameters<typeof service.queryContinuations>[1]);
        break;
      case "subsystems":
        value = service.querySourceSubsystems(projectId, request.input as Parameters<typeof service.querySourceSubsystems>[1]);
        break;
      case "subsystem_read":
        value = service.sourceSubsystems(projectId);
        break;
      case "status":
        value = await service.snapshotReadSummary(projectId);
        break;
      case "web_bootstrap":
        value = await service.webBootstrap(projectId);
        break;
      case "source_tree":
        value = service.sourceTreePage(projectId, request.input as CodeMapSourceTreeRequest);
        break;
      case "code_scope_relink": {
        const binding = request.input as TaskCodeScopeBinding;
        if (!binding || binding.projectId !== projectId || typeof binding.id !== "string"
          || typeof binding.codeCanonicalIdentity !== "string") {
          throw new TypeError("Untrusted CodeScope binding identity");
        }
        const cached = service.getCached(projectId);
        const snapshotId = service.snapshotIdentity(projectId)?.snapshotId;
        if (!cached || !snapshotId) {
          throw new CodeMapQueryError("code_map_not_indexed",
            "Trusted Code Map snapshot is unavailable");
        }
        value = { snapshotId, analysis: analyzeCodeScopeBinding(binding, cached.graph) };
        break;
      }
      case "investigation_preview":
        if (!Array.isArray(request.input)
          || request.input.some((item) => typeof item !== "string" || item.length > 512)) {
          throw new TypeError("Invalid bounded Investigation preview IDs");
        }
        value = service.investigationPreviewSource(projectId, request.input as string[]);
        break;
      case "source_structure_preview": {
        const selection = request.input as SourceStructureChannelSelection;
        if (!selection || selection.projectId !== projectId) {
          throw new TypeError("Source Structure preview project identity mismatch");
        }
        const pinned = resolveSourceStructureSelection(service, selection);
        const cached = service.getCached(projectId);
        const snapshotId = service.snapshotIdentity(projectId)?.snapshotId;
        if (!cached || !snapshotId) {
          throw new CodeMapQueryError("code_map_not_indexed", "Trusted Code Map snapshot is unavailable");
        }
        value = deriveSourceStructureSyncGraph(cached.graph, pinned, snapshotId);
        break;
      }
      case "source_structure_apply": {
        const selection = request.input as SourceStructureChannelSelection;
        if (!selection || selection.projectId !== projectId) {
          throw new TypeError("Source Structure apply project identity mismatch");
        }
        const pinned = resolveSourceStructureSelection(service, selection);
        const cached = service.getCached(projectId);
        const snapshotId = service.snapshotIdentity(projectId)?.snapshotId;
        if (!cached || !snapshotId) {
          throw new CodeMapQueryError("code_map_not_indexed", "Trusted Code Map snapshot is unavailable");
        }
        value = {
          selection: pinned,
          graph: deriveSourceStructureSyncGraph(cached.graph, pinned, snapshotId),
        };
        break;
      }
    }
    finish({
      type: "complete", operation: request.operation, value,
      childMaxRssMiB: +(process.resourceUsage().maxRSS / 1024).toFixed(1),
    });
  })().catch((error: unknown) => {
    const known = error instanceof CodeMapQueryError || error instanceof SourceStructureSelectionError;
    finish({
      type: "failed",
      code: known ? error.code : "code_map_read_failed",
      message: known ? error.message.slice(0, 256) : "Isolated Code Map read failed",
    });
  });
});
