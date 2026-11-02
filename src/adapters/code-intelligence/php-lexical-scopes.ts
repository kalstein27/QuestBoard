import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScipPhpLexicalScope } from "./scip-normalizer.js";

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 12 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 90_000;

function lexicalParserPath(): string {
  // Built output lives in dist/src/adapters/code-intelligence. Keep the
  // PHP AST parser as a source-controlled script, not a generated temp file.
  const compiledRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const candidates = [
    resolve(compiledRepoRoot, "scripts/questboard-php-scip-lexical-scopes.php"),
    resolve(process.cwd(), "scripts/questboard-php-scip-lexical-scopes.php"),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error("SCIP PHP lexical AST bridge is unavailable");
  return found;
}

function isRange(value: unknown): value is [number, number, number, number] {
  return Array.isArray(value) && value.length === 4
    && value.every((item) => Number.isSafeInteger(item) && item >= 0)
    && ((value[0] as number) < (value[2] as number)
      || (value[0] === value[2] && (value[1] as number) <= (value[3] as number)));
}

function parseResponse(value: unknown, paths: ReadonlySet<string>): ReadonlyMap<string, readonly ScipPhpLexicalScope[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid PHP AST lexical response");
  }
  const object = value as Record<string, unknown>;
  if (!Number.isSafeInteger(object.parsed) || !Number.isSafeInteger(object.errors)
    || typeof object.documents !== "object" || !object.documents || Array.isArray(object.documents)) {
    throw new Error("Invalid PHP AST lexical diagnostics");
  }
  const documents = object.documents as Record<string, unknown>;
  const scopes = new Map<string, readonly ScipPhpLexicalScope[]>();
  let total = 0;
  for (const [path, list] of Object.entries(documents)) {
    if (!paths.has(path) || !Array.isArray(list)) throw new Error("Unexpected PHP AST document");
    const items: ScipPhpLexicalScope[] = [];
    for (const item of list) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("Invalid PHP lexical owner");
      }
      const scope = item as Record<string, unknown>;
      if (!isRange(scope.range) || !["method", "function", "anonymous"].includes(String(scope.type))) {
        throw new Error("Invalid PHP lexical scope range or type");
      }
      if (scope.type === "anonymous") {
        items.push({ type: "anonymous", range: scope.range });
      } else if (typeof scope.name === "string" && scope.name.length > 0 && scope.name.length <= 255
        && isRange(scope.nameRange)) {
        items.push({
          type: scope.type as "method" | "function",
          name: scope.name,
          nameRange: scope.nameRange,
          range: scope.range,
        });
      } else throw new Error("Invalid PHP lexical named scope");
      total++;
      if (total > 150000) throw new Error("PHP lexical scope count exceeds cap");
    }
    scopes.set(path, items);
  }
  if (Number(object.parsed) !== scopes.size || Number(object.errors) > paths.size) {
    throw new Error("Invalid PHP AST lexical document counts");
  }
  return scopes;
}

/** Strict read-only PHP Parser 5 lexical extents used only with real SCIP PHP facts. */
export async function extractPhpLexicalScopes(
  canonicalRoot: string,
  documentPaths: readonly string[],
  options: { phpExecutable?: string; timeoutMs?: number } = {},
): Promise<ReadonlyMap<string, readonly ScipPhpLexicalScope[]>> {
  // macOS /tmp is a symlink to /private/tmp. Always pass a canonical root to
  // the PHP reader so it can enforce a strict path containment boundary.
  canonicalRoot = realpathSync.native(canonicalRoot);
  const paths = [...new Set(documentPaths.filter((path) => path.toLowerCase().endsWith(".php")))];
  if (!paths.length) return new Map();
  if (paths.length > 10000) throw new Error("SCIP PHP lexical document count exceeds cap");
  const payload = JSON.stringify(paths);
  if (Buffer.byteLength(payload) > MAX_INPUT_BYTES) throw new Error("SCIP PHP lexical input exceeds cap");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 180_000) {
    throw new Error("Invalid SCIP PHP AST timeout");
  }
  const script = lexicalParserPath();
  const executable = options.phpExecutable ?? process.env.QUESTBOARD_PHP_EXECUTABLE?.trim() ?? "php";

  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, ["-d", "memory_limit=512M", script, canonicalRoot], {
      cwd: canonicalRoot,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let stderr = "";
    let finished = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timeout.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_RESULT_BYTES) child.kill("SIGKILL");
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 2048) stderr = stderr.slice(-2048);
    });
    const finish = (error?: Error, value?: ReadonlyMap<string, readonly ScipPhpLexicalScope[]>) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolvePromise(value ?? new Map());
    };
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (finished) return;
      if (timedOut || signal || code !== 0 || outputBytes > MAX_RESULT_BYTES) {
        finish(new Error("SCIP PHP AST lexical extraction failed: "
          + (timedOut ? "timeout" : signal ? "signal" : "exit " + code)
          + (stderr ? " (diagnostic: " + stderr.slice(-300) + ")" : "")));
        return;
      }
      try {
        finish(undefined, parseResponse(JSON.parse(Buffer.concat(stdout).toString("utf8")), new Set(paths)));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stdin.on("error", () => { /* close/error handler owns terminal status */ });
    child.stdin.end(payload);
  });
}
