import type {
  CodeGraphSnapshot,
  CodeNode,
  CodeRelation,
  CodeSourceLocation,
} from "./code-intelligence.js";

export const CODE_SOURCE_SUBSYSTEM_RELATION_KINDS = [
  "calls",
  "instantiates",
  "implements",
] as const;

export type CodeSourceSubsystemRelationKind =
  (typeof CODE_SOURCE_SUBSYSTEM_RELATION_KINDS)[number];

export const CODE_SOURCE_SUBSYSTEM_CLASSIFICATIONS = [
  "source_directory",
  "root_source_file",
  "top_level_directory",
] as const;

export type CodeSourceSubsystemClassification =
  (typeof CODE_SOURCE_SUBSYSTEM_CLASSIFICATIONS)[number];

export type CodeSourceSubsystemFlowRoleHint = "source" | "bridge" | "sink";

export type CodeSourceSubsystemSelectionReason =
  | "cross_boundary_calls"
  | "cross_boundary_structural_relations"
  | "source_scale"
  | "unclassified_root_file";

export type CodeSourceSubsystemNodeRole =
  | "entrypoint"
  | "bridge"
  | "boundary_caller"
  | "boundary_callee"
  | "registration_handler"
  | "high_fanout_raw_owner";

export type CodeSourceSubsystemNodeSelectionReason =
  | "cross_boundary_outgoing_calls"
  | "cross_boundary_incoming_calls"
  | "cross_boundary_structural_relations"
  | "source_registration"
  | "direct_semantic_relation"
  | "high_fanout_raw_owner";

export interface CodeSourceSubsystemEvidenceSample {
  relationId: string;
  fromNodeId: string;
  toNodeId: string;
  confidence: number;
  sourceLocation?: CodeSourceLocation;
  label?: string;
}

export interface CodeSourceSubsystemNotableNode {
  /** Canonical raw Code Map identity. Never a derived code-map:node:* id. */
  nodeId: string;
  name: string;
  kind: CodeNode["kind"];
  path: string;
  startLine?: number;
  roles: readonly CodeSourceSubsystemNodeRole[];
  selectionReasons: readonly CodeSourceSubsystemNodeSelectionReason[];
  incomingCrossBoundaryCallCount: number;
  outgoingCrossBoundaryCallCount: number;
  incomingCrossBoundaryRelationCount: number;
  outgoingCrossBoundaryRelationCount: number;
  directOutgoingRelationCount: number;
  targetSubsystemCount: number;
  sourceSubsystemCount: number;
  /** Bounded raw relation identities owned directly by this raw node. */
  directSourceRelationIds: readonly string[];
  directRelationEvidenceTruncated: boolean;
}

export interface CodeSourceSubsystem {
  /**
   * A grouping label only. It never creates an edge by itself and is not a
   * code:node:* or code-map:node:* identity.
   */
  pathPrefix: string;
  classification: CodeSourceSubsystemClassification;
  fileCount: number;
  symbolCount: number;
  incomingCrossBoundaryCallCount: number;
  outgoingCrossBoundaryCallCount: number;
  incomingCrossBoundaryRelationCount: number;
  outgoingCrossBoundaryRelationCount: number;
  bridgeNodeCount: number;
  registrationEntrypointCount: number;
  flowRoleHint?: CodeSourceSubsystemFlowRoleHint;
  selectionReasons: readonly CodeSourceSubsystemSelectionReason[];
  notableNodeCount: number;
  notableNodes: readonly CodeSourceSubsystemNotableNode[];
  notableNodesTruncated: boolean;
  /**
   * Bounded raw anchors chosen from evidence-ranked notable nodes first, then
   * source-location order as a navigation fallback. Never lexical raw-id first.
   */
  representativeNodeIds: readonly string[];
}

