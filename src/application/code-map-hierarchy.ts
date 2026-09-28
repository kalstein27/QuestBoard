import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  CODE_GRAPH_SCHEMA_VERSION,
  assertValidCodeGraphSnapshot,
  type CodeFactProvenance,
  type CodeGraphSnapshot,
  type CodeNode,
  type CodeRelation,
} from "./code-intelligence.js";

export interface CodeFileInventoryEntry {
  path: string;
  language?: string;
}

export interface CodeFileInventory {
  listFiles(rootPath: string): Promise<readonly CodeFileInventoryEntry[]>;
}

const FILE_INVENTORY_PROVENANCE: CodeFactProvenance = {
  providerId: "questboard:file-inventory",
  fidelity: "file-only",
  freshness: "fresh",
};
const FILE_HIERARCHY_PROVENANCE: CodeFactProvenance = {
  providerId: "questboard:file-hierarchy",
  fidelity: "syntax",
  freshness: "fresh",
};

function stableId(namespace: "node" | "relation", value: string): string {
  return `code:${namespace}:${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function inferCodeLanguageFromPath(path: string): string | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if ([".js", ".jsx", ".mjs", ".cjs"].some((extension) => lower.endsWith(extension))) return "javascript";
  if (lower.endsWith(".swift")) return "swift";
  if ([".sh", ".bash", ".zsh"].some((extension) => lower.endsWith(extension))) return "shellscript";
  if ([".ps1", ".psm1", ".psd1"].some((extension) => lower.endsWith(extension))) return "powershell";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".java")) return "java";
  if ([".kt", ".kts"].some((extension) => lower.endsWith(extension))) return "kotlin";
  if ([".c", ".h"].some((extension) => lower.endsWith(extension))) return "c";
  if ([".cc", ".cpp", ".cxx", ".hpp", ".hh"].some((extension) => lower.endsWith(extension))) return "cpp";
  if (lower.endsWith(".cs")) return "csharp";
  if (lower.endsWith(".rb")) return "ruby";
  if (lower.endsWith(".php")) return "php";
  if (lower.endsWith(".lua")) return "lua";
  if (lower.endsWith(".sql")) return "sql";
  return undefined;
}

function relationIdentity(from: string, to: string): string {
  return `${from}->contains->${to}`;
}

function mergeProvenance(
  existing: readonly CodeFactProvenance[] | undefined,
  addition: CodeFactProvenance,
): CodeFactProvenance[] {
  const byProvider = new Map((existing ?? []).map((entry) => [entry.providerId, entry] as const));
  byProvider.set(addition.providerId, addition);
  return [...byProvider.values()].sort((left, right) => left.providerId.localeCompare(right.providerId));
}

/**
 * Merge a provider-independent repository file inventory into the semantic graph.
 * File nodes are canonical even when no semantic provider understands their language.
 * Existing provider containment wins; this function only attaches otherwise-top-level
 * located symbols to their owning file.
 */
export function materializeCodeFileHierarchy(
  graph: CodeGraphSnapshot,
  inventory: readonly CodeFileInventoryEntry[],
): CodeGraphSnapshot {
  const nodes = graph.nodes.map((node) => ({ ...node }));
  const relations = graph.relations.map((relation) => ({ ...relation }));
  const fileNodeByPath = new Map<string, CodeNode>();
  const existingNodeIds = new Set(nodes.map((node) => node.id));
  const existingRelationIds = new Set(relations.map((relation) => relation.id));

  for (const node of nodes) {
    if (node.kind !== "file" || !node.location?.path) continue;
    fileNodeByPath.set(normalizedPath(node.location.path), node);
  }

  const inventoryByPath = new Map<string, CodeFileInventoryEntry>();
  const actualInventoryPaths = new Set<string>();
  for (const entry of inventory) {
    const path = normalizedPath(entry.path);
    if (!path) continue;
    actualInventoryPaths.add(path);
    inventoryByPath.set(path, { path, ...(entry.language ? { language: entry.language } : {}) });
  }
  for (const node of nodes) {
    if (!node.location?.path) continue;
    const path = normalizedPath(node.location.path);
    if (!inventoryByPath.has(path)) inventoryByPath.set(path, { path });
  }

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    if (node.kind !== "file" || !node.location?.path) continue;
    const path = normalizedPath(node.location.path);
    if (!actualInventoryPaths.has(path)) continue;
    const annotated: CodeNode = {
      ...node,
      provenance: mergeProvenance(node.provenance, FILE_INVENTORY_PROVENANCE),
    };
    nodes[index] = annotated;
    fileNodeByPath.set(path, annotated);
  }

  for (const entry of [...inventoryByPath.values()].sort((left, right) => left.path.localeCompare(right.path))) {
    if (fileNodeByPath.has(entry.path)) continue;
    const canonicalIdentity = `file:${entry.path}`;
    const id = stableId("node", canonicalIdentity);
    if (existingNodeIds.has(id)) continue;
    const language = entry.language
      ?? nodes.find((node) => node.location && normalizedPath(node.location.path) === entry.path && node.language)?.language
      ?? inferCodeLanguageFromPath(entry.path);
    const fileNode: CodeNode = {
      id,
      kind: "file",
      name: posix.basename(entry.path),
      canonicalIdentity,
      ...(language ? { language } : {}),
      location: { path: entry.path },
      provenance: [actualInventoryPaths.has(entry.path) ? FILE_INVENTORY_PROVENANCE : FILE_HIERARCHY_PROVENANCE],
    };
    nodes.push(fileNode);
    existingNodeIds.add(id);
    fileNodeByPath.set(entry.path, fileNode);
  }

  const hasIncomingContainment = new Set(
    relations.filter((relation) => relation.kind === "contains").map((relation) => relation.to),
  );
  for (const node of nodes) {
    if (node.kind === "file" || !node.location?.path || hasIncomingContainment.has(node.id)) continue;
    const fileNode = fileNodeByPath.get(normalizedPath(node.location.path));
    if (!fileNode || fileNode.id === node.id) continue;
    const identity = relationIdentity(fileNode.id, node.id);
    const id = stableId("relation", identity);
    if (existingRelationIds.has(id)) continue;
    const relation: CodeRelation = {
      id,
      from: fileNode.id,
      to: node.id,
      kind: "contains",
      confidence: 1,
      provenance: [FILE_HIERARCHY_PROVENANCE],
    };
    relations.push(relation);
    existingRelationIds.add(id);
  }

  const snapshot: CodeGraphSnapshot = {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId: graph.projectId,
    rootPath: graph.rootPath,
    indexedAt: graph.indexedAt,
    nodes,
    relations,
    ...(graph.coverage ? { coverage: graph.coverage } : {}),
  };
  assertValidCodeGraphSnapshot(snapshot);
  return snapshot;
}
