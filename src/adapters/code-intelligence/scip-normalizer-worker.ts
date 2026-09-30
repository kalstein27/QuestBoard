import { parentPort, workerData } from "node:worker_threads";
import type { CodeGraphSnapshot } from "../../application/code-intelligence.js";
import { loadScipGraphInProcess, type ScipGraphLoadInput } from "./scip-provider.js";

type WorkerResult =
  | { ok: true; graph: CodeGraphSnapshot }
  | { ok: false; error: string };

if (!parentPort) {
  throw new Error("SCIP normalization worker requires a parent port");
}

try {
  const graph = await loadScipGraphInProcess(workerData as ScipGraphLoadInput);
  parentPort.postMessage({ ok: true, graph } satisfies WorkerResult);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  parentPort.postMessage({ ok: false, error: message } satisfies WorkerResult);
}
