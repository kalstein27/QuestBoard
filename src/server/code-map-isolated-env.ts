/** Explicit worker environment: never inherit arbitrary daemon secrets. */
export function isolatedCodeMapEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keys = [
    "HOME", "PATH", "TMPDIR", "TEMP", "TMP", "SystemRoot", "ComSpec", "PATHEXT", "USERPROFILE", "XDG_DATA_HOME",
    "QUESTBOARD_CODE_MAP", "QUESTBOARD_CODE_MAP_PROVIDER", "QUESTBOARD_CODE_MAP_PROVIDERS",
    "QUESTBOARD_CODE_MAP_STORAGE_ROOT", "QUESTBOARD_CODE_MAP_EXCLUDE_PREFIXES",
    "QUESTBOARD_CODE_MAP_SUBSYSTEM_DEPTH", "QUESTBOARD_CODE_MAP_MAX_SNAPSHOT_MIB",
    "QUESTBOARD_SCIP_PHP_EXECUTABLE", "QUESTBOARD_SCIP_TYPESCRIPT_EXECUTABLE",
    "QUESTBOARD_PHP_EXECUTABLE", "QUESTBOARD_SOURCEKIT_LSP_EXECUTABLE",
    "QUESTBOARD_SOURCEKIT_EXTRA_BUILD_CONTEXTS", "QUESTBOARD_SOURCEKIT_BUILD_SERVER_EXECUTABLE",
  ];
  const result: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const actual = process.platform === "win32" ? Object.keys(env).find(k => k.toLowerCase() === key.toLowerCase()) ?? key : key;
    if (env[actual] !== undefined) result[key] = env[actual];
  }
  result.QUESTBOARD_CODE_MAP = "1";
  return result;
}

/** Bound failure diagnostics; never forward stack traces or arbitrary stderr. */
export function isolatedWorkerDiagnostic(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let i = 0; i < 4 && current instanceof Error && !seen.has(current); i++) {
    seen.add(current);
    const e = current as NodeJS.ErrnoException;
    if (e.code === "ENOENT" && e.syscall?.startsWith("spawn")) {
      parts.push("Executable spawn failed (ENOENT): " + (e.path?.split(/[\\/]/).pop() ?? "unknown"));
    } else {
      parts.push((e.name + ": " + e.message).replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 160));
    }
    current = current.cause;
  }
  // Keep the root cause first so the bounded refresh receipt cannot hide it.
  return parts.reverse().join("; caused by: ").slice(0, 400) || "Unknown worker failure";
}

export function isIsolatedWorkerHeapOom(stderr: string): boolean {
  return /heap out of memory|allocation failed.*heap|reached heap limit|ineffective mark-compacts/i.test(stderr);
}

export function isolatedWorkerExit(kind: "refresh" | "read", code: number | null, signal: string | null, stderr: string, detail?: string, detectedOom = false): Error {
  const oom = detectedOom || isIsolatedWorkerHeapOom(stderr);
  const hint = oom ? `; JavaScript heap out of memory; raise QUESTBOARD_CODE_MAP_ISOLATED_${kind.toUpperCase()}_HEAP_MIB` : "";
  return new Error(`Isolated Code Map ${kind} failed (exitCode=${code ?? "none"}, signal=${signal ?? "none"})${detail ? ": " + detail : ""}${hint}`);
}