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

export const CODE_ARCHITECTURE_SPARSE_REASONS = ["no_groups", "single_group", "no_relations", "overcompressed"] as const;
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
  diagnostics?: CodeArchitectureProjectionDiagnostics;
}

export interface CodeArchitectureProjection {
  projectId: string;
  sourceIndexedAt: string;
  quality: CodeArchitectureProjectionQuality;
  nodes: readonly CodeArchitectureNode[];
  relations: readonly CodeArchitectureRelation[];
  /** Optional source-subsystem hints, never architecture node IDs for Investigation sync. */
  subsystems?: CodeArchitectureSubsystemLens;
}

export interface CodeArchitectureProjectionDiagnostics {
  /** Locatable, project-local, non-document-local architecture candidate symbols. */
  sourceSymbolCount: number;
  /** Source symbols included in one of the stable six role groups. */
  representedSymbolCount: number;
  sourceRelationCount: number;
  /** Unique raw relation IDs backing projected architecture relations. */
  evidencedRelationCount: number;
  symbolsPerGroup: number;
  symbolCoverageRatio: number;
  relationEvidenceRatio: number;
}

export interface CodeArchitectureSubsystem {
  /** A source directory prefix (e.g. src/server), not a code:node or code-map:node ID. */
  pathPrefix: string;
  fileCount: number;
  symbolCount: number;
  /** Up to five canonical raw Code Map symbol anchors for drill-down. */
  sampleNodeIds: readonly string[];
}

export interface CodeArchitectureSubsystemRelation {
  fromPathPrefix: string;
  toPathPrefix: string;
  kind: "calls";
  sourceRelationCount: number;
  /** Evidence is bounded independently of the total observed count. */
  sourceRelationIds: readonly string[];
}

