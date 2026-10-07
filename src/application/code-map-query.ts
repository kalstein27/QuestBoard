import {
  CODE_NODE_KINDS,
  CODE_RELATION_KINDS,
  normalizeCodeLanguage,
  type CodeGraphSnapshot,
  type CodeNode,
  type CodeNodeKind,
  type CodeRelation,
  type CodeRelationKind,
} from "./code-intelligence.js";

export const CODE_MAP_QUERY_OPERATIONS = [
  "find_nodes",
  "get_node",
  "hierarchy",
  "relations",
  "neighborhood",
] as const;
export type CodeMapQueryOperation = (typeof CODE_MAP_QUERY_OPERATIONS)[number];

export const CODE_MAP_QUERY_DIRECTIONS = ["incoming", "outgoing", "both"] as const;
export type CodeMapQueryDirection = (typeof CODE_MAP_QUERY_DIRECTIONS)[number];

export const CODE_MAP_HIERARCHY_DIRECTIONS = ["parents", "children", "both"] as const;
export type CodeMapHierarchyDirection = (typeof CODE_MAP_HIERARCHY_DIRECTIONS)[number];

export const CODE_MAP_RELATION_SEMANTICS = ["callers", "callees", "references", "referenced_by"] as const;
export type CodeMapRelationSemantic = (typeof CODE_MAP_RELATION_SEMANTICS)[number];

export const CODE_MAP_QUERY_DEFAULT_LIMIT = 20;
export const CODE_MAP_QUERY_MAX_LIMIT = 100;
export const CODE_MAP_QUERY_DEFAULT_DEPTH = 1;
export const CODE_MAP_QUERY_MAX_DEPTH = 4;
export const CODE_MAP_QUERY_MAX_SEEDS = 10;

const REFERENCE_RELATION_KINDS = new Set<CodeRelationKind>([
  "implements",
  "overrides",
  "extends",
  "references_type",
  "instantiates",
  "imports",
  "reads",
  "writes",
]);

// `depends_on` is the conservative fallback for provider references that do
// not carry a more specific role. Keep those raw facts queryable through
// relationKinds, but do not mix them into the higher-signal semantic
// references shortcut by default.

export type CodeMapQueryErrorCode =
  | "code_map_not_indexed"
  | "code_node_not_found"
  | "code_node_ambiguous"
  | "code_map_query_invalid";

export class CodeMapQueryError extends Error {
  constructor(
    readonly code: CodeMapQueryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CodeMapQueryError";
  }
}

export interface CodeMapQueryInput {
  operation: CodeMapQueryOperation;
  query?: string;
  path?: string;
  kinds?: readonly CodeNodeKind[];
  language?: string;
  nodeId?: string;
  canonicalIdentity?: string;
  direction?: CodeMapQueryDirection | CodeMapHierarchyDirection;
  relationKinds?: readonly CodeRelationKind[];
  /** Neighborhoods hide broad external SCIP depends_on edges unless explicitly requested. */
  includeExternalDependencies?: boolean;
  semantic?: CodeMapRelationSemantic;
  nodeIds?: readonly string[];
  depth?: number;
  limit?: number;
}

export interface CodeMapQueryEnvelope {
  projectId: string;
  indexedAt: string;
  /** Provider that produced the semantic snapshot. Per-fact provenance is added separately from this query contract. */
  providerId: string;
  operation: CodeMapQueryOperation;
  limit: number;
  truncated: boolean;
}

export interface CodeMapRelationEntry {
  relation: CodeRelation;
  node: CodeNode;
}

export interface CodeMapHierarchyEntry {
  node: CodeNode;
  depth: number;
  relation: CodeRelation;
}

export type CodeMapQueryResult =
  | (CodeMapQueryEnvelope & {
      operation: "find_nodes";
      nodes: readonly CodeNode[];
      matchedCount: number;
    })
  | (CodeMapQueryEnvelope & {
      operation: "get_node";
      node: CodeNode;
    })
  | (CodeMapQueryEnvelope & {
      operation: "hierarchy";
      node: CodeNode;
      direction: CodeMapHierarchyDirection;
      depth: number;
      entries: readonly CodeMapHierarchyEntry[];
    })
  | (CodeMapQueryEnvelope & {
      operation: "relations";
      node: CodeNode;
      direction: CodeMapQueryDirection;
      semantic?: CodeMapRelationSemantic;
      entries: readonly CodeMapRelationEntry[];
    })
  | (CodeMapQueryEnvelope & {
      operation: "neighborhood";
      seedNodeIds: readonly string[];
      direction: CodeMapQueryDirection;
      depth: number;
      nodes: readonly CodeNode[];
      relations: readonly CodeRelation[];
    });

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return CODE_MAP_QUERY_DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1) {
    throw new CodeMapQueryError("code_map_query_invalid", "limit must be a positive integer");
  }
  return Math.min(value, CODE_MAP_QUERY_MAX_LIMIT);
}

