import { createHash } from "node:crypto";
import type { CodeGraphSnapshot, CodeNode, CodeRelation } from "./code-intelligence.js";

export const CODE_ARCHITECTURE_NODE_KINDS = [
  "http_api",
  "agent_mcp",
  "application_service",
  "repository_contract",
  "sqlite_repository",
  "sqlite",
] as const;

export type CodeArchitectureNodeKind = (typeof CODE_ARCHITECTURE_NODE_KINDS)[number];

export const CODE_ARCHITECTURE_RELATION_KINDS = [
  "invokes",
  "depends_on_contract",
  "implemented_by",
  "persists_to",
] as const;

export type CodeArchitectureRelationKind = (typeof CODE_ARCHITECTURE_RELATION_KINDS)[number];

export const CODE_ARCHITECTURE_PROJECTION_QUALITY_STATUSES = ["useful", "sparse"] as const;
export type CodeArchitectureProjectionQualityStatus = (typeof CODE_ARCHITECTURE_PROJECTION_QUALITY_STATUSES)[number];

export const CODE_ARCHITECTURE_SPARSE_REASONS = ["no_groups", "single_group", "no_relations"] as const;
export type CodeArchitectureSparseReason = (typeof CODE_ARCHITECTURE_SPARSE_REASONS)[number];

export interface CodeArchitectureNode {
  id: string;
  kind: CodeArchitectureNodeKind;
  title: string;
  memberNodeIds: readonly string[];
}

export interface CodeArchitectureRelation {
  id: string;
  from: string;
  to: string;
  kind: CodeArchitectureRelationKind;
  sourceRelationIds: readonly string[];
}

export interface CodeArchitectureProjectionQuality {
  status: CodeArchitectureProjectionQualityStatus;
  groupCount: number;
  relationCount: number;
  reason?: CodeArchitectureSparseReason;
}

export interface CodeArchitectureProjection {
  projectId: string;
  sourceIndexedAt: string;
  quality: CodeArchitectureProjectionQuality;
  nodes: readonly CodeArchitectureNode[];
  relations: readonly CodeArchitectureRelation[];
}

const ARCHITECTURE_TITLES: Record<CodeArchitectureNodeKind, string> = {
  http_api: "HTTP API",
  agent_mcp: "Agent / MCP",
  application_service: "Application Service",
  repository_contract: "Repository Contract",
  sqlite_repository: "SQLite Repository",
  sqlite: "SQLite",
};

function stableProjectionId(namespace: "node" | "relation", value: string): string {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 20);
  return `code-map:${namespace}:${digest}`;
}

function normalizedPath(node: CodeNode): string {
  return node.location?.path.replaceAll("\\", "/").toLowerCase() ?? "";
}

const ARCHITECTURE_SYMBOL_KINDS = new Set<CodeNode["kind"]>([
  "module",
  "namespace",
  "class",
  "interface",
  "function",
  "method",
  "constructor",
  "type",
  "enum",
]);

function architectureTokens(node: CodeNode): ReadonlySet<string> {
  const text = `${node.location?.path ?? ""} ${node.name}`
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return new Set(text.split(/[^a-z0-9]+/).filter(Boolean));
}

function hasArchitectureToken(tokens: ReadonlySet<string>, values: readonly string[]): boolean {
  return values.some((value) => tokens.has(value));
}

function isArchitectureSymbol(node: CodeNode): boolean {
  return ARCHITECTURE_SYMBOL_KINDS.has(node.kind);
}

export function classifyCodeArchitectureNode(node: CodeNode): CodeArchitectureNodeKind | undefined {
  const tokens = architectureTokens(node);
  if (!isArchitectureSymbol(node)) return undefined;

  if (
    tokens.has("sqlite")
    && hasArchitectureToken(tokens, ["repository", "storage", "store", "database", "db"])
  ) {
    return "sqlite_repository";
  }

  if (
    (node.kind === "interface" || node.kind === "type")
    && hasArchitectureToken(tokens, ["repository", "store", "gateway", "port"])
  ) {
    return "repository_contract";
  }

  if (hasArchitectureToken(tokens, ["mcp", "agent", "cli"])) {
    return "agent_mcp";
  }

  if (hasArchitectureToken(tokens, ["http", "route", "router"])) {
    return "http_api";
  }

  if (hasArchitectureToken(tokens, ["service", "manager", "controller", "coordinator", "orchestrator"])) {
    return "application_service";
  }

  return undefined;
}

function inferCodeArchitectureNodeKinds(graph: CodeGraphSnapshot): Map<string, CodeArchitectureNodeKind> {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const kinds = new Map<string, CodeArchitectureNodeKind>();

  for (const node of graph.nodes) {
    const kind = classifyCodeArchitectureNode(node);
    if (kind) kinds.set(node.id, kind);
  }

  for (const relation of graph.relations) {
    if (relation.kind !== "calls") continue;
    const fromKind = kinds.get(relation.from);
    if (fromKind !== "http_api" && fromKind !== "agent_mcp") continue;
    if (kinds.has(relation.to)) continue;
    const from = nodesById.get(relation.from);
    const to = nodesById.get(relation.to);
    if (!from || !to || !isArchitectureSymbol(to)) continue;
    const fromPath = normalizedPath(from);
    const toPath = normalizedPath(to);
    if (!fromPath || !toPath || fromPath === toPath) continue;
    if (to.canonicalIdentity.includes(":local ")) continue;
    kinds.set(to.id, "application_service");
  }

  return kinds;
}

