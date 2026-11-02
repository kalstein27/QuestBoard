import { createHash } from "node:crypto";
import type { CodeGraphSnapshot, CodeNode, CodeRelation, CodeSourceLocation } from "./code-intelligence.js";
import { projectCodeArchitecture } from "./code-map-projection.js";
import {
  CODE_SOURCE_SUBSYSTEM_READ_CAPS,
  createCodeSourceSubsystemRead,
  type CodeSourceSubsystemQueryResult,
  type CodeSourceSubsystemReadRelation,
} from "./code-map-subsystem-read.js";
import type { CodeSourceSubsystemRelationKind } from "./code-map-subsystems.js";

/**
 * S2 is a pure, opt-in projection. No repository, Flow, SQLite, adapter or
 * compatibility-sync mutation is reachable from this module.
 * The binding namespace is reserved for the independent S3 persistence path.
 */
export const SOURCE_STRUCTURE_SYNC_SCHEMA_VERSION = 1 as const;
export const SOURCE_STRUCTURE_SYNC_BINDING_PREFIX = "source-structure-sync:binding:v1:";
export const SOURCE_STRUCTURE_SYNC_RELATION_PREFIX = "source-structure-sync:relation:v1:";
export const SOURCE_STRUCTURE_SYNC_LIMITS = { nodes: 12, relations: 24, evidence: 16 } as const;
const ELIGIBLE_KINDS = new Set<CodeNode["kind"]>([
  "module", "namespace", "class", "interface", "function", "method", "constructor", "type", "enum",
]);
const RELATION_KINDS = new Set<CodeRelation["kind"]>(["calls", "instantiates", "implements"]);

export class SourceStructureSelectionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SourceStructureSelectionError";
  }
}

export interface SourceStructureSelection {
  /** Mandatory exact, user-visible page from queryCodeSourceSubsystems(list_subsystems). */
  subsystemPage: Extract<CodeSourceSubsystemQueryResult, { operation: "list_subsystems" }>;
  /** The exact optional pathPrefix filter used to fetch the pinned page. */
  pathPrefixFilter?: string;
  /** Explicit IDs from that page, never implicit all-candidates sync. */
  selectedSubsystemIds: readonly string[];
  /** Optional project-local raw anchors within the selected subsystem IDs. */
  selectedRawAnchorIds?: readonly string[];
  /** Optional exact derived/raw relation IDs. If omitted, all eligible selected edges must fit the cap. */
  selectedRelationIds?: readonly string[];
  /** Both pins are mandatory even on page zero; caller obtains snapshotId from its normal read boundary. */
  expectedSourceIndexedAt: string;
  expectedSnapshotId: string;
}

export interface SourceStructureEvidence {
  rawRelationId: string;
  fromRawNodeId: string;
  toRawNodeId: string;
  confidence: number;
  sourceLocation?: CodeSourceLocation;
  label?: string;
  provenance?: CodeRelation["provenance"];
}

export interface SourceStructureSyncNode {
  /** Binding identity, deliberately never a code-map:* or code-subsystem:* ID. */
  id: string;
  sourceId: string;
  sourceType: "subsystem" | "raw_anchor";
  identityKey: string;
  title: string;
  pathPrefix: string;
  classification: string;
  rawOwnerNodeId?: string;
  ownerContainment: readonly string[];
}

export interface SourceStructureSyncRelation {
  id: string;
  sourceId: string;
  from: string;
  to: string;
  kind: CodeSourceSubsystemRelationKind;
  directed: true;
  sourceRelationCount: number;
  /** Real raw facts only; samples are bounded, the full graph participates in the fingerprint. */
  rawRelationIds: readonly string[];
  evidence: readonly SourceStructureEvidence[];
  evidenceTruncated: boolean;
}

