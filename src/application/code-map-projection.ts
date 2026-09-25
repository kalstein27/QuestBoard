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

export interface CodeArchitectureProjection {
  projectId: string;
  sourceIndexedAt: string;
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

export function classifyCodeArchitectureNode(node: CodeNode): CodeArchitectureNodeKind | undefined {
  const path = normalizedPath(node);
  const name = node.name.toLowerCase();

  if (path.includes("/storage/sqlite/") || path.startsWith("src/storage/sqlite/")) {
    return "sqlite_repository";
  }

  if (
    (path.includes("/application/") || path.startsWith("src/application/")) &&
    (node.kind === "interface" || name.includes("repository")) &&
    (name.includes("repository") || path.includes("repository"))
  ) {
    return "repository_contract";
  }

  if (path.includes("/application/") || path.startsWith("src/application/")) {
    if (name.includes("service") || path.includes("service")) {
      return "application_service";
    }
  }

  if (
    (path.includes("/server/") || path.startsWith("src/server/")) &&
    (path.includes("http") || name.includes("http") || name.includes("request"))
  ) {
    return "http_api";
  }

  if (
    path.includes("/adapters/") ||
    path.startsWith("src/adapters/")
  ) {
    if (
      path.includes("agent") ||
      path.includes("mcp") ||
      path.includes("cli") ||
      name.includes("agent") ||
      name.includes("mcp")
    ) {
      return "agent_mcp";
    }
  }

  return undefined;
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

export function projectCodeArchitecture(graph: CodeGraphSnapshot): CodeArchitectureProjection {
  const memberKinds = new Map<string, CodeArchitectureNodeKind>();
  const groupedMembers = new Map<CodeArchitectureNodeKind, string[]>();

  for (const node of graph.nodes) {
    const kind = classifyCodeArchitectureNode(node);
    if (!kind) continue;
    memberKinds.set(node.id, kind);
    const members = groupedMembers.get(kind) ?? [];
    members.push(node.id);
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
    nodes,
    relations,
  };
}
