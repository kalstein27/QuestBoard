/** Node old-space limits for disposable Code Map workers, not PHP/RSS limits. */
export function resolveIsolatedCodeMapHeapMiB(
  env: NodeJS.ProcessEnv,
  kind: "refresh" | "read",
  override?: number,
): number {
  const key = kind === "refresh"
    ? "QUESTBOARD_CODE_MAP_ISOLATED_REFRESH_HEAP_MIB"
    : "QUESTBOARD_CODE_MAP_ISOLATED_READ_HEAP_MIB";
  const sharedKey = "QUESTBOARD_CODE_MAP_ISOLATED_HEAP_MIB";
  const specific = env[key]?.trim();
  const shared = env[sharedKey]?.trim();
  const raw = specific || shared || "512";
  const limit = override ?? Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 64 || limit > 4096
    || (override === undefined && !/^\d+$/.test(raw))) {
    throw new RangeError(`${override !== undefined ? "maxOldSpaceMiB" : specific ? key : sharedKey} must be an integer from 64 to 4096 MiB`);
  }
  return limit;
}