import { createHash } from "node:crypto";
import type { CodeGraphSnapshot, CodeNode, CodeSourceLocation } from "./code-intelligence.js";
import type { CodeMapProviderCapabilityReport } from "./code-map-provider-registry.js";
import type { CodeArchitectureProjection } from "./code-map-projection.js";
import {
  CODE_SOURCE_SUBSYSTEM_RELATION_KINDS,
  deriveCodeSourceSubsystems,
  type CodeSourceSubsystemRelationKind,
} from "./code-map-subsystems.js";
import { CodeMapQueryError } from "./code-map-query.js";
import { assertCodeMapExactPageSnapshot } from "./code-map-snapshot-identity.js";

export const CODE_SOURCE_SUBSYSTEM_READ_ID_PREFIXES = {
  node: "code-subsystem:node:",
  relation: "code-subsystem:relation:",
} as const;

export const CODE_SOURCE_SUBSYSTEM_READ_CAPS = {
  subsystems: 12,
  relations: 24,
  relationEvidence: 16,
  notableNodesPerSubsystem: 8,
  directEvidencePerNotableNode: 8,
} as const;

export const CODE_SOURCE_SUBSYSTEM_QUERY_OPERATIONS = [
  "list_subsystems",
  "list_relations",
] as const;
export type CodeSourceSubsystemQueryOperation =
  (typeof CODE_SOURCE_SUBSYSTEM_QUERY_OPERATIONS)[number];

export interface CodeSourceSubsystemQueryInput {
  operation: CodeSourceSubsystemQueryOperation;
  pathPrefix?: string;
  fromPathPrefix?: string;
  toPathPrefix?: string;
  relationKinds?: readonly CodeSourceSubsystemRelationKind[];
  offset?: number;
  limit?: number;
  expectedSourceIndexedAt?: string;
  expectedSnapshotId?: string;
}

interface CodeSourceSubsystemQueryEnvelope {
  projectId: string;
  snapshotId?: string;
  operation: CodeSourceSubsystemQueryOperation;
  sourceIndexedAt: string;
  candidateCount: number;
  offset: number;
  limit: number;
  returnedCount: number;
  hasMore: boolean;
  nextOffset?: number;
  truncated: boolean;
  reason?: "page_cap";
}

export type CodeSourceSubsystemQueryResult =
  | (CodeSourceSubsystemQueryEnvelope & {
      operation: "list_subsystems";
      nodes: readonly CodeSourceSubsystemReadNode[];
    })
  | (CodeSourceSubsystemQueryEnvelope & {
      operation: "list_relations";
      relations: readonly CodeSourceSubsystemReadRelation[];
    });

export interface CodeSourceSubsystemReadEvidence {
  relationId: string;
  fromNodeId: string;
  toNodeId: string;
  confidence: number;
  sourceLocation?: CodeSourceLocation;
  label?: string;
}

export interface CodeSourceSubsystemReadNavigation {
  rawNodeId: string;
  callers: {
    operation: "relations";
    nodeId: string;
    semantic: "callers";
    limit: 50;
  };
  callees: {
    operation: "relations";
    nodeId: string;
    semantic: "callees";
    limit: 50;
  };
}

export interface CodeSourceSubsystemReadNotableNode {
  /** Final drill-down identity in the canonical raw graph. */
  rawNodeId: string;
  name: string;
  kind: CodeNode["kind"];
  path: string;
  startLine?: number;
  roles: readonly string[];
  selectionReasons: readonly string[];
  incomingCrossBoundaryCallCount: number;
  outgoingCrossBoundaryCallCount: number;
  directOutgoingRelationCount: number;
  targetSubsystemCount: number;
  sourceSubsystemCount: number;
  directSourceRelationIds: readonly string[];
  directRelationEvidenceTruncated: boolean;
  registrationContext: boolean;
  rawRelationOwnerPreserved: true;
  navigation: CodeSourceSubsystemReadNavigation;
}