export interface CodeArchitectureSubsystemLens {
  nodes: readonly CodeArchitectureSubsystem[];
  relations: readonly CodeArchitectureSubsystemRelation[];
  truncated: boolean;
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

function externalArchitectureTokens(node: CodeNode): ReadonlySet<string> {
  const text = `${node.canonicalIdentity} ${node.name}`
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

function isProjectArchitectureCandidate(node: CodeNode): boolean {
  return isArchitectureSymbol(node)
    && Boolean(node.location?.path)
    && !node.canonicalIdentity.includes(":local ");
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


  for (const relation of graph.relations) {
    if (relation.kind !== "instantiates") continue;
    if (kinds.get(relation.from) !== "sqlite_repository" || kinds.has(relation.to)) continue;
    const target = nodesById.get(relation.to);
    if (!target || target.location) continue;
    const tokens = externalArchitectureTokens(target);
    if (!tokens.has("sqlite")) continue;
    kinds.set(target.id, "sqlite");
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

  if (
    relation.kind === "instantiates" &&
    fromKind === "sqlite_repository" &&
    toKind === "sqlite"
  ) {
    return { kind: "persists_to" };
  }

  return undefined;
}

function sourceSubsystemPath(path: string): string | undefined {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized.startsWith("/") || normalized.split("/").some((part) => part === "..")) return undefined;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length < 2 || ["tests", "test", "fixtures", "vendor", "node_modules", "dist", "build"].includes(parts[0]!)) return undefined;
  return parts[0] === "src" && parts.length >= 3 ? `src/${parts[1]}` : parts[0];
}

function projectSourceSubsystems(graph: CodeGraphSnapshot): CodeArchitectureSubsystemLens {
  const byPath = new Map<string, { files: Set<string>; nodeIds: string[] }>();
  const nodeSubsystem = new Map<string, string>();
  for (const node of graph.nodes) {
    if (!isProjectArchitectureCandidate(node)) continue;
    const path = node.location!.path;
    const prefix = sourceSubsystemPath(path);
    if (!prefix) continue;
    const entry = byPath.get(prefix) ?? { files: new Set<string>(), nodeIds: [] };
    entry.files.add(path);
    entry.nodeIds.push(node.id);
    byPath.set(prefix, entry);
    nodeSubsystem.set(node.id, prefix);
  }
  const MAX_SUBSYSTEMS = 12;
  const MAX_SUBSYSTEM_RELATIONS = 24;
  const allNodes = [...byPath.entries()]
    .map(([pathPrefix, entry]) => ({
      pathPrefix,
      fileCount: entry.files.size,
      symbolCount: entry.nodeIds.length,
      sampleNodeIds: [...entry.nodeIds].sort().slice(0, 5),
    }))
    .sort((left, right) => right.fileCount - left.fileCount
      || right.symbolCount - left.symbolCount
      || left.pathPrefix.localeCompare(right.pathPrefix));
  const nodes = allNodes.slice(0, MAX_SUBSYSTEMS);
  const selected = new Set(nodes.map((node) => node.pathPrefix));
  const edgeEvidence = new Map<string, CodeArchitectureSubsystemRelation>();
  for (const relation of graph.relations) {
    if (relation.kind !== "calls") continue;
    const fromPathPrefix = nodeSubsystem.get(relation.from);
    const toPathPrefix = nodeSubsystem.get(relation.to);
    if (!fromPathPrefix || !toPathPrefix || fromPathPrefix === toPathPrefix
      || !selected.has(fromPathPrefix) || !selected.has(toPathPrefix)) continue;
    const key = `${fromPathPrefix}\0${toPathPrefix}`;
    const existing = edgeEvidence.get(key);
    if (existing) {
      existing.sourceRelationCount += 1;
      if (existing.sourceRelationIds.length < 16) {
        (existing.sourceRelationIds as string[]).push(relation.id);
      }
    } else {
      edgeEvidence.set(key, {
        fromPathPrefix,
        toPathPrefix,
        kind: "calls",
        sourceRelationCount: 1,
        sourceRelationIds: [relation.id],
      });
    }
  }
  const allRelations = [...edgeEvidence.values()]
    .sort((left, right) => right.sourceRelationCount - left.sourceRelationCount
      || left.fromPathPrefix.localeCompare(right.fromPathPrefix)
      || left.toPathPrefix.localeCompare(right.toPathPrefix));
  return {
    nodes,
    relations: allRelations.slice(0, MAX_SUBSYSTEM_RELATIONS),
    truncated: allNodes.length > MAX_SUBSYSTEMS || allRelations.length > MAX_SUBSYSTEM_RELATIONS,
  };
}

function projectionQuality(
  nodes: readonly CodeArchitectureNode[],
  relations: readonly CodeArchitectureRelation[],
  graph: CodeGraphSnapshot,
): CodeArchitectureProjectionQuality {
  const groupCount = nodes.length;
  const relationCount = relations.length;
  const candidates = new Set(graph.nodes.filter(isProjectArchitectureCandidate).map((node) => node.id));
  const sourceSymbolCount = candidates.size;
  const representedSymbolCount = new Set(nodes.flatMap((node) =>
    node.memberNodeIds.filter((id) => candidates.has(id)))).size;
  const evidencedRelationCount = new Set(relations.flatMap((relation) => relation.sourceRelationIds)).size;
  const sourceRelationCount = graph.relations.length;
  const symbolsPerGroup = groupCount > 0 ? sourceSymbolCount / groupCount : 0;
  const symbolCoverageRatio = sourceSymbolCount > 0 ? representedSymbolCount / sourceSymbolCount : 0;
  const relationEvidenceRatio = sourceRelationCount > 0 ? evidencedRelationCount / sourceRelationCount : 0;
  const diagnostics = sourceSymbolCount >= 200 ? {
    sourceSymbolCount,
    representedSymbolCount,
    sourceRelationCount,
    evidencedRelationCount,
    symbolsPerGroup,
    symbolCoverageRatio,
    relationEvidenceRatio,
  } : undefined;
  const metadata = { groupCount, relationCount, ...(diagnostics ? { diagnostics } : {}) };
  if (groupCount === 0) return { status: "sparse", reason: "no_groups", ...metadata };
  if (groupCount === 1) return { status: "sparse", reason: "single_group", ...metadata };
  if (relationCount === 0) return { status: "sparse", reason: "no_relations", ...metadata };
  if (symbolsPerGroup >= 100 && sourceSymbolCount >= 200
    && (symbolCoverageRatio < 0.5 || relationEvidenceRatio < 0.05)) {
    return { status: "sparse", reason: "overcompressed", ...metadata };
  }
  return { status: "useful", ...metadata };
}

export function projectCodeArchitecture(graph: CodeGraphSnapshot): CodeArchitectureProjection {
  const memberKinds = inferCodeArchitectureNodeKinds(graph);
  const groupedMembers = new Map<CodeArchitectureNodeKind, string[]>();

  for (const [nodeId, kind] of memberKinds) {
    const members = groupedMembers.get(kind) ?? [];
    members.push(nodeId);
    groupedMembers.set(kind, members);
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
    quality: projectionQuality(nodes, relations, graph),
    nodes,
    relations,
    ...(graph.nodes.filter(isProjectArchitectureCandidate).length >= 200
      ? { subsystems: projectSourceSubsystems(graph) }
      : {}),
  };
}