export interface CodeSourceSubsystemRelation {
  fromPathPrefix: string;
  toPathPrefix: string;
  kind: CodeSourceSubsystemRelationKind;
  /** Total raw relations observed for this exact directed pair + kind. */
  sourceRelationCount: number;
  /** Bounded sample of real raw relation ids, aligned with evidenceSample. */
  sourceRelationIds: readonly string[];
  evidenceSample: readonly CodeSourceSubsystemEvidenceSample[];
  evidenceTruncated: boolean;
  evidenceTruncationReason?: "evidence_sample_cap";
}

export interface CodeSourceSubsystemTruncation {
  subsystems: {
    candidateCount: number;
    returnedCount: number;
    truncated: boolean;
    reason?: "subsystem_cap";
  };
  relations: {
    candidateCount: number;
    returnedCount: number;
    truncated: boolean;
    reason?: "relation_cap";
  };
}

export interface CodeSourceSubsystemDerivation {
  nodes: readonly CodeSourceSubsystem[];
  relations: readonly CodeSourceSubsystemRelation[];
  truncated: boolean;
  truncation: CodeSourceSubsystemTruncation;
}

export interface CodeSourceSubsystemDerivationOptions {
  /** Internal discovery mode: preserve deterministic derivation but skip only top-level 12/24 slicing. */
  unbounded?: boolean;
}

const MAX_SUBSYSTEMS = 12;
const MAX_RELATIONS = 24;
const MAX_RELATION_EVIDENCE = 16;
const MAX_NOTABLE_NODES = 8;
const MAX_NODE_DIRECT_EVIDENCE = 8;
const MAX_REPRESENTATIVE_NODES = 5;

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

const EXCLUDED_SOURCE_ROOTS = new Set([
  "tests",
  "test",
  "fixtures",
  "vendor",
  "node_modules",
  "dist",
  "build",
]);

interface SubsystemDescriptor {
  pathPrefix: string;
  classification: CodeSourceSubsystemClassification;
}

interface MutableSubsystem {
  descriptor: SubsystemDescriptor;
  files: Set<string>;
  nodeIds: string[];
  incomingCrossBoundaryCallCount: number;
  outgoingCrossBoundaryCallCount: number;
  incomingCrossBoundaryRelationCount: number;
  outgoingCrossBoundaryRelationCount: number;
}

interface MutableNodeStats {
  incomingCrossBoundaryCallCount: number;
  outgoingCrossBoundaryCallCount: number;
  incomingCrossBoundaryRelationCount: number;
  outgoingCrossBoundaryRelationCount: number;
  directOutgoingRelationCount: number;
  targetSubsystems: Set<string>;
  sourceSubsystems: Set<string>;
  directOutgoingSamples: CodeRelation[];
}

interface MutableRelationAggregate {
  fromPathPrefix: string;
  toPathPrefix: string;
  kind: CodeSourceSubsystemRelationKind;
  sourceRelationCount: number;
  samples: CodeRelation[];
}

function normalizeSourcePath(path: string): string | undefined {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/")) return undefined;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length < 2 || parts.some((part) => part === "..")) return undefined;
  if (EXCLUDED_SOURCE_ROOTS.has(parts[0]!)) return undefined;
  return parts.join("/");
}

function sourceSubsystemDescriptor(path: string): SubsystemDescriptor | undefined {
  const normalized = normalizeSourcePath(path);
  if (!normalized) return undefined;
  const parts = normalized.split("/");
  if (parts[0] === "src") {
    if (parts.length === 2) {
      return {
        pathPrefix: normalized,
        classification: "root_source_file",
      };
    }
    return {
      pathPrefix: `src/${parts[1]}`,
      classification: "source_directory",
    };
  }
  return {
    pathPrefix: parts[0]!,
    classification: "top_level_directory",
  };
}

function isProjectArchitectureCandidate(node: CodeNode): boolean {
  return ARCHITECTURE_SYMBOL_KINDS.has(node.kind)
    && Boolean(node.location?.path)
    && !node.canonicalIdentity.includes(":local ");
}

function isSourceRegistrationNode(node: CodeNode): boolean {
  return node.canonicalIdentity.startsWith("source-registration:");
}