export interface CodeSourceSubsystemReadNode {
  /** Stable derived identity. Never a raw code:node:* or compatibility code-map:node:* id. */
  id: string;
  pathPrefix: string;
  classification: string;
  fileCount: number;
  symbolCount: number;
  incomingCrossBoundaryCallCount: number;
  outgoingCrossBoundaryCallCount: number;
  bridgeNodeCount: number;
  registrationEntrypointCount: number;
  flowRoleHint?: string;
  selectionReasons: readonly string[];
  notableNodeCount: number;
  notableNodes: readonly CodeSourceSubsystemReadNotableNode[];
  notableNodesTruncated: boolean;
}

export interface CodeSourceSubsystemReadRelation {
  id: string;
  fromSubsystemId: string;
  toSubsystemId: string;
  fromPathPrefix: string;
  toPathPrefix: string;
  directed: true;
  kind: CodeSourceSubsystemRelationKind;
  sourceRelationCount: number;
  sourceRelationIds: readonly string[];
  evidenceSample: readonly CodeSourceSubsystemReadEvidence[];
  evidenceTruncated: boolean;
  evidenceTruncationReason?: "evidence_sample_cap";
}

export interface CodeSourceSubsystemLanguageGap {
  language: string;
  discoveredFileCount: number;
  eligibleFileCount: number | null;
  indexedFileCount: number;
  symbolCount: number;
  fidelity: string;
  semanticCoverage: string;
  gapReason: "file_only" | "no_trusted_provider_available";
}

export interface CodeSourceSubsystemReadQuality {
  eligibleProjectLocalSymbols: number;
  compatibilityRepresentedSymbols: number;
  compatibilityGroupCount: number;
  compatibilityRelationCount: number;
  compatibilitySymbolsPerGroup: number;
  compatibilityOvercompressed: boolean;
  rawCallCount: number;
  subsystemCallEvidenceCount: number;
  compatibilityCallEvidenceCount: number;
  combinedCallEvidenceSampleCount: number;
  subsystemCallEvidenceRatio: number;
  compatibilityCallEvidenceRatio: number;
  compressionBySubsystem: readonly {
    subsystemId: string;
    pathPrefix: string;
    symbolCount: number;
    notableNodeCount: number;
    symbolsPerNotableNode: number | null;
  }[];
  languageGaps: readonly CodeSourceSubsystemLanguageGap[];
}

export interface CodeSourceSubsystemRead {
  projectId: string;
  sourceIndexedAt: string;
  identityNamespaces: {
    rawNode: "code:node:*";
    compatibilityArchitectureNode: "code-map:node:*";
    sourceSubsystemNode: "code-subsystem:node:*";
    sourceSubsystemRelation: "code-subsystem:relation:*";
  };
  caps: typeof CODE_SOURCE_SUBSYSTEM_READ_CAPS;
  semantics: {
    callsPrimary: true;
    auxiliaryRelationKinds: readonly ["instantiates", "implements"];
    excludedAsStructuralEvidence: readonly [
      "depends_on",
      "external_scip",
      "name_similarity",
      "path_only_inference",
    ];
    rawRelationOwnerPreserved: true;
    registrationContextDoesNotReassignOwnership: true;
    syntheticHandlerTransitiveEdges: false;
  };
  quality: CodeSourceSubsystemReadQuality;
  nodes: readonly CodeSourceSubsystemReadNode[];
  relations: readonly CodeSourceSubsystemReadRelation[];
  truncated: boolean;
  truncation: {
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
  };
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

function stableDerivedId(namespace: "node" | "relation", value: string): string {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 20);
  return `${CODE_SOURCE_SUBSYSTEM_READ_ID_PREFIXES[namespace]}${digest}`;
}

function isEligibleProjectLocalSymbol(node: CodeNode): boolean {
  return ARCHITECTURE_SYMBOL_KINDS.has(node.kind)
    && Boolean(node.location?.path)
    && !node.canonicalIdentity.includes(":local ");
}

function rawNavigation(rawNodeId: string): CodeSourceSubsystemReadNavigation {
  return {
    rawNodeId,
    callers: {
      operation: "relations",
      nodeId: rawNodeId,
      semantic: "callers",
      limit: 50,
    },
    callees: {
      operation: "relations",
      nodeId: rawNodeId,
      semantic: "callees",
      limit: 50,
    },
  };
}

