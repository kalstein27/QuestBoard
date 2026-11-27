import { fork, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import { resolveIsolatedCodeMapHeapMiB } from "./code-map-isolated-heap.js";
import { isolatedCodeMapEnv, isolatedWorkerExit, isIsolatedWorkerHeapOom } from "./code-map-isolated-env.js";
import { CodeMapQueryError } from "../application/code-map-query.js";
import { SourceStructureSelectionError } from "../application/source-structure-sync-graph.js";
import type {
  CodeMapIsolatedReadExecutor,
  CodeMapIsolatedReadOperation,
  CodeMapIsolatedReadRequest,
} from "../application/code-map-service.js";

type Reply =
  | { type: "complete"; operation: CodeMapIsolatedReadOperation; value: unknown; childMaxRssMiB: number }
  | { type: "failed"; code: string; message: string };

export interface IsolatedCodeMapReadOptions {
  timeoutMs?: number;
  maxOldSpaceMiB?: number;
  maxConcurrent?: number;
  maxQueued?: number;
  /** Retain one pinned idle worker; undefined is disposable, 0 is indefinite. */
  idleTimeoutMs?: number;
  onProcessMetrics?: (metrics: { childMaxRssMiB: number }) => void;
  /** Optional read-worker lifecycle observer for isolated diagnostics/tests. */
  onWorkerStarted?: (worker: { pid: number; operation: CodeMapIsolatedReadOperation }) => void;
}
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_IPC_BYTES = 1024 * 1024;
const activeChildren = new Set<ChildProcess>();
export function stopIsolatedCodeMapReadWorkers(): void {
  for (const child of activeChildren) killOwned(child);
}
function cancelled(): Error {
  return Object.assign(new Error("Isolated Code Map read cancelled"), { name: "AbortError" });
}
let exitHandlerInstalled = false;
type Worker = { child: ChildProcess; key: string; stderr: string; detectedOom: boolean; timer?: ReturnType<typeof setTimeout> };
type IdleWorker = { worker?: Worker | undefined };

function retire(worker: Worker): void {
  clearTimeout(worker.timer);
  killOwned(worker.child);
}
function takeIdle(idle: IdleWorker, key: string): Worker | undefined {
  const worker = idle.worker;
  idle.worker = undefined;
  if (!worker) return undefined;
  clearTimeout(worker.timer);
  if (worker.key === key && worker.child.connected && worker.child.exitCode === null && !worker.child.killed) return worker;
  retire(worker);
  return undefined;
}
function retainIdle(idle: IdleWorker, worker: Worker, timeoutMs: number): void {
  if (idle.worker) retire(idle.worker);
  idle.worker = worker;
  if (timeoutMs === 0) return;
  worker.timer = setTimeout(() => {
    if (idle.worker === worker) idle.worker = undefined;
    retire(worker);
  }, timeoutMs);
}

function killOwned(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

async function runOne(
  request: CodeMapIsolatedReadRequest,
  env: NodeJS.ProcessEnv,
  options: IsolatedCodeMapReadOptions,
  idle: IdleWorker,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) throw cancelled();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const heapMiB = resolveIsolatedCodeMapHeapMiB(env, "read", options.maxOldSpaceMiB);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new RangeError("Invalid isolated Code Map read resource limits");
  }
  if (!request.projectId || !isAbsolute(request.rootPath))
    throw new TypeError("Isolated Code Map read requires an exact project and trusted absolute root");

  // Bound arguments *before* launching a process, including any manual edges
  // retrieved from the parent-operated SQLite read-only port.
  const payload = { type: "read", request };
  const bytes = Buffer.byteLength(JSON.stringify(payload));
  if (bytes > MAX_IPC_BYTES)
    throw new CodeMapQueryError("code_map_query_invalid", "Isolated Code Map input exceeds the IPC cap");
  const childEnv = isolatedCodeMapEnv(env);
  const idleTimeoutMs = options.idleTimeoutMs ?? 0;
  const warm = options.idleTimeoutMs !== undefined && Boolean(request.snapshotRevision);
  const key = JSON.stringify([request.projectId, request.rootPath, request.snapshotRevision ?? ""]);

  return await new Promise<unknown>((resolve, reject) => {
    let worker = warm ? takeIdle(idle, key) : undefined;
    if (!warm && idle.worker) { retire(idle.worker); idle.worker = undefined; }
    if (!worker) {
      const child = fork(new URL("./code-map-read-child.js", import.meta.url), warm ? ["--keep-alive"] : [], {
        cwd: process.cwd(),
        env: childEnv,
        detached: process.platform !== "win32",
        execArgv: [`--max-old-space-size=${heapMiB}`],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      const created: Worker = { child, key, stderr: "", detectedOom: false };
      worker = created;
      child.stderr?.on("data", (chunk: Buffer) => {
        const observed = created.stderr + chunk.toString("utf8");
        created.detectedOom ||= isIsolatedWorkerHeapOom(observed);
        created.stderr = observed.slice(-4096);
      });
      activeChildren.add(child);
      child.on("error", () => { if (idle.worker === created) { idle.worker = undefined; retire(created); } });
      child.once("close", () => {
        activeChildren.delete(child);
        clearTimeout(created.timer);
        if (idle.worker === created) idle.worker = undefined;
      });
      try { if (child.pid) options.onWorkerStarted?.({ pid: child.pid, operation: request.operation }); } catch { /* diagnostic only */ }
    }
    const current = worker;
    const child = current.child;
    if (!exitHandlerInstalled) {
      exitHandlerInstalled = true;
      process.once("exit", () => {
        for (const current of activeChildren) killOwned(current);
      });
    }
    let settled = false;
    let reply: Reply | undefined;
    const onAbort = (): void => {
      finish(cancelled());
    };
    const timeout = setTimeout(() => {
      finish(new Error("Isolated Code Map read timed out"));
    }, timeoutMs);
    timeout.unref();

    function finish(error?: Error, value?: unknown): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      child.removeListener("message", onMessage);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      if (error) retire(current);
      else if (warm) retainIdle(idle, current, idleTimeoutMs);
      if (error) reject(error);
      else resolve(value);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    function onMessage(message: unknown): void {
      let serialized: string;
      try { serialized = JSON.stringify(message); } catch { serialized = ""; }
      if (!serialized || Buffer.byteLength(serialized) > MAX_IPC_BYTES) {
        finish(new CodeMapQueryError("code_map_query_invalid", "Isolated Code Map result exceeds the IPC cap"));
        return;
      }
      const value = message as Partial<Reply> | null;
      if (!value || (value.type !== "complete" && value.type !== "failed") || reply) {
        finish(new Error("Isolated Code Map returned an invalid reply"));
        return;
      }
      if (value.type === "complete"
        && (value.operation !== request.operation
          || !Number.isFinite(value.childMaxRssMiB)
          || (value.childMaxRssMiB as number) < 0)) {
        finish(new Error("Isolated Code Map read identity or metrics mismatch"));
        return;
      }
      reply = value as Reply;
      if (warm && reply.type === "complete") complete();
    }
    function onError(error: Error): void { finish(error); }
    function complete(): void {
      if (reply?.type !== "complete") return;
      try { options.onProcessMetrics?.({ childMaxRssMiB: reply.childMaxRssMiB }); } catch { /* diagnostic only */ }
      finish(undefined, reply.value);
    }
    function onClose(code: number | null, signal: NodeJS.Signals | null): void {
      if (settled) return;
      if (reply?.type === "failed") {
        if (reply.code.startsWith("source_structure_") || reply.code === "invalid_pinned_page"
          || reply.code === "selected_outside_page" || reply.code === "invalid_raw_anchor"
          || reply.code === "anchor_outside_selection") {
          finish(new SourceStructureSelectionError(reply.code, reply.message));
          return;
        }
        const knownCode = [
          "code_map_not_indexed", "code_node_not_found", "code_node_ambiguous",
          "code_map_subsystem_snapshot_stale", "code_map_snapshot_changed",
          "code_map_query_invalid",
        ] as const;
        if ((knownCode as readonly string[]).includes(reply.code)) {
          finish(new CodeMapQueryError(
            reply.code as (typeof knownCode)[number], reply.message,
          ));
        } else {
          finish(new Error(reply.message));
        }
      } else if (code !== 0 || reply?.type !== "complete") {
        finish(isolatedWorkerExit("read", code, signal, current.stderr, undefined, current.detectedOom));
      } else {
        complete();
      }
    }
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("close", onClose);
    child.send(payload, (error) => {
      if (error) {
        finish(error);
        killOwned(child);
      }
    });
    if (signal?.aborted) onAbort();
  });
}

/** Small bounded worker pool; no resident full-graph copy in the parent. */
export function createIsolatedCodeMapReadExecutor(
  env: NodeJS.ProcessEnv,
  options: IsolatedCodeMapReadOptions = {},
): CodeMapIsolatedReadExecutor {
  const concurrent = options.maxConcurrent ?? 2;
  const maxQueued = options.maxQueued ?? 16;
  const idleTimeoutMs = options.idleTimeoutMs ?? 0;
  if (!Number.isInteger(concurrent) || concurrent < 1 || concurrent > 4
    || !Number.isInteger(maxQueued) || maxQueued < 0 || maxQueued > 128
    || !Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 0 || idleTimeoutMs > 2_147_483_647)
    throw new RangeError("Invalid isolated Code Map read queue limits");
  const idle: IdleWorker = {};
  let running = 0;
  const queue: Array<() => void> = [];
  const pump = (): void => {
    while (running < concurrent && queue.length > 0) queue.shift()!();
  };
  return (request, signal) => {
    if (signal?.aborted) return Promise.reject(cancelled());
    if (running >= concurrent && queue.length >= maxQueued)
      return Promise.reject(new CodeMapQueryError("code_map_query_invalid", "Isolated Code Map read queue is full"));
    return new Promise<unknown>((resolve, reject) => {
      const start = (): void => {
        signal?.removeEventListener("abort", cancelQueued);
        if (signal?.aborted) { reject(cancelled()); return; }
        running += 1;
        void runOne(request, env, options, idle, signal).then(resolve, reject).finally(() => {
          running -= 1;
          pump();
        });
      };
      const cancelQueued = (): void => {
        const index = queue.indexOf(start);
        if (index < 0) return; // Already running; runOne owns the abort.
        queue.splice(index, 1);
        signal?.removeEventListener("abort", cancelQueued);
        reject(cancelled());
        pump();
      };
      queue.push(start);
      signal?.addEventListener("abort", cancelQueued, { once: true });
      if (signal?.aborted) { cancelQueued(); return; }
      pump();
    });
  };
}

export function resolveIsolatedReadIdleMs(env: NodeJS.ProcessEnv): number {
  const raw = env.QUESTBOARD_CODE_MAP_ISOLATED_READ_IDLE_MS?.trim();
  if (!raw) return 600_000;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647)
    throw new RangeError("QUESTBOARD_CODE_MAP_ISOLATED_READ_IDLE_MS must be an integer from 0 to 2147483647");
  return value;
}