function relationKind(
  relation: CodeRelation,
): CodeSourceSubsystemRelationKind | undefined {
  return CODE_SOURCE_SUBSYSTEM_RELATION_KINDS.includes(
    relation.kind as CodeSourceSubsystemRelationKind,
  )
    ? relation.kind as CodeSourceSubsystemRelationKind
    : undefined;
}

function evidenceLocationKey(location: CodeSourceLocation | undefined): string {
  if (!location) return "~";
  return [
    location.path.replaceAll("\\", "/"),
    String(location.startLine ?? Number.MAX_SAFE_INTEGER).padStart(12, "0"),
    String(location.startColumn ?? Number.MAX_SAFE_INTEGER).padStart(12, "0"),
    String(location.endLine ?? Number.MAX_SAFE_INTEGER).padStart(12, "0"),
    String(location.endColumn ?? Number.MAX_SAFE_INTEGER).padStart(12, "0"),
  ].join(":");
}

function primaryEvidence(relation: CodeRelation): CodeRelation["evidence"] extends readonly (infer E)[] | undefined ? E | undefined : never {
  const evidence = [...(relation.evidence ?? [])].sort((left, right) =>
    evidenceLocationKey(left.location).localeCompare(evidenceLocationKey(right.location))
      || (left.label ?? "").localeCompare(right.label ?? ""));
  return evidence[0] as never;
}

function compareRelations(left: CodeRelation, right: CodeRelation): number {
  const leftEvidence = primaryEvidence(left);
  const rightEvidence = primaryEvidence(right);
  return Number(Boolean(rightEvidence)) - Number(Boolean(leftEvidence))
    || right.confidence - left.confidence
    || evidenceLocationKey(leftEvidence?.location).localeCompare(evidenceLocationKey(rightEvidence?.location))
    || left.from.localeCompare(right.from)
    || left.to.localeCompare(right.to)
    || left.id.localeCompare(right.id);
}

function insertBoundedRelation(
  samples: CodeRelation[],
  relation: CodeRelation,
  cap: number,
): void {
  if (samples.some((entry) => entry.id === relation.id)) return;
  samples.push(relation);
  samples.sort(compareRelations);
  if (samples.length > cap) samples.length = cap;
}

function nodeSourceOrder(left: CodeNode, right: CodeNode): number {
  const leftLocation = left.location;
  const rightLocation = right.location;
  return (leftLocation?.path ?? "").replaceAll("\\", "/")
    .localeCompare((rightLocation?.path ?? "").replaceAll("\\", "/"))
    || (leftLocation?.startLine ?? Number.MAX_SAFE_INTEGER)
      - (rightLocation?.startLine ?? Number.MAX_SAFE_INTEGER)
    || (leftLocation?.startColumn ?? Number.MAX_SAFE_INTEGER)
      - (rightLocation?.startColumn ?? Number.MAX_SAFE_INTEGER)
    || left.name.localeCompare(right.name)
    || left.canonicalIdentity.localeCompare(right.canonicalIdentity)
    || left.id.localeCompare(right.id);
}

function nodeStats(
  stats: Map<string, MutableNodeStats>,
  nodeId: string,
): MutableNodeStats {
  const existing = stats.get(nodeId);
  if (existing) return existing;
  const created: MutableNodeStats = {
    incomingCrossBoundaryCallCount: 0,
    outgoingCrossBoundaryCallCount: 0,
    incomingCrossBoundaryRelationCount: 0,
    outgoingCrossBoundaryRelationCount: 0,
    directOutgoingRelationCount: 0,
    targetSubsystems: new Set<string>(),
    sourceSubsystems: new Set<string>(),
    directOutgoingSamples: [],
  };
  stats.set(nodeId, created);
  return created;
}

function relationEvidenceSample(relation: CodeRelation): CodeSourceSubsystemEvidenceSample {
  const evidence = primaryEvidence(relation);
  return {
    relationId: relation.id,
    fromNodeId: relation.from,
    toNodeId: relation.to,
    confidence: relation.confidence,
    ...(evidence?.location ? { sourceLocation: evidence.location } : {}),
    ...(evidence?.label ? { label: evidence.label } : {}),
  };
}