function languageGaps(
  providerCapabilities: CodeMapProviderCapabilityReport | undefined,
): CodeSourceSubsystemLanguageGap[] {
  if (!providerCapabilities) return [];
  return providerCapabilities.languages.flatMap((entry) => {
    if (entry.gapReason !== "file_only" && entry.gapReason !== "no_trusted_provider_available") {
      return [];
    }
    return [{
      language: entry.language,
      discoveredFileCount: entry.discoveredFileCount,
      eligibleFileCount: entry.eligibleFileCount,
      indexedFileCount: entry.indexedFileCount,
      symbolCount: entry.symbolCount,
      fidelity: entry.fidelity,
      semanticCoverage: entry.semanticCoverage,
      gapReason: entry.gapReason,
    }];
  });
}

export function createCodeSourceSubsystemRead(
  graph: CodeGraphSnapshot,
  compatibilityProjection: CodeArchitectureProjection,
  providerCapabilities?: CodeMapProviderCapabilityReport,
  options?: { unbounded?: boolean },
): CodeSourceSubsystemRead {
  const derived = deriveCodeSourceSubsystems(graph, options);
  const subsystemIds = new Map(
    derived.nodes.map((entry) => [
      entry.pathPrefix,
      stableDerivedId(
        "node",
        `${graph.projectId}:${entry.classification}:${entry.pathPrefix}`,
      ),
    ] as const),
  );

  const nodes: CodeSourceSubsystemReadNode[] = derived.nodes.map((entry) => ({
    id: subsystemIds.get(entry.pathPrefix)!,
    pathPrefix: entry.pathPrefix,
    classification: entry.classification,
    fileCount: entry.fileCount,
    symbolCount: entry.symbolCount,
    incomingCrossBoundaryCallCount: entry.incomingCrossBoundaryCallCount,
    outgoingCrossBoundaryCallCount: entry.outgoingCrossBoundaryCallCount,
    bridgeNodeCount: entry.bridgeNodeCount,
    registrationEntrypointCount: entry.registrationEntrypointCount,
    ...(entry.flowRoleHint ? { flowRoleHint: entry.flowRoleHint } : {}),
    selectionReasons: [...entry.selectionReasons],
    notableNodeCount: entry.notableNodeCount,
    notableNodes: entry.notableNodes.map((notable) => ({
      rawNodeId: notable.nodeId,
      name: notable.name,
      kind: notable.kind,
      path: notable.path,
      ...(notable.startLine !== undefined ? { startLine: notable.startLine } : {}),
      roles: [...notable.roles],
      selectionReasons: [...notable.selectionReasons],
      incomingCrossBoundaryCallCount: notable.incomingCrossBoundaryCallCount,
      outgoingCrossBoundaryCallCount: notable.outgoingCrossBoundaryCallCount,
      directOutgoingRelationCount: notable.directOutgoingRelationCount,
      targetSubsystemCount: notable.targetSubsystemCount,
      sourceSubsystemCount: notable.sourceSubsystemCount,
      directSourceRelationIds: [...notable.directSourceRelationIds],
      directRelationEvidenceTruncated: notable.directRelationEvidenceTruncated,
      registrationContext: notable.roles.includes("registration_handler"),
      rawRelationOwnerPreserved: true,
      navigation: rawNavigation(notable.nodeId),
    })),
    notableNodesTruncated: entry.notableNodesTruncated,
  }));

  const relations: CodeSourceSubsystemReadRelation[] = derived.relations.map((entry) => {
    const fromSubsystemId = subsystemIds.get(entry.fromPathPrefix)!;
    const toSubsystemId = subsystemIds.get(entry.toPathPrefix)!;
    return {
      id: stableDerivedId(
        "relation",
        `${graph.projectId}:${fromSubsystemId}:${entry.kind}:${toSubsystemId}`,
      ),
      fromSubsystemId,
      toSubsystemId,
      fromPathPrefix: entry.fromPathPrefix,
      toPathPrefix: entry.toPathPrefix,
      directed: true,
      kind: entry.kind,
      sourceRelationCount: entry.sourceRelationCount,
      sourceRelationIds: [...entry.sourceRelationIds],
      evidenceSample: entry.evidenceSample.map((sample) => ({ ...sample })),
      evidenceTruncated: entry.evidenceTruncated,
      ...(entry.evidenceTruncationReason
        ? { evidenceTruncationReason: entry.evidenceTruncationReason }
        : {}),
    };
  });

  const eligible = new Set(
    graph.nodes.filter(isEligibleProjectLocalSymbol).map((node) => node.id),
  );
  const compatibilityRepresented = new Set(
    compatibilityProjection.nodes.flatMap((node) =>
      node.memberNodeIds.filter((nodeId) => eligible.has(nodeId))),
  );
  const rawCalls = graph.relations.filter((relation) => relation.kind === "calls");
  const rawCallIds = new Set(rawCalls.map((relation) => relation.id));
  const subsystemCallEvidenceSample = new Set(
    derived.relations
      .filter((relation) => relation.kind === "calls")
      .flatMap((relation) => relation.sourceRelationIds),
  );
  const subsystemCallEvidenceCount = derived.relations
    .filter((relation) => relation.kind === "calls")
    .reduce((total, relation) => total + relation.sourceRelationCount, 0);
  const compatibilityCallEvidence = new Set(
    compatibilityProjection.relations
      .flatMap((relation) => relation.sourceRelationIds)
      .filter((relationId) => rawCallIds.has(relationId)),
  );
  const combinedCallEvidenceSample = new Set([
    ...subsystemCallEvidenceSample,
    ...compatibilityCallEvidence,
  ]);
  const compatibilityGroupCount = compatibilityProjection.nodes.length;

  return {
    projectId: graph.projectId,
    sourceIndexedAt: graph.indexedAt,
    identityNamespaces: {
      rawNode: "code:node:*",
      compatibilityArchitectureNode: "code-map:node:*",
      sourceSubsystemNode: "code-subsystem:node:*",
      sourceSubsystemRelation: "code-subsystem:relation:*",
    },
    caps: CODE_SOURCE_SUBSYSTEM_READ_CAPS,
    semantics: {
      callsPrimary: true,
      auxiliaryRelationKinds: ["instantiates", "implements"],
      excludedAsStructuralEvidence: [
        "depends_on",
        "external_scip",
        "name_similarity",
        "path_only_inference",
      ],
      rawRelationOwnerPreserved: true,
      registrationContextDoesNotReassignOwnership: true,
      syntheticHandlerTransitiveEdges: false,
    },
    quality: {
      eligibleProjectLocalSymbols: eligible.size,
      compatibilityRepresentedSymbols: compatibilityRepresented.size,
      compatibilityGroupCount,
      compatibilityRelationCount: compatibilityProjection.relations.length,
      compatibilitySymbolsPerGroup:
        compatibilityGroupCount > 0 ? eligible.size / compatibilityGroupCount : 0,
      compatibilityOvercompressed:
        compatibilityProjection.quality.reason === "overcompressed",
      rawCallCount: rawCalls.length,
      subsystemCallEvidenceCount,
      compatibilityCallEvidenceCount: compatibilityCallEvidence.size,
      combinedCallEvidenceSampleCount: combinedCallEvidenceSample.size,
      subsystemCallEvidenceRatio:
        rawCalls.length > 0 ? subsystemCallEvidenceCount / rawCalls.length : 0,
      compatibilityCallEvidenceRatio:
        rawCalls.length > 0 ? compatibilityCallEvidence.size / rawCalls.length : 0,
      compressionBySubsystem: nodes.map((node) => ({
        subsystemId: node.id,
        pathPrefix: node.pathPrefix,
        symbolCount: node.symbolCount,
        notableNodeCount: node.notableNodeCount,
        symbolsPerNotableNode:
          node.notableNodeCount > 0 ? node.symbolCount / node.notableNodeCount : null,
      })),
      languageGaps: languageGaps(providerCapabilities),
    },
    nodes,
    relations,
    truncated: derived.truncated,
    truncation: {
      subsystems: { ...derived.truncation.subsystems },
      relations: { ...derived.truncation.relations },
    },
  };
}

