import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScipPhpLexicalScope, ScipPhpTypedMethodCall } from "./scip-normalizer.js";

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 32 * 1024 * 1024;
const MAX_CALL_REFERENCE_SITES = 250_000;
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
  if (object.errors !== 0 || object.parsed !== paths.size) {
    throw new Error("PHP AST lexical extraction incomplete: parsed "
      + object.parsed + "/" + paths.size + ", errors " + object.errors);
  }
  const documents = object.documents as Record<string, unknown>;
  const scopes = new Map<string, readonly ScipPhpLexicalScope[]>();
  let total = 0;
  let totalCalls = 0;
  const validName = (value: unknown, max: number): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= max
    && !/[\r\n\0]/.test(value);
  for (const [path, list] of Object.entries(documents)) {
    if (!paths.has(path) || !Array.isArray(list)) throw new Error("Unexpected PHP AST document");
    const items: ScipPhpLexicalScope[] = [];
    for (const item of list) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("Invalid PHP lexical owner");
      }
      const scope = item as Record<string, unknown>;
      if (!isRange(scope.range) || !["method", "function", "anonymous", "class", "file"].includes(String(scope.type))) {
        throw new Error("Invalid PHP lexical scope range or type");
      }
      if (scope.type === "anonymous") {
        if (scope.className !== undefined) throw new Error("Anonymous scope cannot claim a named class");
        const calls: ScipPhpTypedMethodCall[] = [];
        if (scope.calls !== undefined && !Array.isArray(scope.calls)) throw new Error("Invalid anonymous typed calls");
        for (const raw of (scope.calls ?? []) as unknown[]) {
          if (!raw || typeof raw !== "object") throw new Error("Invalid anonymous typed call");
          const call = raw as Record<string, unknown>;
          if (!validName(call.className, 1024) || !validName(call.name, 255) || !isRange(call.nameRange)
            || (call.evidenceSource !== undefined && !["native", "docblock"].includes(String(call.evidenceSource)))) {
            throw new Error("Invalid anonymous call identity or range");
          }
          calls.push({ className: call.className, name: call.name, nameRange: call.nameRange,
            ...(call.evidenceSource ? { evidenceSource: call.evidenceSource as "native" | "docblock" } : {}) });
          if (++totalCalls > MAX_CALL_REFERENCE_SITES) throw new Error("PHP anonymous call sites exceed cap");
        }
        const unresolved = scope.unresolvedCalls ?? [];
        if (!Array.isArray(unresolved)) throw new Error("Invalid anonymous unresolved calls");
        const unresolvedCalls: Array<{ name: string; nameRange: [number, number, number, number] }> = [];
        for (const raw of unresolved) {
          if (!raw || typeof raw !== "object") throw new Error("Invalid anonymous call");
          const call = raw as Record<string, unknown>;
          if (!validName(call.name, 255) || !isRange(call.nameRange)) throw new Error("Invalid anonymous call site");
          unresolvedCalls.push({ name: call.name, nameRange: call.nameRange });
          if (++totalCalls > MAX_CALL_REFERENCE_SITES) throw new Error("PHP call sites exceed cap");
        }
        items.push({ type: "anonymous", range: scope.range,
          ...(calls.length ? { calls } : {}), ...(unresolvedCalls.length ? { unresolvedCalls } : {}) });
      } else if (scope.type === "file") {
        const calls: ScipPhpTypedMethodCall[] = [];
        const instantiations: Array<{ className: string; nameRange: [number, number, number, number] }> = [];
        const unresolvedCalls: Array<{ name: string; nameRange: [number, number, number, number] }> = [];
        for (const raw of (scope.calls ?? []) as unknown[]) {
          if (!raw || typeof raw !== "object") throw new Error("Invalid PHP file call");
          const call = raw as Record<string, unknown>;
          if (!validName(call.className, 1024) || !validName(call.name, 255) || !isRange(call.nameRange)) throw new Error("Invalid file call");
          if (call.callStyle !== undefined && call.callStyle !== "object") throw new Error("Invalid file call style");
          calls.push({ className: call.className, name: call.name, nameRange: call.nameRange,
            ...(call.callStyle === "object" ? { callStyle: "object" as const } : {}) });
          if (++totalCalls > MAX_CALL_REFERENCE_SITES) throw new Error("PHP call cap exceeded");
        }
        if (scope.instantiations !== undefined && !Array.isArray(scope.instantiations)) {
          throw new Error("Invalid PHP file instantiations");
        }
        for (const raw of (scope.instantiations ?? []) as unknown[]) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid file instantiation");
          const instantiation = raw as Record<string, unknown>;
          if (!validName(instantiation.className, 1024) || !isRange(instantiation.nameRange)) {
            throw new Error("Invalid file instantiation target or range");
          }
          instantiations.push({ className: instantiation.className, nameRange: instantiation.nameRange });
          if (++totalCalls > MAX_CALL_REFERENCE_SITES) throw new Error("PHP instantiation sites exceed cap");
        }
        for (const raw of (scope.unresolvedCalls ?? []) as unknown[]) {
          if (!raw || typeof raw !== "object") throw new Error("Invalid PHP file unresolved call");
          const call = raw as Record<string, unknown>;
          if (!validName(call.name, 255) || !isRange(call.nameRange)) throw new Error("Invalid file unresolved call");
          unresolvedCalls.push({ name: call.name, nameRange: call.nameRange });
          if (++totalCalls > MAX_CALL_REFERENCE_SITES) throw new Error("PHP call cap exceeded");
        }
        items.push({ type: "file", range: scope.range,
          ...(calls.length ? { calls } : {}),
          ...(instantiations.length ? { instantiations } : {}),
          ...(unresolvedCalls.length ? { unresolvedCalls } : {}) });
      } else if (scope.type === "class" && validName(scope.className, 1024) && isRange(scope.nameRange)) {
        if (!Array.isArray(scope.ancestors) || scope.ancestors.length > 128) throw new Error("Invalid PHP ancestors");
        const ancestors: Array<{ className: string; relation: "extends" | "implements" | "trait" }> = [];
        for (const raw of scope.ancestors) {
          if (!raw || typeof raw !== "object") throw new Error("Invalid PHP ancestor");
          const ancestor = raw as Record<string, unknown>;
          if (!validName(ancestor.className, 1024)
            || !["extends", "implements", "trait"].includes(String(ancestor.relation))) throw new Error("Invalid PHP ancestor");
          ancestors.push({ className: ancestor.className, relation: ancestor.relation as "extends" | "implements" | "trait" });
        }
        const definitions: Array<{ name: string; nameRange: [number, number, number, number] }> = [];
        if (scope.propertyDefinitions !== undefined && !Array.isArray(scope.propertyDefinitions)) throw new Error("Invalid property definitions");
        for (const raw of (scope.propertyDefinitions ?? []) as unknown[]) {
          if (!raw || typeof raw !== "object") throw new Error("Invalid PHP property definition");
          const definition = raw as Record<string, unknown>;
          if (!validName(definition.name, 255) || !isRange(definition.nameRange)) throw new Error("Invalid PHP property definition range");
          definitions.push({ name: definition.name, nameRange: definition.nameRange });
          if (definitions.length > 15000) throw new Error("Too many PHP property declarations");
        }
        const constantDefinitions: Array<{
          name: string; nameRange: [number, number, number, number]; kind: "constant" | "enum_case";
        }> = [];
        if (scope.constantDefinitions !== undefined && !Array.isArray(scope.constantDefinitions)) {
          throw new Error("Invalid PHP constant definitions");
        }
        for (const raw of (scope.constantDefinitions ?? []) as unknown[]) {
          if (!raw || typeof raw !== "object") throw new Error("Invalid PHP constant definition");
          const entry = raw as Record<string, unknown>;
          if (!validName(entry.name, 255) || !isRange(entry.nameRange)
            || !["constant", "enum_case"].includes(String(entry.kind))) {
            throw new Error("Invalid PHP constant definition token");
          }
          constantDefinitions.push({ name: entry.name, nameRange: entry.nameRange,
            kind: entry.kind as "constant" | "enum_case" });
          if (constantDefinitions.length > 15000) throw new Error("Too many PHP constant definitions");
        }
        const docMethods: Array<{ name: string; nameRange: [number, number, number, number]; isStatic: boolean }> = [];
        if (scope.docMethods !== undefined && !Array.isArray(scope.docMethods)) throw new Error("Invalid PHPDoc methods");
        for (const raw of (scope.docMethods ?? []) as unknown[]) {
          if (!raw || typeof raw !== "object") throw new Error("Invalid PHPDoc method");
          const declaration = raw as Record<string, unknown>;
          if (!validName(declaration.name, 255) || !isRange(declaration.nameRange) || typeof declaration.isStatic !== "boolean"
            || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(declaration.name)) throw new Error("Invalid PHPDoc method token");
          docMethods.push({ name: declaration.name, nameRange: declaration.nameRange, isStatic: declaration.isStatic });
          if (docMethods.length > 1024) throw new Error("Too many PHPDoc methods");
        }
        items.push({ type: "class", className: scope.className, range: scope.range,
          nameRange: scope.nameRange, ancestors, propertyDefinitions: definitions,
          constantDefinitions, docMethods });
      } else if (validName(scope.name, 255) && isRange(scope.nameRange)) {
        if (scope.className !== undefined && (scope.type !== "method" || !validName(scope.className, 1024))) {
          throw new Error("Invalid PHP lexical class identity");
        }
        if (scope.isStatic !== undefined && typeof scope.isStatic !== "boolean"
          || scope.isConcretePublic !== undefined && typeof scope.isConcretePublic !== "boolean") {
          throw new Error("Invalid PHP method modifiers");
        }
        const calls: ScipPhpTypedMethodCall[] = [];
        if (scope.calls !== undefined && !Array.isArray(scope.calls)) throw new Error("Invalid PHP typed calls");
        for (const raw of (scope.calls ?? []) as unknown[]) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid PHP typed call");
          const call = raw as Record<string, unknown>;
          if (!validName(call.className, 1024) || !validName(call.name, 255) || !isRange(call.nameRange)) {
            throw new Error("Invalid PHP typed call identity or range");
          }
          if (call.evidenceSource !== undefined && !["native", "docblock"].includes(String(call.evidenceSource))) {
            throw new Error("Invalid PHP typed call evidence source");
          }
          calls.push({ className: call.className, name: call.name, nameRange: call.nameRange,
            ...(call.evidenceSource ? { evidenceSource: call.evidenceSource as "native" | "docblock" } : {}) });
          if (++totalCalls > MAX_CALL_REFERENCE_SITES) throw new Error("PHP typed call count exceeds cap");
        }
        const unresolvedCalls: Array<{ name: string; nameRange: [number, number, number, number] }> = [];
        if (scope.unresolvedCalls !== undefined && !Array.isArray(scope.unresolvedCalls)) {
          throw new Error("Invalid PHP unresolved calls");
        }
        for (const raw of (scope.unresolvedCalls ?? []) as unknown[]) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid PHP unresolved call");
          const call = raw as Record<string, unknown>;
          if (!validName(call.name, 255) || !isRange(call.nameRange)) throw new Error("Invalid PHP unresolved call range");
          unresolvedCalls.push({ name: call.name, nameRange: call.nameRange });
          if (++totalCalls > MAX_CALL_REFERENCE_SITES) throw new Error("PHP call site count exceeds cap");
        }
        const propertyAccesses: Array<{ className: string; name: string;
          nameRange: [number, number, number, number]; kind: "reads" | "writes";
          evidenceSource?: "native" | "docblock" }> = [];
        if (scope.propertyAccesses !== undefined && !Array.isArray(scope.propertyAccesses)) throw new Error("Invalid property references");
        for (const raw of (scope.propertyAccesses ?? []) as unknown[]) {
          if (!raw || typeof raw !== "object") throw new Error("Invalid property access");
          const access = raw as Record<string, unknown>;
          if (!validName(access.className, 1024) || !validName(access.name, 255) || !isRange(access.nameRange)
            || !["reads", "writes"].includes(String(access.kind))
            || (access.evidenceSource !== undefined && !["native", "docblock"].includes(String(access.evidenceSource))))
            throw new Error("Invalid typed property access");
          propertyAccesses.push({ className: access.className, name: access.name,
            nameRange: access.nameRange, kind: access.kind as "reads" | "writes",
            ...(access.evidenceSource ? { evidenceSource: access.evidenceSource as "native" | "docblock" } : {}) });
          if (++totalCalls > MAX_CALL_REFERENCE_SITES) throw new Error("PHP reference site cap exceeded");
        }
        items.push({
          type: scope.type as "method" | "function",
          name: scope.name,
          nameRange: scope.nameRange,
          range: scope.range,
          ...(scope.className ? { className: scope.className as string } : {}),
          ...(scope.isStatic !== undefined ? { isStatic: scope.isStatic as boolean } : {}),
          ...(scope.isConcretePublic !== undefined ? { isConcretePublic: scope.isConcretePublic as boolean } : {}),
          ...(calls.length ? { calls } : {}),
          ...(unresolvedCalls.length ? { unresolvedCalls } : {}),
          ...(propertyAccesses.length ? { propertyAccesses } : {}),
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
          + (timedOut ? "timeout" : outputBytes > MAX_RESULT_BYTES
            ? "output exceeded 32MiB cap" : signal ? "signal" : "exit " + code)
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