function subsystemFlowRole(
  incomingCalls: number,
  outgoingCalls: number,
): CodeSourceSubsystemFlowRoleHint | undefined {
  if (incomingCalls > 0 && outgoingCalls > 0) return "bridge";
  if (outgoingCalls > 0) return "source";
  if (incomingCalls > 0) return "sink";
  return undefined;
}

function notableNode(
  node: CodeNode,
  stats: MutableNodeStats,
): CodeSourceSubsystemNotableNode | undefined {
  const crossBoundaryCount =
    stats.incomingCrossBoundaryRelationCount + stats.outgoingCrossBoundaryRelationCount;
  const sourceRegistration =
    isSourceRegistrationNode(node) && stats.directOutgoingRelationCount > 0;
  if (crossBoundaryCount === 0 && !sourceRegistration) return undefined;

  const highFanoutRawOwner =
    stats.outgoingCrossBoundaryCallCount >= 12 && stats.targetSubsystems.size >= 3;
  const roles: CodeSourceSubsystemNodeRole[] = [];
  const reasons: CodeSourceSubsystemNodeSelectionReason[] = [];

  if (sourceRegistration) {
    roles.push("registration_handler");
    reasons.push("source_registration");
  }
  if (stats.outgoingCrossBoundaryCallCount > 0) {
    roles.push(stats.incomingCrossBoundaryCallCount > 0 ? "bridge" : "entrypoint");
    roles.push("boundary_caller");
    reasons.push("cross_boundary_outgoing_calls");
  }
  if (stats.incomingCrossBoundaryCallCount > 0) {
    if (stats.outgoingCrossBoundaryCallCount === 0) roles.push("boundary_callee");
    reasons.push("cross_boundary_incoming_calls");
  }
  const auxiliaryCount =
    crossBoundaryCount
    - stats.incomingCrossBoundaryCallCount
    - stats.outgoingCrossBoundaryCallCount;
  if (auxiliaryCount > 0) reasons.push("cross_boundary_structural_relations");
  if (stats.directOutgoingRelationCount > 0) reasons.push("direct_semantic_relation");
  if (highFanoutRawOwner) {
    roles.push("high_fanout_raw_owner");
    reasons.push("high_fanout_raw_owner");
  }

  const directSamples = [...stats.directOutgoingSamples].sort(compareRelations);
  return {
    nodeId: node.id,
    name: node.name,
    kind: node.kind,
    path: node.location!.path,
    ...(node.location?.startLine !== undefined
      ? { startLine: node.location.startLine }
      : {}),
    roles: [...new Set(roles)],
    selectionReasons: [...new Set(reasons)],
    incomingCrossBoundaryCallCount: stats.incomingCrossBoundaryCallCount,
    outgoingCrossBoundaryCallCount: stats.outgoingCrossBoundaryCallCount,
    incomingCrossBoundaryRelationCount: stats.incomingCrossBoundaryRelationCount,
    outgoingCrossBoundaryRelationCount: stats.outgoingCrossBoundaryRelationCount,
    directOutgoingRelationCount: stats.directOutgoingRelationCount,
    targetSubsystemCount: stats.targetSubsystems.size,
    sourceSubsystemCount: stats.sourceSubsystems.size,
    directSourceRelationIds: directSamples.map((relation) => relation.id),
    directRelationEvidenceTruncated:
      stats.directOutgoingRelationCount > directSamples.length,
  };
}

