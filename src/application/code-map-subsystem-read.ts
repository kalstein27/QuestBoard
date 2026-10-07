import { createHash } from "node:crypto";
import type { CodeGraphSnapshot, CodeNode, CodeSourceLocation } from "./code-intelligence.js";
import type { CodeMapProviderCapabilityReport } from "./code-map-provider-registry.js";
import type { CodeArchitectureProjection } from "./code-map-projection.js";
import {
  deriveCodeSourceSubsystems,
  type CodeSourceSubsystemRelationKind,
} from "./code-map-subsystems.js";

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
): CodeSourceSubsystemRead {
  const derived = deriveCodeSourceSubsystems(graph);
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