function subsystemQueryOffset(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new CodeMapQueryError("code_map_query_invalid", "subsystem query offset must be a non-negative integer");
  }
  return value;
}

function subsystemQueryLimit(
  operation: CodeSourceSubsystemQueryOperation,
  value: number | undefined,
): number {
  const maximum = operation === "list_subsystems"
    ? CODE_SOURCE_SUBSYSTEM_READ_CAPS.subsystems
    : CODE_SOURCE_SUBSYSTEM_READ_CAPS.relations;
  if (value === undefined) return maximum;
  if (!Number.isInteger(value) || value < 1) {
    throw new CodeMapQueryError("code_map_query_invalid", "subsystem query limit must be a positive integer");
  }
  return Math.min(value, maximum);
}

function subsystemQueryText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function subsystemPageEnvelope(
  graph: CodeGraphSnapshot,
  operation: CodeSourceSubsystemQueryOperation,
  candidateCount: number,
  offset: number,
  limit: number,
  returnedCount: number,
  snapshotId?: string,
): CodeSourceSubsystemQueryEnvelope {
  const hasMore = offset + returnedCount < candidateCount;
  return {
    projectId: graph.projectId,
    ...(snapshotId ? { snapshotId } : {}),
    operation,
    sourceIndexedAt: graph.indexedAt,
    candidateCount,
    offset,
    limit,
    returnedCount,
    hasMore,
    ...(hasMore ? { nextOffset: offset + returnedCount } : {}),
    truncated: hasMore,
    ...(hasMore ? { reason: "page_cap" as const } : {}),
  };
}