function normalizeDepth(value: number | undefined): number {
  if (value === undefined) return CODE_MAP_QUERY_DEFAULT_DEPTH;
  if (!Number.isInteger(value) || value < 1) {
    throw new CodeMapQueryError("code_map_query_invalid", "depth must be a positive integer");
  }
  return Math.min(value, CODE_MAP_QUERY_MAX_DEPTH);
}

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function normalizedNodeLanguage(node: CodeNode): string {
  return normalizeCodeLanguage(node.language);
}

function queryMatchRank(node: CodeNode, query: string): number {
  const name = node.name.toLocaleLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  return 3;
}

function queryKindRank(node: CodeNode): number {
  switch (node.kind) {
    case "class":
    case "interface":
    case "function":
    case "method":
    case "constructor":
    case "type":
    case "enum":
    case "module":
      return 0;
    case "file":
    case "namespace":
    case "package":
      return 1;
    case "property":
      return 2;
    case "variable":
      return 3;
    case "unknown":
      return 4;
  }
}

function queryFidelityRank(node: CodeNode): number {
  let best = 4;
  for (const provenance of node.provenance ?? []) {
    const rank = provenance.fidelity === "semantic-call"
      ? 0
      : provenance.fidelity === "semantic-reference"
        ? 1
        : provenance.fidelity === "syntax"
          ? 2
          : provenance.fidelity === "file-only"
            ? 3
            : 4;
    best = Math.min(best, rank);
  }
  return best;
}

function requireKnownNodeKind(value: string): asserts value is CodeNodeKind {
  if (!(CODE_NODE_KINDS as readonly string[]).includes(value)) {
    throw new CodeMapQueryError("code_map_query_invalid", `Unknown code node kind: ${value}`);
  }
}

function requireKnownRelationKind(value: string): asserts value is CodeRelationKind {
  if (!(CODE_RELATION_KINDS as readonly string[]).includes(value)) {
    throw new CodeMapQueryError("code_map_query_invalid", `Unknown code relation kind: ${value}`);
  }
}

function nodeSort(left: CodeNode, right: CodeNode): number {
  return (left.location?.path ?? "").localeCompare(right.location?.path ?? "")
    || (left.location?.startLine ?? 0) - (right.location?.startLine ?? 0)
    || left.kind.localeCompare(right.kind)
    || left.name.localeCompare(right.name)
    || left.canonicalIdentity.localeCompare(right.canonicalIdentity)
    || left.id.localeCompare(right.id);
}

function relationSort(left: CodeRelation, right: CodeRelation): number {
  return left.kind.localeCompare(right.kind)
    || left.from.localeCompare(right.from)
    || left.to.localeCompare(right.to)
    || left.id.localeCompare(right.id);
}

function adjacentNodeSort(
  nodeId: string,
  nodeById: ReadonlyMap<string, CodeNode>,
  left: CodeRelation,
  right: CodeRelation,
): number {
  const leftNode = nodeById.get(otherNodeId(left, nodeId));
  const rightNode = nodeById.get(otherNodeId(right, nodeId));
  return (leftNode && rightNode ? nodeSort(leftNode, rightNode) : 0)
    || relationSort(left, right);
}

const NAVIGATION_RELATION_PRIORITY: Record<CodeRelationKind, number> = {
  calls: 0,
  contains: 0,
  implements: 1,
  overrides: 1,
  extends: 1,
  instantiates: 1,
  imports: 2,
  references_type: 2,
  reads: 3,
  writes: 3,
  depends_on: 4,
  unknown: 5,
};

