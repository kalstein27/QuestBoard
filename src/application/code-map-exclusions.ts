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
