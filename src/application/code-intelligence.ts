export const CODE_GRAPH_SCHEMA_VERSION = 1 as const;

export const CODE_NODE_KINDS = [
  "file",
  "module",
  "namespace",
  "class",
  "interface",
  "function",
  "method",
  "constructor",
  "property",
  "variable",
  "type",
  "enum",
  "package",
  "unknown",
] as const;

export type CodeNodeKind = (typeof CODE_NODE_KINDS)[number];

export const CODE_RELATION_KINDS = [
  "calls",
  "depends_on",
  "implements",
  "overrides",
  "extends",
  "references_type",
  "instantiates",
  "imports",
  "contains",
  "reads",
  "writes",
  "unknown",
] as const;

export type CodeRelationKind = (typeof CODE_RELATION_KINDS)[number];

export const CODE_FILE_CHANGE_KINDS = ["added", "modified", "deleted"] as const;
export type CodeFileChangeKind = (typeof CODE_FILE_CHANGE_KINDS)[number];

export interface CodeSourceLocation {
  path: string;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
}

export interface CodeEvidence {
  location: CodeSourceLocation;
  label?: string;
}

export interface CodeNode {
  /** Stable QuestBoard-facing identity. Never expose a backend-native node id here. */
  id: string;
  kind: CodeNodeKind;
  name: string;
  /** Stable language-aware identity such as a qualified symbol name or canonical file path. */
  canonicalIdentity: string;
  language?: string;
  location?: CodeSourceLocation;
  signature?: string;
  exported?: boolean;
}

export interface CodeRelation {
  /** Stable QuestBoard-facing identity. Never expose a backend-native edge id here. */
  id: string;
  from: string;
  to: string;
  kind: CodeRelationKind;
  /** Normalized confidence in the inclusive range 0..1. */
  confidence: number;
  evidence?: readonly CodeEvidence[];
}

export interface CodeGraphSnapshot {
  schemaVersion: typeof CODE_GRAPH_SCHEMA_VERSION;
  projectId: string;
  rootPath: string;
  indexedAt: string;
  nodes: readonly CodeNode[];
  relations: readonly CodeRelation[];
}

export interface CodeFileChange {
  path: string;
  kind: CodeFileChangeKind;
}

export interface CodeIndexRequest {
  projectId: string;
  rootPath: string;
  /** Omit for a full index. Providers may use this hint for incremental refresh. */
  changes?: readonly CodeFileChange[];
}

export interface CodeIntelligenceCapabilities {
  incrementalIndexing: boolean;
  impactAnalysis: boolean;
  callTrace: boolean;
}

/**
 * Vendor-neutral application port for code intelligence backends.
 *
 * Adapters are responsible for translating backend-native ids, edge kinds,
 * confidence, and diagnostics before returning a snapshot through this port.
 */
export interface CodeIntelligenceProvider {
  /** Stable adapter identity for diagnostics/UI; never changes graph semantics. */
  readonly providerId?: string;
  readonly capabilities: CodeIntelligenceCapabilities;
  indexProject(request: CodeIndexRequest): Promise<CodeGraphSnapshot>;
}

export type CodeGraphValidationIssueCode =
  | "schema_version"
  | "project_id"
  | "root_path"
  | "indexed_at"
  | "duplicate_node_id"
  | "duplicate_relation_id"
  | "dangling_relation"
  | "invalid_confidence"
  | "invalid_location";

export interface CodeGraphValidationIssue {
  code: CodeGraphValidationIssueCode;
  message: string;
}

function validateLocation(location: CodeSourceLocation, owner: string, issues: CodeGraphValidationIssue[]): void {
  if (!location.path.trim()) {
    issues.push({ code: "invalid_location", message: `${owner} has an empty source path` });
  }
  for (const [name, value] of [
    ["startLine", location.startLine],
    ["startColumn", location.startColumn],
    ["endLine", location.endLine],
    ["endColumn", location.endColumn],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      issues.push({ code: "invalid_location", message: `${owner} has invalid ${name}: ${value}` });
    }
  }
}

export function validateCodeGraphSnapshot(snapshot: CodeGraphSnapshot): CodeGraphValidationIssue[] {
  const issues: CodeGraphValidationIssue[] = [];

  if (snapshot.schemaVersion !== CODE_GRAPH_SCHEMA_VERSION) {
    issues.push({
      code: "schema_version",
      message: `Unsupported code graph schema version: ${snapshot.schemaVersion}`,
    });
  }
  if (!snapshot.projectId.trim()) {
    issues.push({ code: "project_id", message: "Code graph projectId must not be empty" });
  }
  if (!snapshot.rootPath.trim()) {
    issues.push({ code: "root_path", message: "Code graph rootPath must not be empty" });
  }
  if (Number.isNaN(Date.parse(snapshot.indexedAt))) {
    issues.push({ code: "indexed_at", message: `Invalid indexedAt timestamp: ${snapshot.indexedAt}` });
  }

  const nodeIds = new Set<string>();
  for (const node of snapshot.nodes) {
    if (nodeIds.has(node.id)) {
      issues.push({ code: "duplicate_node_id", message: `Duplicate code node id: ${node.id}` });
    }
    nodeIds.add(node.id);
    if (node.location) {
      validateLocation(node.location, `Node ${node.id}`, issues);
    }
  }

  const relationIds = new Set<string>();
  for (const relation of snapshot.relations) {
    if (relationIds.has(relation.id)) {
      issues.push({ code: "duplicate_relation_id", message: `Duplicate code relation id: ${relation.id}` });
    }
    relationIds.add(relation.id);

    if (!nodeIds.has(relation.from) || !nodeIds.has(relation.to)) {
      issues.push({
        code: "dangling_relation",
        message: `Relation ${relation.id} references missing node(s): ${relation.from} -> ${relation.to}`,
      });
    }
    if (!Number.isFinite(relation.confidence) || relation.confidence < 0 || relation.confidence > 1) {
      issues.push({
        code: "invalid_confidence",
        message: `Relation ${relation.id} has invalid confidence: ${relation.confidence}`,
      });
    }
    for (const evidence of relation.evidence ?? []) {
      validateLocation(evidence.location, `Relation ${relation.id} evidence`, issues);
    }
  }

  return issues;
}

export function assertValidCodeGraphSnapshot(snapshot: CodeGraphSnapshot): void {
  const issues = validateCodeGraphSnapshot(snapshot);
  if (issues.length > 0) {
    throw new Error(`Invalid code graph snapshot: ${issues.map((issue) => issue.message).join("; ")}`);
  }
}