function adjacentRelationSort(
  nodeId: string,
  nodeById: ReadonlyMap<string, CodeNode>,
  left: CodeRelation,
  right: CodeRelation,
): number {
  const leftNode = nodeById.get(otherNodeId(left, nodeId));
  const rightNode = nodeById.get(otherNodeId(right, nodeId));
  return NAVIGATION_RELATION_PRIORITY[left.kind] - NAVIGATION_RELATION_PRIORITY[right.kind]
    || Number(isExternalDependencyNeighbor(left, nodeId, nodeById))
      - Number(isExternalDependencyNeighbor(right, nodeId, nodeById))
    || (leftNode && rightNode ? nodeSort(leftNode, rightNode) : 0)
    || relationSort(left, right);
}

function requireNodeById(graph: CodeGraphSnapshot, nodeId: string | undefined): CodeNode {
  const normalized = normalizeText(nodeId);
  if (!normalized) {
    throw new CodeMapQueryError("code_map_query_invalid", "nodeId is required for this query operation");
  }
  const node = graph.nodes.find((candidate) => candidate.id === normalized);
  if (!node) throw new CodeMapQueryError("code_node_not_found", `Code node not found: ${normalized}`);
  return node;
}

function getExactNode(graph: CodeGraphSnapshot, input: CodeMapQueryInput): CodeNode {
  const nodeId = normalizeText(input.nodeId);
  const canonicalIdentity = normalizeText(input.canonicalIdentity);
  if (Boolean(nodeId) === Boolean(canonicalIdentity)) {
    throw new CodeMapQueryError(
      "code_map_query_invalid",
      "get_node requires exactly one of nodeId or canonicalIdentity",
    );
  }
  if (nodeId) return requireNodeById(graph, nodeId);

  const matches = graph.nodes.filter((node) => node.canonicalIdentity === canonicalIdentity);
  if (matches.length === 0) {
    throw new CodeMapQueryError("code_node_not_found", `Code node not found: ${canonicalIdentity}`);
  }
  if (matches.length > 1) {
    throw new CodeMapQueryError(
      "code_node_ambiguous",
      `Canonical identity matched ${matches.length} code nodes: ${canonicalIdentity}`,
    );
  }
  return matches[0]!;
}

function directionAllows(
  relation: CodeRelation,
  nodeId: string,
  direction: CodeMapQueryDirection,
): boolean {
  return direction === "both"
    || (direction === "outgoing" && relation.from === nodeId)
    || (direction === "incoming" && relation.to === nodeId);
}

function otherNodeId(relation: CodeRelation, nodeId: string): string {
  return relation.from === nodeId ? relation.to : relation.from;
}

function isExternalDependencyNeighbor(
  relation: CodeRelation,
  nodeId: string,
  nodeById: ReadonlyMap<string, CodeNode>,
): boolean {
  return relation.kind === "depends_on"
    && (nodeById.get(otherNodeId(relation, nodeId))?.canonicalIdentity.startsWith("scip-external:") ?? false);
}

function semanticRelationFilter(
  semantic: CodeMapRelationSemantic | undefined,
): { direction: CodeMapQueryDirection; kinds?: ReadonlySet<CodeRelationKind> } | undefined {
  switch (semantic) {
    case undefined:
      return undefined;
    case "callers":
      return { direction: "incoming", kinds: new Set(["calls"]) };
    case "callees":
      return { direction: "outgoing", kinds: new Set(["calls"]) };
    case "references":
      return { direction: "outgoing", kinds: REFERENCE_RELATION_KINDS };
    case "referenced_by":
      return { direction: "incoming", kinds: REFERENCE_RELATION_KINDS };
  }
}