function compareNotableNodes(
  left: CodeSourceSubsystemNotableNode,
  right: CodeSourceSubsystemNotableNode,
): number {
  const leftFanout = left.roles.includes("high_fanout_raw_owner");
  const rightFanout = right.roles.includes("high_fanout_raw_owner");
  const leftBoundary =
    left.incomingCrossBoundaryRelationCount + left.outgoingCrossBoundaryRelationCount;
  const rightBoundary =
    right.incomingCrossBoundaryRelationCount + right.outgoingCrossBoundaryRelationCount;
  const leftRegistration = left.roles.includes("registration_handler");
  const rightRegistration = right.roles.includes("registration_handler");

  return Number(rightFanout) - Number(leftFanout)
    || rightBoundary - leftBoundary
    || right.outgoingCrossBoundaryCallCount - left.outgoingCrossBoundaryCallCount
    || right.incomingCrossBoundaryCallCount - left.incomingCrossBoundaryCallCount
    || Number(rightRegistration) - Number(leftRegistration)
    || right.directOutgoingRelationCount - left.directOutgoingRelationCount
    || left.path.replaceAll("\\", "/").localeCompare(right.path.replaceAll("\\", "/"))
    || (left.startLine ?? Number.MAX_SAFE_INTEGER)
      - (right.startLine ?? Number.MAX_SAFE_INTEGER)
    || left.name.localeCompare(right.name)
    || left.nodeId.localeCompare(right.nodeId);
}

function boundedNotableNodes(
  nodes: readonly CodeSourceSubsystemNotableNode[],
): readonly CodeSourceSubsystemNotableNode[] {
  const sorted = [...nodes].sort(compareNotableNodes);
  if (sorted.length <= MAX_NOTABLE_NODES) return sorted;
  const bounded = sorted.slice(0, MAX_NOTABLE_NODES);
  if (!bounded.some((entry) => entry.roles.includes("registration_handler"))) {
    const registration = sorted.find((entry) => entry.roles.includes("registration_handler"));
    if (registration) {
      bounded[bounded.length - 1] = registration;
      bounded.sort(compareNotableNodes);
    }
  }
  return bounded;
}

function subsystemSelectionReasons(
  subsystem: MutableSubsystem,
): readonly CodeSourceSubsystemSelectionReason[] {
  const reasons: CodeSourceSubsystemSelectionReason[] = [];
  if (
    subsystem.incomingCrossBoundaryCallCount
      + subsystem.outgoingCrossBoundaryCallCount > 0
  ) {
    reasons.push("cross_boundary_calls");
  }
  const auxiliaryCount =
    subsystem.incomingCrossBoundaryRelationCount
    + subsystem.outgoingCrossBoundaryRelationCount
    - subsystem.incomingCrossBoundaryCallCount
    - subsystem.outgoingCrossBoundaryCallCount;
  if (auxiliaryCount > 0) reasons.push("cross_boundary_structural_relations");
  if (reasons.length === 0) reasons.push("source_scale");
  if (subsystem.descriptor.classification === "root_source_file") {
    reasons.push("unclassified_root_file");
  }
  return reasons;
}

function relationKindRank(kind: CodeSourceSubsystemRelationKind): number {
  if (kind === "calls") return 0;
  if (kind === "instantiates") return 1;
  return 2;
}

