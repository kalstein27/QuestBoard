import type { CodeGraphSnapshot, CodeNode } from "./code-intelligence.js";
import type { CodeMapSnapshotIdentity } from "./code-map-snapshot-identity.js";
import { CodeMapQueryError } from "./code-map-query.js";

export interface CodeMapSourceTreeRequest {
  pathPrefix?: string;
  offset?: number;
  limit?: number;
  expectedSnapshotId?: string;
}
export interface CodeMapSourceTreeEntry {
  type: "directory" | "file";
  name: string;
  path: string;
  node?: CodeNode;
}
export interface CodeMapSourceTreePage {
  projectId: string;
  snapshotId?: string;
  indexedAt: string;
  pathPrefix: string;
  offset: number;
  limit: number;
  candidateCount: number;
  returnedCount: number;
  hasMore: boolean;
  entries: readonly CodeMapSourceTreeEntry[];
}

export function createCodeMapSourceTreePage(
  graph: CodeGraphSnapshot,
  identity: CodeMapSnapshotIdentity | undefined,
  input: CodeMapSourceTreeRequest,
): CodeMapSourceTreePage {
  const pathPrefix = (input.pathPrefix ?? "").trim();
  if (pathPrefix.length > 512 || pathPrefix.startsWith("/") || pathPrefix.includes("\\")
    || (pathPrefix !== "" && pathPrefix.split("/").some((part) =>
      part === "." || part === ".." || part === ""))) {
    throw new CodeMapQueryError("code_map_query_invalid", "Invalid project-relative source tree path");
  }
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 40;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 80) {
    throw new CodeMapQueryError("code_map_query_invalid", "Invalid bounded source tree page");
  }
  if (offset > 0 && (!input.expectedSnapshotId || !identity?.snapshotId)) {
    throw new CodeMapQueryError("code_map_query_invalid",
      "A pinned snapshot ID is mandatory for paginated source tree reads");
  }
  if (input.expectedSnapshotId && identity?.snapshotId !== input.expectedSnapshotId) {
    throw new CodeMapQueryError("code_map_snapshot_changed", "Source tree snapshot changed");
  }
  const folders = new Map<string, CodeMapSourceTreeEntry>();
  const files: CodeMapSourceTreeEntry[] = [];
  const prefix = pathPrefix ? pathPrefix + "/" : "";
  for (const node of graph.nodes) {
    if (node.kind !== "file" || !node.location?.path) continue;
    const path = node.location.path.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!path.startsWith(prefix)) continue;
    const remainder = path.slice(prefix.length);
    if (!remainder) continue;
    const slash = remainder.indexOf("/");
    if (slash >= 0) {
      const name = remainder.slice(0, slash);
      const folder = pathPrefix ? pathPrefix + "/" + name : name;
      if (!folders.has(name)) folders.set(name, { type: "directory", name, path: folder });
    } else {
      files.push({ type: "file", name: node.name, path, node: {
        id: node.id, kind: node.kind, name: node.name,
        canonicalIdentity: node.canonicalIdentity,
        ...(node.language ? { language: node.language } : {}),
        location: { path },
      } });
    }
  }
  const entries = [
    ...[...folders.values()].sort((a,b)=>a.name.localeCompare(b.name)),
    ...files.sort((a,b)=>a.name.localeCompare(b.name)||a.path.localeCompare(b.path)),
  ];
  const visible = entries.slice(offset, offset + limit);
  return {
    projectId: graph.projectId,
    ...(identity ? { snapshotId: identity.snapshotId } : {}),
    indexedAt: graph.indexedAt, pathPrefix, offset, limit,
    candidateCount: entries.length,
    returnedCount: visible.length,
    hasMore: offset + limit < entries.length,
    entries: visible,
  };
}
