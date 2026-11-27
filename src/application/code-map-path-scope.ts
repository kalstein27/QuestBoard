import type { CodeGraphSnapshot, CodeIndexRequest } from "./code-intelligence.js";
import type { CodeFileInventoryEntry } from "./code-map-hierarchy.js";

/** Project-owned paths are literal repository-relative prefixes, not arbitrary globs. */
export function normalizeCodeMapExcludedPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new TypeError("Code Map excluded paths must be an array of at most 64 paths");
  }
  const paths = value.map((entry: unknown) => {
    if (typeof entry !== "string") throw new TypeError("Code Map excluded path must be a string");
    const path = entry.trim().replace(/\\/g, "/").replace(/\/\*\*$/, "").replace(/\/$/, "");
    if (!path || path.length > 256 || path.startsWith("/") || /^[A-Za-z]:/.test(path)
      || /[\u0000-\u001f:*?\[\]{}]/.test(path)
      || path.split("/").some(part => !part || part === "." || part === "..")) {
      throw new TypeError("Code Map excluded path must be a safe project-relative literal prefix");
    }
    return path;
  });
  return [...new Set(paths)].sort();
}

export function isCodeMapPathExcluded(path: string, excluded: readonly string[] | undefined): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return Boolean(excluded?.some(prefix => normalized === prefix || normalized.startsWith(prefix + "/")));
}

export function scopedCodeMapFiles<T extends CodeFileInventoryEntry>(
  files: readonly T[], request: Pick<CodeIndexRequest, "excludedPaths">,
): T[] {
  return request.excludedPaths?.length
    ? files.filter(file => !isCodeMapPathExcluded(file.path, request.excludedPaths))
    : [...files];
}

/** Drop excluded symbols and dangling edges, including mixed call-site evidence. */
export function scopedCodeMapGraph(
  graph: CodeGraphSnapshot, request: Pick<CodeIndexRequest, "excludedPaths">,
): CodeGraphSnapshot {
  if (!request.excludedPaths?.length) return graph;
  const nodes = graph.nodes.filter(node =>
    !node.location?.path || !isCodeMapPathExcluded(node.location.path, request.excludedPaths));
  const kept = new Set(nodes.map(node => node.id));
  const relations = graph.relations.flatMap(relation => {
    if (!kept.has(relation.from) || !kept.has(relation.to)) return [];
    if (!relation.evidence?.length) return [relation];
    const evidence = relation.evidence.filter(entry =>
      !entry.location?.path || !isCodeMapPathExcluded(entry.location.path, request.excludedPaths));
    return evidence.length ? [{ ...relation, evidence }] : [];
  });
  return { ...graph, nodes, relations };
}