export function deriveCodeSourceSubsystems(
  graph: CodeGraphSnapshot,
  options?: CodeSourceSubsystemDerivationOptions,
): CodeSourceSubsystemDerivation {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const subsystemByNodeId = new Map<string, string>();
  const subsystems = new Map<string, MutableSubsystem>();
  const stats = new Map<string, MutableNodeStats>();

  for (const node of graph.nodes) {
    if (!isProjectArchitectureCandidate(node)) continue;
    const descriptor = sourceSubsystemDescriptor(node.location!.path);
    if (!descriptor) continue;
    const existing = subsystems.get(descriptor.pathPrefix) ?? {
      descriptor,
      files: new Set<string>(),
      nodeIds: [],
      incomingCrossBoundaryCallCount: 0,
      outgoingCrossBoundaryCallCount: 0,
      incomingCrossBoundaryRelationCount: 0,
      outgoingCrossBoundaryRelationCount: 0,
    };
    existing.files.add(node.location!.path);
    existing.nodeIds.push(node.id);
    subsystems.set(descriptor.pathPrefix, existing);
    subsystemByNodeId.set(node.id, descriptor.pathPrefix);
  }

  const relationAggregates = new Map<string, MutableRelationAggregate>();

  for (const relation of graph.relations) {
    const kind = relationKind(relation);
    if (!kind) continue;
    const fromNode = nodesById.get(relation.from);
    const toNode = nodesById.get(relation.to);
    if (!fromNode || !toNode) continue;
    const fromSubsystem = subsystemByNodeId.get(fromNode.id);
    const toSubsystem = subsystemByNodeId.get(toNode.id);
    if (!fromSubsystem || !toSubsystem) continue;

    const fromStats = nodeStats(stats, fromNode.id);
    const toStats = nodeStats(stats, toNode.id);
    fromStats.directOutgoingRelationCount += 1;
    insertBoundedRelation(
      fromStats.directOutgoingSamples,
      relation,
      MAX_NODE_DIRECT_EVIDENCE,
    );

    if (fromSubsystem === toSubsystem) continue;

    fromStats.outgoingCrossBoundaryRelationCount += 1;
    toStats.incomingCrossBoundaryRelationCount += 1;
    fromStats.targetSubsystems.add(toSubsystem);
    toStats.sourceSubsystems.add(fromSubsystem);

    const fromGroup = subsystems.get(fromSubsystem)!;
    const toGroup = subsystems.get(toSubsystem)!;
    fromGroup.outgoingCrossBoundaryRelationCount += 1;
    toGroup.incomingCrossBoundaryRelationCount += 1;

    if (kind === "calls") {
      fromStats.outgoingCrossBoundaryCallCount += 1;
      toStats.incomingCrossBoundaryCallCount += 1;
      fromGroup.outgoingCrossBoundaryCallCount += 1;
      toGroup.incomingCrossBoundaryCallCount += 1;
    }

    const key = `${fromSubsystem}\0${toSubsystem}\0${kind}`;
    const aggregate = relationAggregates.get(key) ?? {
      fromPathPrefix: fromSubsystem,
      toPathPrefix: toSubsystem,
      kind,
      sourceRelationCount: 0,
      samples: [],
    };
    aggregate.sourceRelationCount += 1;
    insertBoundedRelation(aggregate.samples, relation, MAX_RELATION_EVIDENCE);
    relationAggregates.set(key, aggregate);
  }

  const allSubsystems: CodeSourceSubsystem[] = [...subsystems.values()].map((group) => {
    const candidateNotables = group.nodeIds.flatMap((nodeId) => {
      const node = nodesById.get(nodeId);
      const nodeStat = stats.get(nodeId);
      if (!node || !nodeStat) return [];
      const projected = notableNode(node, nodeStat);
      return projected ? [projected] : [];
    });
    const notableNodes = boundedNotableNodes(candidateNotables);
    const representativeNodes = [...group.nodeIds]
      .map((nodeId) => nodesById.get(nodeId))
      .filter((node): node is CodeNode => Boolean(node))
      .sort(nodeSourceOrder);
    const representativeNodeIds = [
      ...notableNodes.map((node) => node.nodeId),
      ...representativeNodes.map((node) => node.id),
    ].filter((nodeId, index, values) => values.indexOf(nodeId) === index)
      .slice(0, MAX_REPRESENTATIVE_NODES);
    const bridgeNodeCount = group.nodeIds.filter((nodeId) => {
      const nodeStat = stats.get(nodeId);
      return Boolean(
        nodeStat
        && nodeStat.incomingCrossBoundaryCallCount > 0
        && nodeStat.outgoingCrossBoundaryCallCount > 0,
      );
    }).length;
    const registrationEntrypointCount = group.nodeIds.filter((nodeId) => {
      const node = nodesById.get(nodeId);
      const nodeStat = stats.get(nodeId);
      return Boolean(
        node
        && nodeStat
        && isSourceRegistrationNode(node)
        && nodeStat.directOutgoingRelationCount > 0,
      );
    }).length;

    return {
      pathPrefix: group.descriptor.pathPrefix,
      classification: group.descriptor.classification,
      fileCount: group.files.size,
      symbolCount: group.nodeIds.length,
      incomingCrossBoundaryCallCount: group.incomingCrossBoundaryCallCount,
      outgoingCrossBoundaryCallCount: group.outgoingCrossBoundaryCallCount,
      incomingCrossBoundaryRelationCount: group.incomingCrossBoundaryRelationCount,
      outgoingCrossBoundaryRelationCount: group.outgoingCrossBoundaryRelationCount,
      bridgeNodeCount,
      registrationEntrypointCount,
      ...(subsystemFlowRole(
        group.incomingCrossBoundaryCallCount,
        group.outgoingCrossBoundaryCallCount,
      ) ? {
        flowRoleHint: subsystemFlowRole(
          group.incomingCrossBoundaryCallCount,
          group.outgoingCrossBoundaryCallCount,
        )!,
      } : {}),
      selectionReasons: subsystemSelectionReasons(group),
      notableNodeCount: candidateNotables.length,
      notableNodes,
      notableNodesTruncated: candidateNotables.length > notableNodes.length,
      representativeNodeIds,
    };
  }).sort((left, right) => {
    const leftCalls =
      left.incomingCrossBoundaryCallCount + left.outgoingCrossBoundaryCallCount;
    const rightCalls =
      right.incomingCrossBoundaryCallCount + right.outgoingCrossBoundaryCallCount;
    const leftRelations =
      left.incomingCrossBoundaryRelationCount + left.outgoingCrossBoundaryRelationCount;
    const rightRelations =
      right.incomingCrossBoundaryRelationCount + right.outgoingCrossBoundaryRelationCount;
    return rightCalls - leftCalls
      || rightRelations - leftRelations
      || right.bridgeNodeCount - left.bridgeNodeCount
      || right.fileCount - left.fileCount
      || right.symbolCount - left.symbolCount
      || left.pathPrefix.localeCompare(right.pathPrefix);
  });

  const selectedNodes = options?.unbounded === true
    ? allSubsystems
    : allSubsystems.slice(0, MAX_SUBSYSTEMS);
  const selectedPaths = new Set(selectedNodes.map((node) => node.pathPrefix));

  const allRelations: CodeSourceSubsystemRelation[] =
    [...relationAggregates.values()]
      .filter((relation) =>
        selectedPaths.has(relation.fromPathPrefix)
        && selectedPaths.has(relation.toPathPrefix))
      .map((relation) => {
        const samples = [...relation.samples].sort(compareRelations);
        return {
          fromPathPrefix: relation.fromPathPrefix,
          toPathPrefix: relation.toPathPrefix,
          kind: relation.kind,
          sourceRelationCount: relation.sourceRelationCount,
          sourceRelationIds: samples.map((sample) => sample.id),
          evidenceSample: samples.map(relationEvidenceSample),
          evidenceTruncated: relation.sourceRelationCount > samples.length,
          ...(relation.sourceRelationCount > samples.length
            ? { evidenceTruncationReason: "evidence_sample_cap" as const }
            : {}),
        };
      })
      .sort((left, right) =>
        relationKindRank(left.kind) - relationKindRank(right.kind)
        || right.sourceRelationCount - left.sourceRelationCount
        || left.fromPathPrefix.localeCompare(right.fromPathPrefix)
        || left.toPathPrefix.localeCompare(right.toPathPrefix));

  const selectedRelations = options?.unbounded === true
    ? allRelations
    : allRelations.slice(0, MAX_RELATIONS);
  const subsystemTruncated = allSubsystems.length > selectedNodes.length;
  const relationTruncated = allRelations.length > selectedRelations.length;

  return {
    nodes: selectedNodes,
    relations: selectedRelations,
    truncated: subsystemTruncated || relationTruncated,
    truncation: {
      subsystems: {
        candidateCount: allSubsystems.length,
        returnedCount: selectedNodes.length,
        truncated: subsystemTruncated,
        ...(subsystemTruncated ? { reason: "subsystem_cap" as const } : {}),
      },
      relations: {
        candidateCount: allRelations.length,
        returnedCount: selectedRelations.length,
        truncated: relationTruncated,
        ...(relationTruncated ? { reason: "relation_cap" as const } : {}),
      },
    },
  };
}
