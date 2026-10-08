import type { CodeGraphSnapshot, CodeNode, CodeRelation, CodeSourceLocation } from "./code-intelligence.js";
import { CodeMapQueryError } from "./code-map-query.js";
import { assertCodeMapExactPageSnapshot } from "./code-map-snapshot-identity.js";

export const CODE_MAP_CONTINUATION_DEFAULT_LIMIT = 8;
export const CODE_MAP_CONTINUATION_MAX_LIMIT = 16;
export const CODE_MAP_CONTINUATION_WRAPPER_MAX = 8;

export type CodeMapContinuationUnavailableReason =
  | "not_registration_handler"
  | "no_wrapper_call_evidence"
  | "no_enclosing_owner"
  | "ambiguous_enclosing_owner"
  | "no_owner_downstream_evidence";

export interface CodeMapContinuationQueryInput {
  nodeId: string;
  offset?: number;
  limit?: number;
  expectedSnapshotId?: string;
  expectedSourceIndexedAt?: string;
}

export interface CodeMapContinuationCandidate {
  node: CodeNode;
  ownerDownstreamRelation: CodeRelation;
  handoff: {
    kind: "navigation_only";
    isCallEdge: false;
    registrationRelationId: string;
    ownerDownstreamRelationId: string;
  };
}

export interface CodeMapContinuationResult {
  snapshotId?: string;
  projectId: string;
  sourceIndexedAt: string;
  seedNodeId: string;
  available: boolean;
  reason?: CodeMapContinuationUnavailableReason | "candidate_cap";
  semantics: {
    kind: "registration_owner_handoff";
    isCallEdge: false;
    createsRelation: false;
    syntheticTransitiveEdge: false;
    rawRelationOwnerPreserved: true;
  };
  registrationEvidence: readonly CodeRelation[];
  ownerSelection?: {
    node: CodeNode;
    basis: "source_location_enclosure";
    isRelation: false;
  };
  candidates: readonly CodeMapContinuationCandidate[];
  candidateCount: number;
  returnedCount: number;
  externalFilteredNodeCount: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset?: number;
  truncated: boolean;
}

function fail(
  graph: CodeGraphSnapshot,
  seedNodeId: string,
  reason: CodeMapContinuationUnavailableReason,
  offset: number,
  limit: number,
  registrationEvidence: readonly CodeRelation[] = [],
  ownerSelection?: CodeMapContinuationResult["ownerSelection"],
  externalFilteredNodeCount = 0,
): CodeMapContinuationResult {
  return {
    projectId: graph.projectId,
    sourceIndexedAt: graph.indexedAt,
    seedNodeId,
    available: false,
    reason,
    semantics: {
      kind: "registration_owner_handoff",
      isCallEdge: false,
      createsRelation: false,
      syntheticTransitiveEdge: false,
      rawRelationOwnerPreserved: true,
    },
    registrationEvidence,
    ...(ownerSelection ? { ownerSelection } : {}),
    candidates: [],
    candidateCount: 0,
    returnedCount: 0,
    externalFilteredNodeCount,
    offset,
    limit,
    hasMore: false,
    truncated: false,
  };
}

function normalizeInput(graph: CodeGraphSnapshot, input: CodeMapContinuationQueryInput, currentSnapshotId?: string): { nodeId: string; offset: number; limit: number } {
  const nodeId = input.nodeId?.trim();
  if (!nodeId) throw new CodeMapQueryError("code_map_query_invalid", "nodeId is required");
  const offset = input.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new CodeMapQueryError("code_map_query_invalid", "offset must be a non-negative integer");
  }
  const requestedLimit = input.limit ?? CODE_MAP_CONTINUATION_DEFAULT_LIMIT;
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
    throw new CodeMapQueryError("code_map_query_invalid", "limit must be a positive integer");
  }
  assertCodeMapExactPageSnapshot(
    { offset, expectedSourceIndexedAt: input.expectedSourceIndexedAt, expectedSnapshotId: input.expectedSnapshotId },
    { indexedAt: graph.indexedAt, snapshotId: currentSnapshotId },
    "continuation",
  );
  return { nodeId, offset, limit: Math.min(requestedLimit, CODE_MAP_CONTINUATION_MAX_LIMIT) };
}