export interface SourceStructureSyncGraph {
  schemaVersion: typeof SOURCE_STRUCTURE_SYNC_SCHEMA_VERSION;
  projectId: string;
  sourceIndexedAt: string;
  snapshotId: string;
  identityNamespaces: {
    compatibility: "code-map:*";
    subsystemRead: "code-subsystem:*";
    raw: "code:node:*";
    syncBinding: typeof SOURCE_STRUCTURE_SYNC_BINDING_PREFIX;
  };
  selectionFingerprint: string;
  evidenceFingerprint: string;
  selection: {
    subsystemPage: {
      offset: number; limit: number; candidateCount: number;
      returnedCount: number; hasMore: boolean; truncated: boolean;
    };
    selectedSubsystemIds: readonly string[];
    selectedRawAnchorIds: readonly string[];
    selectedRelationIds: readonly string[];
    omittedEligibleRelationCount: number;
    notFullGraphSync: true;
  };
  diagnostics: {
    rawLocalCallCount: number;
    compatibilityRelationCount: number;
    compatibilityOmittedCallEvidenceCount: number;
    structureCandidateCount: number;
    structureRelationCandidateCount: number;
    noSelectedRelationsReason?: "raw_evidence_absent" | "outside_selection" | "relation_filter";
    evidenceSamplesTruncated: boolean;
  };
  nodes: readonly SourceStructureSyncNode[];
  relations: readonly SourceStructureSyncRelation[];
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function id(prefix: string, parts: readonly string[]): string {
  return prefix + digest(parts).slice(0, 24);
}
function uniqueSorted(values: readonly string[], label: string): string[] {
  const sorted = [...values].sort();
  if (sorted.some((value) => !value || !value.trim())) {
    throw new SourceStructureSelectionError("invalid_selection", label + " contains a blank ID");
  }
  if (new Set(sorted).size !== sorted.length) {
    throw new SourceStructureSelectionError("duplicate_selection", label + " contains duplicate IDs");
  }
  return sorted;
}
function sourcePath(value: string | undefined): string | undefined {
  if (!value || value.startsWith("/") || value.includes("\\") || value.split("/").includes("..")) return undefined;
  const clean = value.replace(/^\.\//, "");
  return clean && !clean.split("/").some((part) => !part) ? clean : undefined;
}
function eligible(node: CodeNode | undefined): node is CodeNode {
  return Boolean(node && ELIGIBLE_KINDS.has(node.kind) && sourcePath(node.location?.path)
    && !node.canonicalIdentity.includes(":local ") && node.id.startsWith("code:node:"));
}
function containedBy(node: CodeNode, group: { pathPrefix: string; classification: string }): boolean {
  const path = sourcePath(node.location?.path);
  if (!path) return false;
  return group.classification === "root_source_file"
    ? path === group.pathPrefix
    : path.startsWith(group.pathPrefix + "/");
}
function error(code: string, message: string): never {
  throw new SourceStructureSelectionError(code, message);
}
function stableEvidence(relation: CodeRelation): SourceStructureEvidence {
  const first = [...(relation.evidence ?? [])].sort((a, b) =>
    JSON.stringify(a.location).localeCompare(JSON.stringify(b.location))
      || (a.label ?? "").localeCompare(b.label ?? ""))[0];
  return {
    rawRelationId: relation.id,
    fromRawNodeId: relation.from,
    toRawNodeId: relation.to,
    confidence: relation.confidence,
    ...(first?.location ? { sourceLocation: { ...first.location } } : {}),
    ...(first?.label ? { label: first.label } : {}),
    ...(relation.provenance ? { provenance: [...relation.provenance] } : {}),
  };
}
function fingerprintEvidence(graph: CodeGraphSnapshot): string {
  // Snapshot-wide conservative stale check includes unsampled facts. Array order cannot affect it.
  const nodes = graph.nodes.map((node) => [
    node.id, node.canonicalIdentity, node.kind, node.location ?? null, node.lexicalExtent ?? null,
  ]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const relations = graph.relations.map((relation) => [
    relation.id, relation.kind, relation.from, relation.to, relation.confidence,
    [...(relation.evidence ?? [])].map((entry) => JSON.stringify(entry)).sort(),
    [...(relation.provenance ?? [])].map((entry) => JSON.stringify(entry)).sort(),
  ]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return digest([graph.projectId, graph.indexedAt, nodes, relations]);
}
function ownerChain(rawId: string, parents: Map<string, string[]>): string[] {
  const chain: string[] = [];
  const seen = new Set([rawId]);
  let child = rawId;
  while (parents.has(child)) {
    const possibilities = parents.get(child)!;
    if (possibilities.length !== 1) error("ambiguous_contains_owner", "Selected anchor has multiple contains owners");
    const parent = possibilities[0]!;
    if (seen.has(parent)) error("contains_cycle", "Selected anchor contains ownership has a cycle");
    chain.push(parent);
    seen.add(parent);
    child = parent;
  }
  return chain;
}

/**
 * Build a strictly selected source-structure graph from already indexed, local normalized facts.
 * It never requests a provider, PHP file, refresh, storage transaction or production snapshot.
 */
export function deriveSourceStructureSyncGraph(
  graph: CodeGraphSnapshot,
  input: SourceStructureSelection,
  currentSnapshotId: string,
): SourceStructureSyncGraph {
  if (!currentSnapshotId || !input.expectedSnapshotId || !input.expectedSourceIndexedAt
    || currentSnapshotId !== input.expectedSnapshotId
    || graph.indexedAt !== input.expectedSourceIndexedAt) {
    error("source_structure_snapshot_stale", "Exact indexedAt and snapshot ID are required and must match");
  }
  const page = input.subsystemPage;
  if (page.operation !== "list_subsystems" || page.projectId !== graph.projectId
    || page.sourceIndexedAt !== graph.indexedAt || page.snapshotId !== currentSnapshotId
    || page.returnedCount !== page.nodes.length
    || !Number.isInteger(page.offset) || page.offset < 0
    || !Number.isInteger(page.limit) || page.limit < 1
    || page.limit > CODE_SOURCE_SUBSYSTEM_READ_CAPS.subsystems
    || page.candidateCount < page.offset + page.returnedCount
    || page.hasMore !== (page.offset + page.returnedCount < page.candidateCount)
    || page.truncated !== page.hasMore) {
    error("invalid_pinned_page", "Selection must reference an exact, valid pinned subsystem page");
  }
  const groupIds = uniqueSorted(input.selectedSubsystemIds, "selectedSubsystemIds");
  const rawIds = uniqueSorted(input.selectedRawAnchorIds ?? [], "selectedRawAnchorIds");
  const requestedEdges = input.selectedRelationIds === undefined
    ? undefined : uniqueSorted(input.selectedRelationIds, "selectedRelationIds");
  if (groupIds.length === 0) error("empty_selection", "At least one subsystem must be explicitly selected");
  if (groupIds.length + rawIds.length > SOURCE_STRUCTURE_SYNC_LIMITS.nodes)
    error("selection_node_cap", "A selection may contain at most 12 total nodes");

  const compatibility = projectCodeArchitecture(graph); // read-only compatibility; no contract writes
  const full = createCodeSourceSubsystemRead(graph, compatibility, undefined, { unbounded: true });
  const pathFilter = input.pathPrefixFilter?.trim();
  const filteredGroups = pathFilter
    ? full.nodes.filter((group) => group.pathPrefix.startsWith(pathFilter))
    : full.nodes;
  const expectedPage = filteredGroups.slice(page.offset, page.offset + page.limit);
  if (page.candidateCount !== filteredGroups.length
    || page.nodes.length !== expectedPage.length
    || page.nodes.some((group, index) => group.id !== expectedPage[index]?.id
      || group.pathPrefix !== expectedPage[index]?.pathPrefix)) {
    error("invalid_pinned_page", "Page does not match the exact indexed selection/filter/offset");
  }
  const pageIds = new Set(page.nodes.map((node) => node.id));
  const allGroups = new Map(full.nodes.map((node) => [node.id, node]));
  for (const groupId of groupIds) {
    if (!pageIds.has(groupId) || !allGroups.has(groupId))
      error("selected_outside_page", "Selected subsystem is absent from the pinned page");
  }
  const selectedGroups = groupIds.map((groupId) => allGroups.get(groupId)!);
  const rawNodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const selectedGroupForRaw = (node: CodeNode) =>
    selectedGroups.find((group) => containedBy(node, group));
  const parents = new Map<string, string[]>();
  for (const relation of graph.relations) {
    if (relation.kind !== "contains") continue;
    const entries = parents.get(relation.to) ?? [];
    if (!entries.includes(relation.from)) entries.push(relation.from);
    parents.set(relation.to, entries.sort());
  }
  const syncNodes: SourceStructureSyncNode[] = selectedGroups.map((group) => ({
    id: id(SOURCE_STRUCTURE_SYNC_BINDING_PREFIX, [graph.projectId, "subsystem", group.id]),
    sourceId: group.id, sourceType: "subsystem", identityKey: group.id,
    title: group.pathPrefix, pathPrefix: group.pathPrefix, classification: group.classification,
    ownerContainment: [],
  }));
  for (const rawId of rawIds) {
    const node = rawNodeById.get(rawId);
    if (!eligible(node)) error("invalid_raw_anchor", "Raw anchor must be a project-local semantic code:node:*");
    const group = selectedGroupForRaw(node);
    if (!group) error("anchor_outside_selection", "Anchor is not inside the selected subsystem page");
    const stableKey = [node.kind, node.canonicalIdentity].join(":");
    syncNodes.push({
      id: id(SOURCE_STRUCTURE_SYNC_BINDING_PREFIX, [graph.projectId, "raw_anchor", stableKey]),
      sourceId: rawId, sourceType: "raw_anchor", identityKey: stableKey,
      title: node.name, pathPrefix: group.pathPrefix, classification: node.kind,
      ...(ownerChain(rawId, parents)[0] ? { rawOwnerNodeId: ownerChain(rawId, parents)[0] } : {}),
      ownerContainment: ownerChain(rawId, parents),
    });
  }
  if (new Set(syncNodes.map((node) => node.id)).size !== syncNodes.length) {
    error("binding_identity_collision", "Selected nodes collapse to the same binding identity");
  }
  syncNodes.sort((a, b) => a.id.localeCompare(b.id));
  const bindingBySource = new Map(syncNodes.map((node) => [node.sourceId, node.id]));
  const selectedGroupsSet = new Set(groupIds);
  const rawRelations = new Map(graph.relations.map((relation) => [relation.id, relation]));
  const candidates: SourceStructureSyncRelation[] = [];
  for (const relation of full.relations) {
    if (!selectedGroupsSet.has(relation.fromSubsystemId) || !selectedGroupsSet.has(relation.toSubsystemId)) continue;
    const evidence = relation.sourceRelationIds.map((relationId) => rawRelations.get(relationId))
      .filter((item): item is CodeRelation => Boolean(item)).map(stableEvidence);
    if (relation.sourceRelationCount < 1 || evidence.length === 0
      || evidence.some((item) => !rawRelations.has(item.rawRelationId)))
      error("missing_raw_evidence", "Subsystem relation is missing actual raw provenance");
    candidates.push({
      id: id(SOURCE_STRUCTURE_SYNC_RELATION_PREFIX, [
        graph.projectId, relation.fromSubsystemId, relation.kind, relation.toSubsystemId,
      ]),
      sourceId: relation.id,
      from: bindingBySource.get(relation.fromSubsystemId)!,
      to: bindingBySource.get(relation.toSubsystemId)!,
      kind: relation.kind, directed: true, sourceRelationCount: relation.sourceRelationCount,
      rawRelationIds: evidence.map((item) => item.rawRelationId),
      evidence, evidenceTruncated: relation.evidenceTruncated,
    });
  }
  // Optional exact raw anchor-to-anchor edges, grouped by stable endpoint identities.
  // Reindexing may change raw relation IDs, but never renames the binding by itself.
  const selectedRaw = new Set(rawIds);
  const anchorAggregates = new Map<string, CodeRelation[]>();
  for (const relation of graph.relations) {
    if (!RELATION_KINDS.has(relation.kind) || !selectedRaw.has(relation.from)
      || !selectedRaw.has(relation.to) || relation.from === relation.to) continue;
    const from = bindingBySource.get(relation.from)!;
    const to = bindingBySource.get(relation.to)!;
    const key = JSON.stringify([from, relation.kind, to]);
    const aggregate = anchorAggregates.get(key) ?? [];
    aggregate.push(relation);
    anchorAggregates.set(key, aggregate);
  }
  for (const [key, group] of anchorAggregates) {
    const [from, kind, to] = JSON.parse(key) as [string, CodeSourceSubsystemRelationKind, string];
    const sorted = [...group].sort((a, b) => a.id.localeCompare(b.id));
    const evidence = sorted.slice(0, SOURCE_STRUCTURE_SYNC_LIMITS.evidence).map(stableEvidence);
    const sourceId = id("source-structure-sync:raw-relation:v1:", [graph.projectId, from, kind, to]);
    candidates.push({
      id: id(SOURCE_STRUCTURE_SYNC_RELATION_PREFIX, [graph.projectId, "raw", from, kind, to]),
      sourceId, from, to, kind, directed: true,
      sourceRelationCount: sorted.length,
      rawRelationIds: evidence.map((entry) => entry.rawRelationId),
      evidence, evidenceTruncated: sorted.length > evidence.length,
    });
  }
  candidates.sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(candidates.map((relation) => relation.id)).size !== candidates.length)
    error("relation_identity_collision", "Derived relation ID collision");
  if (requestedEdges?.some((relationId) => !candidates.some((entry) => entry.sourceId === relationId)))
    error("unknown_selected_relation", "Relation selection contains an ID outside the eligible selected endpoints");
  const selected = requestedEdges
    ? candidates.filter((relation) => requestedEdges.includes(relation.sourceId))
    : candidates;
  if (selected.length > SOURCE_STRUCTURE_SYNC_LIMITS.relations)
    error("selection_relation_cap", "Explicitly narrow selected relations to at most 24");
  const evidenceFingerprint = fingerprintEvidence(graph);
  const selectionFingerprint = digest([
    SOURCE_STRUCTURE_SYNC_SCHEMA_VERSION, graph.projectId, currentSnapshotId, graph.indexedAt,
    groupIds, rawIds, selected.map((relation) => relation.sourceId).sort(), evidenceFingerprint,
  ]);
  const localNodes = new Set(graph.nodes.filter(eligible).map((node) => node.id));
  const rawLocalCallCount = graph.relations.filter((r) =>
    r.kind === "calls" && localNodes.has(r.from) && localNodes.has(r.to)).length;
  return {
    schemaVersion: SOURCE_STRUCTURE_SYNC_SCHEMA_VERSION,
    projectId: graph.projectId, sourceIndexedAt: graph.indexedAt, snapshotId: currentSnapshotId,
    identityNamespaces: {
      compatibility: "code-map:*", subsystemRead: "code-subsystem:*",
      raw: "code:node:*", syncBinding: SOURCE_STRUCTURE_SYNC_BINDING_PREFIX,
    },
    selectionFingerprint, evidenceFingerprint,
    selection: {
      subsystemPage: {
        offset: page.offset, limit: page.limit, candidateCount: page.candidateCount,
        returnedCount: page.returnedCount, hasMore: page.hasMore, truncated: page.truncated,
      },
      selectedSubsystemIds: groupIds, selectedRawAnchorIds: rawIds,
      selectedRelationIds: selected.map((relation) => relation.sourceId).sort(),
      omittedEligibleRelationCount: candidates.length - selected.length,
      notFullGraphSync: true,
    },
    diagnostics: {
      rawLocalCallCount,
      compatibilityRelationCount: compatibility.relations.length,
      compatibilityOmittedCallEvidenceCount: Math.max(0,
        rawLocalCallCount - full.quality.compatibilityCallEvidenceCount),
      structureCandidateCount: full.nodes.length,
      structureRelationCandidateCount: candidates.length,
      ...(selected.length === 0 ? { noSelectedRelationsReason:
        rawLocalCallCount === 0 ? "raw_evidence_absent" as const
          : candidates.length === 0 ? "outside_selection" as const
            : "relation_filter" as const } : {}),
      evidenceSamplesTruncated: selected.some((relation) => relation.evidenceTruncated),
    },
    nodes: syncNodes, relations: selected,
  };
}