export function queryCodeSourceSubsystems(
  graph: CodeGraphSnapshot,
  compatibilityProjection: CodeArchitectureProjection,
  input: CodeSourceSubsystemQueryInput,
  providerCapabilities?: CodeMapProviderCapabilityReport,
  currentSnapshotId?: string,
): CodeSourceSubsystemQueryResult {
  const offset = subsystemQueryOffset(input.offset);
  const limit = subsystemQueryLimit(input.operation, input.limit);
  assertCodeMapExactPageSnapshot(
    { offset, expectedSourceIndexedAt: input.expectedSourceIndexedAt, expectedSnapshotId: input.expectedSnapshotId },
    { indexedAt: graph.indexedAt, snapshotId: currentSnapshotId },
    "subsystem",
  );

  const full = createCodeSourceSubsystemRead(
    graph,
    compatibilityProjection,
    providerCapabilities,
    { unbounded: true },
  );

  if (input.operation === "list_subsystems") {
    if (
      input.fromPathPrefix !== undefined
      || input.toPathPrefix !== undefined
      || input.relationKinds !== undefined
    ) {
      throw new CodeMapQueryError(
        "code_map_query_invalid",
        "list_subsystems accepts only pathPrefix plus pagination controls",
      );
    }
    const pathPrefix = subsystemQueryText(input.pathPrefix);
    const candidates = full.nodes.filter((node) =>
      !pathPrefix || node.pathPrefix.startsWith(pathPrefix));
    const nodes = candidates.slice(offset, offset + limit);
    return {
      ...subsystemPageEnvelope(graph, input.operation, candidates.length, offset, limit, nodes.length, currentSnapshotId),
      operation: "list_subsystems",
      nodes,
    };
  }

  if (input.pathPrefix !== undefined) {
    throw new CodeMapQueryError(
      "code_map_query_invalid",
      "list_relations accepts fromPathPrefix/toPathPrefix/relationKinds plus pagination controls",
    );
  }
  const fromPathPrefix = subsystemQueryText(input.fromPathPrefix);
  const toPathPrefix = subsystemQueryText(input.toPathPrefix);
  const relationKinds = input.relationKinds?.map((kind) => {
    if (!(CODE_SOURCE_SUBSYSTEM_RELATION_KINDS as readonly string[]).includes(kind)) {
      throw new CodeMapQueryError("code_map_query_invalid", `Unknown subsystem relation kind: ${kind}`);
    }
    return kind;
  });
  const kindSet = relationKinds ? new Set(relationKinds) : undefined;
  const candidates = full.relations
    .filter((relation) => !fromPathPrefix || relation.fromPathPrefix.startsWith(fromPathPrefix))
    .filter((relation) => !toPathPrefix || relation.toPathPrefix.startsWith(toPathPrefix))
    .filter((relation) => !kindSet || kindSet.has(relation.kind));
  const relations = candidates.slice(offset, offset + limit);
  return {
    ...subsystemPageEnvelope(graph, input.operation, candidates.length, offset, limit, relations.length, currentSnapshotId),
    operation: "list_relations",
    relations,
  };
}