function localLocation(node: CodeNode): CodeSourceLocation | undefined {
  const location = node.location;
  const path = location?.path.replaceAll("\\", "/");
  if (!location || !path || path.startsWith("/") || /^[A-Za-z]:\//.test(path)) return undefined;
  if (path.split("/").some((part) => part === "..")) return undefined;
  if (node.canonicalIdentity.startsWith("scip-external:")) return undefined;
  return location;
}

function startPosition(location: CodeSourceLocation): [number, number] {
  return [location.startLine ?? 0, location.startColumn ?? 0];
}

function endPosition(location: CodeSourceLocation): [number, number] {
  return [location.endLine ?? location.startLine ?? 0, location.endColumn ?? Number.MAX_SAFE_INTEGER];
}

function comparePosition(left: readonly [number, number], right: readonly [number, number]): number {
  return left[0] - right[0] || left[1] - right[1];
}

function encloses(outer: CodeSourceLocation, inner: CodeSourceLocation): boolean {
  return outer.path === inner.path
    && comparePosition(startPosition(outer), startPosition(inner)) <= 0
    && comparePosition(endPosition(outer), endPosition(inner)) >= 0;
}

function locationSpan(location: CodeSourceLocation): number {
  const start = startPosition(location);
  const end = endPosition(location);
  return (end[0] - start[0]) * 1_000_000 + end[1] - start[1];
}

function relationEvidenceInRegion(
  relation: CodeRelation,
  path: string,
  start: readonly [number, number],
  endExclusive: readonly [number, number],
): CodeSourceLocation | undefined {
  return relation.evidence
    ?.map((entry) => entry.location)
    .filter((location) => location.path === path)
    .sort((left, right) => comparePosition(startPosition(left), startPosition(right)))
    .find((location) => comparePosition(startPosition(location), start) >= 0
      && comparePosition(startPosition(location), endExclusive) < 0);
}

function candidateSort(
  left: { node: CodeNode; relation: CodeRelation; evidence: CodeSourceLocation },
  right: { node: CodeNode; relation: CodeRelation; evidence: CodeSourceLocation },
): number {
  return left.evidence.path.localeCompare(right.evidence.path)
    || comparePosition(startPosition(left.evidence), startPosition(right.evidence))
    || left.node.canonicalIdentity.localeCompare(right.node.canonicalIdentity)
    || left.node.id.localeCompare(right.node.id)
    || left.relation.id.localeCompare(right.relation.id);
}

export function queryCodeMapContinuations(
  graph: CodeGraphSnapshot,
  input: CodeMapContinuationQueryInput,
  currentSnapshotId?: string,
): CodeMapContinuationResult {
  const { nodeId, offset, limit } = normalizeInput(graph, input, currentSnapshotId);
  const seed = graph.nodes.find((node) => node.id === nodeId);
  if (!seed) throw new CodeMapQueryError("code_node_not_found", `Code node not found: ${nodeId}`);
  const seedLocation = localLocation(seed);
  if (!seed.canonicalIdentity.startsWith("source-registration:") || !seedLocation) {
    return fail(graph, seed.id, "not_registration_handler", offset, limit);
  }

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const registrationEvidence = graph.relations
    .filter((relation) => relation.kind === "calls" && relation.from === seed.id && nodeById.has(relation.to))
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, CODE_MAP_CONTINUATION_WRAPPER_MAX);
  if (registrationEvidence.length === 0) {
    return fail(graph, seed.id, "no_wrapper_call_evidence", offset, limit);
  }

  const ownerCandidates = graph.nodes
    .filter((node) => ["function", "method", "constructor"].includes(node.kind))
    .map((node) => ({ node, location: node.lexicalExtent && localLocation({ ...node, location: node.lexicalExtent }) }))
    .filter((entry): entry is { node: CodeNode; location: CodeSourceLocation } =>
      Boolean(entry.location && entry.node.id !== seed.id && encloses(entry.location, seedLocation)))
    .sort((left, right) => locationSpan(left.location) - locationSpan(right.location)
      || left.node.canonicalIdentity.localeCompare(right.node.canonicalIdentity)
      || left.node.id.localeCompare(right.node.id));
  if (ownerCandidates.length === 0) {
    return fail(graph, seed.id, "no_enclosing_owner", offset, limit, registrationEvidence);
  }
  const narrowestSpan = locationSpan(ownerCandidates[0]!.location);
  const narrowest = ownerCandidates.filter((entry) => locationSpan(entry.location) === narrowestSpan);
  if (narrowest.length !== 1) {
    return fail(graph, seed.id, "ambiguous_enclosing_owner", offset, limit, registrationEvidence);
  }

  const owner = narrowest[0]!;
  const ownerSelection = { node: owner.node, basis: "source_location_enclosure" as const, isRelation: false as const };
  const nextRegistration = graph.nodes
    .filter((node) => node.id !== seed.id && node.canonicalIdentity.startsWith("source-registration:"))
    .map((node) => localLocation(node))
    .filter((location): location is CodeSourceLocation =>
      Boolean(location && encloses(owner.location, location)
        && comparePosition(startPosition(location), startPosition(seedLocation)) > 0))
    .sort((left, right) => comparePosition(startPosition(left), startPosition(right)))[0];
  const regionEnd = nextRegistration ? startPosition(nextRegistration) : endPosition(owner.location);

  let externalFilteredNodeCount = 0;
  const rawCandidates: Array<{ node: CodeNode; relation: CodeRelation; evidence: CodeSourceLocation }> = [];
  for (const relation of graph.relations) {
    if (relation.kind !== "calls" || relation.from !== owner.node.id) continue;
    const evidence = relationEvidenceInRegion(relation, seedLocation.path, startPosition(seedLocation), regionEnd);
    if (!evidence) continue;
    const node = nodeById.get(relation.to);
    if (!node || !localLocation(node)) {
      externalFilteredNodeCount += 1;
      continue;
    }
    rawCandidates.push({ node, relation, evidence });
  }
  rawCandidates.sort(candidateSort);
  if (rawCandidates.length === 0) {
    return fail(
      graph, seed.id, "no_owner_downstream_evidence", offset, limit,
      registrationEvidence, ownerSelection, externalFilteredNodeCount,
    );
  }

  const bounded = rawCandidates.slice(0, CODE_MAP_CONTINUATION_MAX_LIMIT);
  const page = bounded.slice(offset, offset + limit);
  const hasMore = offset + page.length < bounded.length;
  return {
    projectId: graph.projectId,
    sourceIndexedAt: graph.indexedAt,
    seedNodeId: seed.id,
    available: true,
    semantics: {
      kind: "registration_owner_handoff",
      isCallEdge: false,
      createsRelation: false,
      syntheticTransitiveEdge: false,
      rawRelationOwnerPreserved: true,
    },
    registrationEvidence,
    ownerSelection,
    candidates: page.map(({ node, relation }) => ({
      node,
      ownerDownstreamRelation: relation,
      handoff: {
        kind: "navigation_only",
        isCallEdge: false,
        registrationRelationId: registrationEvidence[0]!.id,
        ownerDownstreamRelationId: relation.id,
      },
    })),
    candidateCount: rawCandidates.length,
    returnedCount: page.length,
    externalFilteredNodeCount,
    offset,
    limit,
    hasMore,
    ...(hasMore ? { nextOffset: offset + page.length } : {}),
    truncated: rawCandidates.length > CODE_MAP_CONTINUATION_MAX_LIMIT,
    ...(rawCandidates.length > CODE_MAP_CONTINUATION_MAX_LIMIT ? { reason: "candidate_cap" as const } : {}),
  };
}
