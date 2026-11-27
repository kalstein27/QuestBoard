import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Explicit per-project semantic scope; never infer exclusions from a language or directory name. */
export function projectCodeMapExclusionPrefixes(rootPath: string | undefined): readonly string[] {
  if (!rootPath) return [];
  try {
    const path = join(rootPath, "questboard-code-map.json");
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 16384) return [];
    const config = JSON.parse(readFileSync(path, "utf8")) as { excludePrefixes?: unknown };
    const prefixes = config?.excludePrefixes;
    if (!Array.isArray(prefixes) || !prefixes.every((entry) => typeof entry === "string"
      && entry.length > 0 && !/[\\\\:*?\[\]{}]/.test(entry)
      && !entry.split("/").some((part) => !part || part === "." || part === ".."))) return [];
    return [...new Set(prefixes as string[])];
  } catch { return []; } // Missing or invalid scope never suppresses a provider.
}

/** User-configured semantic-indexer exclusions. File inventory remains visible. */
export function configuredCodeMapExclusionPrefixes(
  value = process.env.QUESTBOARD_CODE_MAP_EXCLUDE_PREFIXES,
): readonly string[] {
  return [...new Set((value ?? "").split(",").map((entry) =>
    entry.trim().replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, ""))
    .filter((entry) => entry.length > 0 && !entry.startsWith("/")
      && !entry.split("/").some((segment) => segment === ".." || segment === "." || !segment)))];
}

export function isConfiguredCodeMapExcluded(
  path: string,
  prefixes: readonly string[],
): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\/+/, "");
  return prefixes.some((prefix) => normalized === prefix || normalized.startsWith(prefix + "/"));
}