function architectureRelationKind(
  relation: CodeRelation,
  fromKind: CodeArchitectureNodeKind,
  toKind: CodeArchitectureNodeKind,
): { kind: CodeArchitectureRelationKind; reverse?: boolean } | undefined {
  if (
    relation.kind === "calls" &&
    (fromKind === "http_api" || fromKind === "agent_mcp") &&
    toKind === "application_service"
  ) {
    return { kind: "invokes" };
  }

  if (
    fromKind === "application_service" &&
    toKind === "repository_contract" &&
    ["calls", "depends_on", "references_type"].includes(relation.kind)
  ) {
    return { kind: "depends_on_contract" };
  }

  if (
    fromKind === "sqlite_repository" &&
    toKind === "repository_contract" &&
    ["implements", "overrides", "depends_on"].includes(relation.kind)
  ) {
    return { kind: "implemented_by", reverse: true };
  }

  if (
    fromKind === "repository_contract" &&
    toKind === "sqlite_repository" &&
    ["implements", "overrides", "depends_on"].includes(relation.kind)
  ) {
    return { kind: "implemented_by" };
  }

  return undefined;
}

function projectionQuality(
  nodes: readonly CodeArchitectureNode[],
  relations: readonly CodeArchitectureRelation[],
): CodeArchitectureProjectionQuality {
  const groupCount = nodes.length;
  const relationCount = relations.length;
  if (groupCount === 0) return { status: "sparse", reason: "no_groups", groupCount, relationCount };
  if (groupCount === 1) return { status: "sparse", reason: "single_group", groupCount, relationCount };
  if (relationCount === 0) return { status: "sparse", reason: "no_relations", groupCount, relationCount };
  return { status: "useful", groupCount, relationCount };
}

export function projectCodeArchitecture(graph: CodeGraphSnapshot): CodeArchitectureProjection {
  const memberKinds = inferCodeArchitectureNodeKinds(graph);
  const groupedMembers = new Map<CodeArchitectureNodeKind, string[]>();

  for (const [nodeId, kind] of memberKinds) {
    const members = groupedMembers.get(kind) ?? [];
    members.push(nodeId);
    groupedMembers.set(kind, members);
  }

  if (groupedMembers.has("sqlite_repository")) {
    groupedMembers.set("sqlite", []);
  }

  const nodes: CodeArchitectureNode[] = CODE_ARCHITECTURE_NODE_KINDS.flatMap((kind) => {
    const members = groupedMembers.get(kind);
    if (!members) return [];
    return [
      {
        id: stableProjectionId("node", `${graph.projectId}:${kind}`),
        kind,
        title: ARCHITECTURE_TITLES[kind],
        memberNodeIds: [...members].sort(),
      },
    ];
  });
  const nodeByKind = new Map(nodes.map((node) => [node.kind, node] as const));

  const relationEvidence = new Map<
    string,
    { from: string; to: string; kind: CodeArchitectureRelationKind; sourceRelationIds: string[] }
  >();

  for (const relation of graph.relations) {
    const fromKind = memberKinds.get(relation.from);
    const toKind = memberKinds.get(relation.to);
    if (!fromKind || !toKind || fromKind === toKind) continue;
    const projected = architectureRelationKind(relation, fromKind, toKind);
    if (!projected) continue;

    const projectedFromKind = projected.reverse ? toKind : fromKind;
    const projectedToKind = projected.reverse ? fromKind : toKind;
    const from = nodeByKind.get(projectedFromKind);
    const to = nodeByKind.get(projectedToKind);
    if (!from || !to) continue;

    const key = `${from.id}:${projected.kind}:${to.id}`;
    const existing = relationEvidence.get(key);
    if (existing) {
      existing.sourceRelationIds.push(relation.id);
    } else {
      relationEvidence.set(key, {
        from: from.id,
        to: to.id,
        kind: projected.kind,
        sourceRelationIds: [relation.id],
      });
    }
  }

  const sqliteRepository = nodeByKind.get("sqlite_repository");
  const sqlite = nodeByKind.get("sqlite");
  if (sqliteRepository && sqlite) {
    const key = `${sqliteRepository.id}:persists_to:${sqlite.id}`;
    relationEvidence.set(key, {
      from: sqliteRepository.id,
      to: sqlite.id,
      kind: "persists_to",
      sourceRelationIds: [],
    });
  }

  const relations: CodeArchitectureRelation[] = [...relationEvidence.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, relation]) => ({
      id: stableProjectionId("relation", `${graph.projectId}:${key}`),
      from: relation.from,
      to: relation.to,
      kind: relation.kind,
      sourceRelationIds: [...relation.sourceRelationIds].sort(),
    }));

  return {
    projectId: graph.projectId,
    sourceIndexedAt: graph.indexedAt,
    quality: projectionQuality(nodes, relations),
    nodes,
    relations,
  };
}