export function queryCodeGraph(
  graph: CodeGraphSnapshot,
  providerId: string,
  input: CodeMapQueryInput,
): CodeMapQueryResult {
  const limit = normalizeLimit(input.limit);
  const envelope = {
    projectId: graph.projectId,
    indexedAt: graph.indexedAt,
    providerId,
    operation: input.operation,
    limit,
  } as const;
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node] as const));

  switch (input.operation) {
    case "find_nodes": {
      const query = normalizeText(input.query)?.toLocaleLowerCase();
      const path = normalizeText(input.path)?.toLocaleLowerCase();
      const language = normalizeText(input.language)?.toLocaleLowerCase();
      const kinds = input.kinds?.map((kind) => {
        requireKnownNodeKind(kind);
        return kind;
      });
      const kindSet = kinds ? new Set(kinds) : undefined;
      const matches = graph.nodes
        .filter((node) => !query
          || node.name.toLocaleLowerCase().includes(query)
          || node.canonicalIdentity.toLocaleLowerCase().includes(query))
        .filter((node) => !path || node.location?.path.toLocaleLowerCase().includes(path))
        .filter((node) => !language || normalizedNodeLanguage(node) === language)
        .filter((node) => !kindSet || kindSet.has(node.kind))
        .sort((left, right) => (query
          ? queryMatchRank(left, query) - queryMatchRank(right, query)
            || queryKindRank(left) - queryKindRank(right)
            || queryFidelityRank(left) - queryFidelityRank(right)
          : 0) || nodeSort(left, right));
      return {
        ...envelope,
        operation: "find_nodes",
        nodes: matches.slice(0, limit),
        matchedCount: matches.length,
        truncated: matches.length > limit,
      };
    }
    case "get_node": {
      const node = getExactNode(graph, input);
      return { ...envelope, operation: "get_node", node, truncated: false };
    }
    case "hierarchy": {
      const node = requireNodeById(graph, input.nodeId);
      const direction = input.direction === undefined ? "both" : input.direction;
      if (!(CODE_MAP_HIERARCHY_DIRECTIONS as readonly string[]).includes(direction)) {
        throw new CodeMapQueryError("code_map_query_invalid", `Invalid hierarchy direction: ${direction}`);
      }
      const hierarchyDirection = direction as CodeMapHierarchyDirection;
      const depth = normalizeDepth(input.depth);
      const entries: CodeMapHierarchyEntry[] = [];
      const visited = new Set([node.id]);
      const queue: Array<{ nodeId: string; depth: number }> = [{ nodeId: node.id, depth: 0 }];
      let truncated = false;

      while (queue.length > 0 && entries.length < limit) {
        const current = queue.shift()!;
        if (current.depth >= depth) continue;
        const relations = graph.relations
          .filter((relation) => relation.kind === "contains")
          .filter((relation) => hierarchyDirection === "both"
            ? relation.from === current.nodeId || relation.to === current.nodeId
            : hierarchyDirection === "parents"
              ? relation.to === current.nodeId
              : relation.from === current.nodeId)
          .sort((left, right) => adjacentRelationSort(current.nodeId, nodeById, left, right));
        for (const relation of relations) {
          const nextId = otherNodeId(relation, current.nodeId);
          if (visited.has(nextId)) continue;
          const next = nodeById.get(nextId);
          if (!next) continue;
          if (entries.length >= limit) {
            truncated = true;
            break;
          }
          visited.add(nextId);
          const nextDepth = current.depth + 1;
          entries.push({ node: next, depth: nextDepth, relation });
          if (nextDepth < depth) queue.push({ nodeId: nextId, depth: nextDepth });
        }
      }
      if (queue.length > 0) truncated = true;
      return {
        ...envelope,
        operation: "hierarchy",
        node,
        direction: hierarchyDirection,
        depth,
        entries,
        truncated,
      };
    }
    case "relations": {
      const node = requireNodeById(graph, input.nodeId);
      if (input.semantic !== undefined
        && !(CODE_MAP_RELATION_SEMANTICS as readonly string[]).includes(input.semantic)) {
        throw new CodeMapQueryError("code_map_query_invalid", `Invalid relation semantic: ${input.semantic}`);
      }
      const semantic = input.semantic;
      const semanticFilter = semanticRelationFilter(semantic);
      const requestedDirection = input.direction === undefined ? "both" : input.direction;
      if (!(CODE_MAP_QUERY_DIRECTIONS as readonly string[]).includes(requestedDirection)) {
        throw new CodeMapQueryError("code_map_query_invalid", `Invalid relation direction: ${requestedDirection}`);
      }
      if (semanticFilter && (input.direction !== undefined || input.relationKinds !== undefined)) {
        throw new CodeMapQueryError(
          "code_map_query_invalid",
          "semantic relation queries cannot also specify direction or relationKinds",
        );
      }
      const direction = semanticFilter?.direction ?? requestedDirection as CodeMapQueryDirection;
      const relationKinds = input.relationKinds?.map((kind) => {
        requireKnownRelationKind(kind);
        return kind;
      });
      const kindSet = semanticFilter?.kinds ?? (relationKinds ? new Set(relationKinds) : undefined);
      const sourceOrderedDependencies = !semanticFilter
        && relationKinds?.length === 1
        && relationKinds[0] === "depends_on";
      const matching = graph.relations
        .filter((relation) => relation.from === node.id || relation.to === node.id)
        .filter((relation) => directionAllows(relation, node.id, direction))
        .filter((relation) => !kindSet || kindSet.has(relation.kind))
        .sort((left, right) => sourceOrderedDependencies
          ? adjacentNodeSort(node.id, nodeById, left, right)
          : relationSort(left, right));
      const entries = matching
        .slice(0, limit)
        .map((relation) => ({ relation, node: nodeById.get(otherNodeId(relation, node.id))! }));
      return {
        ...envelope,
        operation: "relations",
        node,
        direction,
        ...(semantic ? { semantic } : {}),
        entries,
        truncated: matching.length > limit,
      };
    }
    case "neighborhood": {
      const requestedSeeds = input.nodeIds ?? (input.nodeId ? [input.nodeId] : []);
      if (requestedSeeds.length < 1) {
        throw new CodeMapQueryError("code_map_query_invalid", "neighborhood requires nodeIds or nodeId");
      }
      if (requestedSeeds.length > CODE_MAP_QUERY_MAX_SEEDS) {
        throw new CodeMapQueryError(
          "code_map_query_invalid",
          `neighborhood accepts at most ${CODE_MAP_QUERY_MAX_SEEDS} seed nodes`,
        );
      }
      const seedNodeIds = [...new Set(requestedSeeds.map((value) => value.trim()).filter(Boolean))];
      if (seedNodeIds.length < 1) {
        throw new CodeMapQueryError("code_map_query_invalid", "neighborhood seed ids must not be empty");
      }
      for (const seedId of seedNodeIds) requireNodeById(graph, seedId);
      const requestedDirection = input.direction === undefined ? "both" : input.direction;
      if (!(CODE_MAP_QUERY_DIRECTIONS as readonly string[]).includes(requestedDirection)) {
        throw new CodeMapQueryError("code_map_query_invalid", `Invalid neighborhood direction: ${requestedDirection}`);
      }
      const direction = requestedDirection as CodeMapQueryDirection;
      const relationKinds = input.relationKinds?.map((kind) => {
        requireKnownRelationKind(kind);
        return kind;
      });
      const kindSet = relationKinds ? new Set(relationKinds) : undefined;
      const depth = normalizeDepth(input.depth);
      const includeExternalDependencies = input.includeExternalDependencies === true
        || (kindSet?.has("depends_on") ?? false);
      const visited = new Set(seedNodeIds);
      const orderedNodeIds = [...seedNodeIds];
      const selectedRelations = new Map<string, CodeRelation>();
      const queue: Array<{ nodeId: string; depth: number }> = seedNodeIds.map((nodeId) => ({ nodeId, depth: 0 }));
      let truncated = seedNodeIds.length > limit;

      if (orderedNodeIds.length > limit) orderedNodeIds.length = limit;
      while (queue.length > 0 && orderedNodeIds.length < limit && selectedRelations.size < limit) {
        const current = queue.shift()!;
        if (current.depth >= depth) continue;
        const adjacent = graph.relations
          .filter((relation) => relation.from === current.nodeId || relation.to === current.nodeId)
          .filter((relation) => directionAllows(relation, current.nodeId, direction))
          .filter((relation) => !kindSet || kindSet.has(relation.kind))
          .filter((relation) => includeExternalDependencies
            || !isExternalDependencyNeighbor(relation, current.nodeId, nodeById))
          .sort((left, right) => adjacentRelationSort(current.nodeId, nodeById, left, right));
        for (const relation of adjacent) {
          if (selectedRelations.size >= limit || orderedNodeIds.length >= limit) {
            truncated = true;
            break;
          }
          selectedRelations.set(relation.id, relation);
          const nextId = otherNodeId(relation, current.nodeId);
          if (visited.has(nextId)) continue;
          const next = nodeById.get(nextId);
          if (!next) continue;
          visited.add(nextId);
          orderedNodeIds.push(nextId);
          if (current.depth + 1 < depth) queue.push({ nodeId: nextId, depth: current.depth + 1 });
        }
      }
      if (queue.length > 0) truncated = true;
      return {
        ...envelope,
        operation: "neighborhood",
        seedNodeIds,
        direction,
        depth,
        nodes: orderedNodeIds.map((nodeId) => nodeById.get(nodeId)!).filter(Boolean),
        relations: [...selectedRelations.values()],
        truncated,
      };
    }
  }
}
