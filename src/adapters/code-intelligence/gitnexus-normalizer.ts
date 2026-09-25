import { createHash } from "node:crypto";
import {
  CODE_GRAPH_SCHEMA_VERSION,
  assertValidCodeGraphSnapshot,
  type CodeGraphSnapshot,
  type CodeNode,
  type CodeNodeKind,
  type CodeRelation,
  type CodeRelationKind,
} from "../../application/code-intelligence.js";

export interface GitNexusNodeRow {
  uid: string;
  kind: string;
  name: string;
  filePath?: string;
  qualifiedName?: string;
  startLine?: number;
  endLine?: number;
  language?: string;
  signature?: string;
  exported?: boolean;
}

export interface GitNexusRelationRow {
  fromUid: string;
  toUid: string;
  type: string;
  confidence?: number;
  reason?: string;
}

export interface GitNexusGraphRows {
  nodes: readonly GitNexusNodeRow[];
  relations: readonly GitNexusRelationRow[];
}

export interface NormalizeGitNexusGraphInput extends GitNexusGraphRows {
  projectId: string;
  rootPath: string;
  indexedAt: string;
}

function stableId(namespace: "node" | "relation", value: string): string {
  return `code:${namespace}:${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function normalizeNodeKind(kind: string): CodeNodeKind {
  switch (kind.trim().toLowerCase()) {
    case "file":
      return "file";
    case "module":
      return "module";
    case "namespace":
      return "namespace";
    case "class":
      return "class";
    case "interface":
      return "interface";
    case "function":
      return "function";
    case "method":
      return "method";
    case "constructor":
      return "constructor";
    case "property":
    case "field":
      return "property";
    case "variable":
    case "const":
      return "variable";
    case "type":
    case "typealias":
      return "type";
    case "enum":
      return "enum";
    case "package":
    case "folder":
      return "package";
    default:
      return "unknown";
  }
}

function canonicalNodeIdentity(row: GitNexusNodeRow): string {
  const kind = normalizeNodeKind(row.kind);
  const path = row.filePath?.trim();
  if (kind === "file" && path) {
    return `file:${path}`;
  }
  const symbol = row.qualifiedName?.trim() || row.name.trim();
  const owner = path || "<external>";
  const disambiguator = row.qualifiedName ? "" : row.startLine ? `@${row.startLine}` : "";
  return `${owner}#${kind}:${symbol}${disambiguator}`;
}

function normalizeRelationKind(type: string, reason?: string): CodeRelationKind {
  switch (type.trim().toUpperCase()) {
    case "CALLS":
      return "calls";
    case "EXTENDS":
      return "extends";
    case "IMPLEMENTS":
      return "implements";
    case "METHOD_OVERRIDES":
    case "OVERRIDES":
      return "overrides";
    case "TYPE_REF":
    case "REFERENCES_TYPE":
      return "references_type";
    case "INSTANTIATES":
      return "instantiates";
    case "IMPORTS":
      return "imports";
    case "ACCESSES": {
      const normalizedReason = reason?.trim().toLowerCase();
      if (normalizedReason === "write") return "writes";
      if (normalizedReason === "read") return "reads";
      return "depends_on";
    }
    case "HAS_METHOD":
    case "HAS_PROPERTY":
    case "MEMBER_OF":
    case "STEP_IN_PROCESS":
      return "contains";
    case "INJECTS":
      return "depends_on";
    default:
      return "unknown";
  }
}

function normalizeConfidence(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 1;
  }
  return Math.max(0, Math.min(1, value));
}

export function normalizeGitNexusGraph(input: NormalizeGitNexusGraphInput): CodeGraphSnapshot {
  const nativeToNormalizedId = new Map<string, string>();
  const nodes: CodeNode[] = input.nodes.map((row) => {
    const canonicalIdentity = canonicalNodeIdentity(row);
    const id = stableId("node", canonicalIdentity);
    nativeToNormalizedId.set(row.uid, id);

    const location = row.filePath
      ? {
          path: row.filePath,
          ...(row.startLine ? { startLine: row.startLine } : {}),
          ...(row.endLine ? { endLine: row.endLine } : {}),
        }
      : undefined;

    return {
      id,
      kind: normalizeNodeKind(row.kind),
      name: row.name,
      canonicalIdentity,
      ...(row.language ? { language: row.language } : {}),
      ...(location ? { location } : {}),
      ...(row.signature ? { signature: row.signature } : {}),
      ...(row.exported !== undefined ? { exported: row.exported } : {}),
    };
  });

  const relations: CodeRelation[] = input.relations.map((row) => {
    const from = nativeToNormalizedId.get(row.fromUid);
    const to = nativeToNormalizedId.get(row.toUid);
    if (!from || !to) {
      throw new Error(
        `GitNexus relation references an unknown node: ${row.fromUid} -> ${row.toUid}`,
      );
    }
    const kind = normalizeRelationKind(row.type, row.reason);
    const identity = `${from}->${kind}->${to}:${row.reason ?? ""}`;
    return {
      id: stableId("relation", identity),
      from,
      to,
      kind,
      confidence: normalizeConfidence(row.confidence),
    };
  });

  const snapshot: CodeGraphSnapshot = {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId: input.projectId,
    rootPath: input.rootPath,
    indexedAt: input.indexedAt,
    nodes,
    relations,
  };
  assertValidCodeGraphSnapshot(snapshot);
  return snapshot;
}
