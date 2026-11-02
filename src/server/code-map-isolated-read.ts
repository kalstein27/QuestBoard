import { fork, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
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
  onProcessMetrics?: (metrics: { childMaxRssMiB: number }) => void;
  /** Optional read-worker lifecycle observer for isolated diagnostics/tests. */
  onWorkerStarted?: (worker: { pid: number; operation: CodeMapIsolatedReadOperation }) => void;
}
const DEFAULT_TIMEOUT_MS = 20_000;
const configuredHeapMiB = Number(process.env.QUESTBOARD_CODE_MAP_ISOLATED_HEAP_MIB ?? "512");
const DEFAULT_HEAP_MIB = Number.isSafeInteger(configuredHeapMiB)
  && configuredHeapMiB >= 64 && configuredHeapMiB <= 4096 ? configuredHeapMiB : 512;
const MAX_IPC_BYTES = 1024 * 1024;
const activeChildren = new Set<ChildProcess>();
function cancelled(): Error {
  return Object.assign(new Error("Isolated Code Map read cancelled"), { name: "AbortError" });
}
let exitHandlerInstalled = false;
const ENV_KEYS = [
  "HOME", "PATH", "TMPDIR", "XDG_DATA_HOME",
  "QUESTBOARD_CODE_MAP", "QUESTBOARD_CODE_MAP_PROVIDER", "QUESTBOARD_CODE_MAP_PROVIDERS",
  "QUESTBOARD_CODE_MAP_EXCLUDE_PREFIXES",
  "QUESTBOARD_CODE_MAP_STORAGE_ROOT", "QUESTBOARD_SCIP_PHP_EXECUTABLE",
  "QUESTBOARD_SCIP_TYPESCRIPT_EXECUTABLE",
  "QUESTBOARD_CODE_MAP_MAX_SNAPSHOT_MIB", "QUESTBOARD_CODE_MAP_ISOLATED_HEAP_MIB",
] as const;

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
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) throw cancelled();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const heapMiB = options.maxOldSpaceMiB ?? DEFAULT_HEAP_MIB;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000
    || !Number.isInteger(heapMiB) || heapMiB < 64 || heapMiB > 4096) {
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
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of ENV_KEYS) if (env[key]) childEnv[key] = env[key];
  childEnv.QUESTBOARD_CODE_MAP = "1";

  return await new Promise<unknown>((resolve, reject) => {
    const child = fork(new URL("./code-map-read-child.js", import.meta.url), [], {
      cwd: process.cwd(),
      env: childEnv,
      detached: process.platform !== "win32",
      execArgv: [`--max-old-space-size=${heapMiB}`],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    activeChildren.add(child);
    try {
      if (child.pid) options.onWorkerStarted?.({ pid: child.pid, operation: request.operation });
    } catch {
      // Observability callbacks must never break worker execution.
    }
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
      killOwned(child);
    };
    const timeout = setTimeout(() => {
      finish(new Error("Isolated Code Map read timed out"));
      killOwned(child);
    }, timeoutMs);
    timeout.unref();

    function finish(error?: Error, value?: unknown): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("message", (message: unknown) => {
      let serialized: string;
      try { serialized = JSON.stringify(message); } catch { serialized = ""; }
      if (!serialized || Buffer.byteLength(serialized) > MAX_IPC_BYTES) {
        finish(new CodeMapQueryError("code_map_query_invalid", "Isolated Code Map result exceeds the IPC cap"));
        killOwned(child);
        return;
      }
      const value = message as Partial<Reply> | null;
      if (!value || (value.type !== "complete" && value.type !== "failed") || reply) {
        finish(new Error("Isolated Code Map returned an invalid reply"));
        killOwned(child);
        return;
      }
      if (value.type === "complete"
        && (value.operation !== request.operation
          || !Number.isFinite(value.childMaxRssMiB)
          || (value.childMaxRssMiB as number) < 0)) {
        finish(new Error("Isolated Code Map read identity or metrics mismatch"));
        killOwned(child);
        return;
      }
      reply = value as Reply;
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => {
      activeChildren.delete(child);
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
        finish(new Error("Isolated Code Map read process exited without a complete result"));
      } else {
        try { options.onProcessMetrics?.({ childMaxRssMiB: reply.childMaxRssMiB }); } catch {
          // Metrics must not break a successful read.
        }
        finish(undefined, reply.value);
      }
    });
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
  if (!Number.isInteger(concurrent) || concurrent < 1 || concurrent > 4
    || !Number.isInteger(maxQueued) || maxQueued < 0 || maxQueued > 128)
    throw new RangeError("Invalid isolated Code Map read queue limits");
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
        void runOne(request, env, options, signal).then(resolve, reject).finally(() => {
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
