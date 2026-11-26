import { fork, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import { resolveIsolatedCodeMapHeapMiB } from "./code-map-isolated-heap.js";
import { isolatedCodeMapEnv, isolatedWorkerExit, isIsolatedWorkerHeapOom } from "./code-map-isolated-env.js";
import type { CodeIndexRequest } from "../application/code-intelligence.js";
import type {
  CodeMapIsolatedRefreshExecutor,
  CodeMapIsolatedRefreshReceipt,
} from "../application/code-map-service.js";

type ChildReply =
  | { type: "complete"; receipt: CodeMapIsolatedRefreshReceipt; childMaxRssMiB: number }
  | { type: "failed"; code: "index_failed"; message: string };

export interface IsolatedCodeMapRefreshOptions {
  timeoutMs?: number;
  maxOldSpaceMiB?: number;
  /** Observer receives only non-sensitive process metrics, never the raw graph. */
  onProcessMetrics?: (metrics: { childMaxRssMiB: number }) => void;
}

const MAX_IPC_BYTES = 4096;
const DEFAULT_TIMEOUT_MS = 240_000;
const activeChildren = new Set<ChildProcess>();
let exitHandlerInstalled = false;
export function resolveIsolatedRefreshTimeoutMs(env: NodeJS.ProcessEnv, override?: number): number {
  const raw = env.QUESTBOARD_CODE_MAP_ISOLATED_REFRESH_TIMEOUT_MS?.trim();
  const value = override ?? (raw ? Number(raw) : DEFAULT_TIMEOUT_MS);
  if (!Number.isSafeInteger(value) || value < 100 || value > 900_000 || (override === undefined && raw && !/^\d+$/.test(raw)))
    throw new RangeError("QUESTBOARD_CODE_MAP_ISOLATED_REFRESH_TIMEOUT_MS must be an integer from 100 to 900000");
  return value;
}

function isReceipt(value: unknown, request: CodeIndexRequest): value is CodeMapIsolatedRefreshReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<CodeMapIsolatedRefreshReceipt>;
  return receipt.projectId === request.projectId
    && typeof receipt.indexedAt === "string" && !Number.isNaN(Date.parse(receipt.indexedAt))
    && typeof receipt.snapshotId === "string" && receipt.snapshotId.length > 0
    && (receipt.mode === "full" || receipt.mode === "incremental" || receipt.mode === "cache-hit")
    && [receipt.nodeCount, receipt.relationCount, receipt.changedCodeNodeCount, receipt.changedArchitectureNodeCount]
      .every((value) => Number.isSafeInteger(value) && (value as number) >= 0);
}

function killOwnedProcessGroup(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  try {
    // The child owns a fresh process group. This also reaps a stuck SCIP child
    // process on POSIX; it never targets the QuestBoard daemon's process group.
    if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
  }
}

async function runOne(
  request: CodeIndexRequest,
  env: NodeJS.ProcessEnv,
  options: IsolatedCodeMapRefreshOptions,
): Promise<CodeMapIsolatedRefreshReceipt> {
  if (!isAbsolute(request.rootPath) || !request.projectId || request.changes?.length) {
    throw new Error("Isolated Code Map requires a canonical full-index project request");
  }
  const limitMs = resolveIsolatedRefreshTimeoutMs(env, options.timeoutMs);
  const heapMiB = resolveIsolatedCodeMapHeapMiB(env, "refresh", options.maxOldSpaceMiB);
  const childEnv = isolatedCodeMapEnv(env);
  // An isolated process may decode/normalize directly without a nested worker
  // copying the entire SCIP graph across another thread boundary.
  childEnv.QUESTBOARD_CODE_MAP_ISOLATED_CHILD = "1";

  return await new Promise<CodeMapIsolatedRefreshReceipt>((resolve, reject) => {
    const child = fork(new URL("./code-map-index-child.js", import.meta.url), [], {
      cwd: process.cwd(),
      env: childEnv,
      execArgv: [`--max-old-space-size=${heapMiB}`],
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    let detectedOom = false;
    child.stderr?.on("data", (chunk: Buffer) => {
      const observed = stderr + chunk.toString("utf8");
      detectedOom ||= isIsolatedWorkerHeapOom(observed);
      stderr = observed.slice(-4096);
    });
    activeChildren.add(child);
    if (!exitHandlerInstalled) {
      exitHandlerInstalled = true;
      process.once("exit", () => {
        for (const active of activeChildren) killOwnedProcessGroup(active);
      });
    }
    let settled = false;
    let reply: ChildReply | undefined;
    const timeout = setTimeout(() => {
      finish(new Error(`Isolated Code Map refresh timed out after ${limitMs} ms (QUESTBOARD_CODE_MAP_ISOLATED_REFRESH_TIMEOUT_MS)`));
      killOwnedProcessGroup(child);
    }, limitMs);
    timeout.unref();

    function finish(error?: Error, receipt?: CodeMapIsolatedRefreshReceipt): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(receipt!);
    }
    child.on("message", (message: unknown) => {
      let serialized: string;
      try { serialized = JSON.stringify(message); } catch { serialized = ""; }
      if (!serialized || Buffer.byteLength(serialized) > MAX_IPC_BYTES) {
        finish(new Error("Isolated Code Map IPC message exceeded its bounded contract"));
        killOwnedProcessGroup(child);
        return;
      }
      const result = message as Partial<ChildReply> | null;
      if (!result || (result.type !== "complete" && result.type !== "failed") || reply) {
        finish(new Error("Invalid isolated Code Map IPC message"));
        killOwnedProcessGroup(child);
        return;
      }
      if (result.type === "complete"
        && (!isReceipt(result.receipt, request)
          || !Number.isFinite(result.childMaxRssMiB)
          || (result.childMaxRssMiB as number) < 0)) {
        finish(new Error("Invalid isolated Code Map completion receipt"));
        killOwnedProcessGroup(child);
        return;
      }
      reply = result as ChildReply;
    });
    child.once("error", (error) => finish(error));
    child.once("close", (exitCode, signal) => {
      activeChildren.delete(child);
      if (settled) return;
      if (exitCode !== 0 || reply?.type !== "complete") {
        finish(isolatedWorkerExit("refresh", exitCode, signal, stderr, reply?.type === "failed" ? reply.message : undefined, detectedOom));
        return;
      }
      try { options.onProcessMetrics?.({ childMaxRssMiB: reply.childMaxRssMiB }); } catch {
        // Instrumentation must never turn a completed snapshot into a failed job.
      }
      finish(undefined, reply.receipt);
    });
    child.send({ type: "start", request: { projectId: request.projectId, rootPath: request.rootPath } }, (error) => {
      if (error) {
        finish(error);
        killOwnedProcessGroup(child);
      }
    });
  });
}

/** One heavy Code Map indexing subprocess at a time for this daemon. */
export function createIsolatedCodeMapRefreshExecutor(
  env: NodeJS.ProcessEnv,
  options: IsolatedCodeMapRefreshOptions = {},
): CodeMapIsolatedRefreshExecutor {
  let tail: Promise<void> = Promise.resolve();
  return (request) => {
    const task = tail.then(() => runOne(request, env, options));
    tail = task.then(() => undefined, () => undefined);
    return task;
  };
}
