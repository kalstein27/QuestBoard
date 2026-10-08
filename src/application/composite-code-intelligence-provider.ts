import { createHash } from "node:crypto";
import {
  CODE_GRAPH_SCHEMA_VERSION,
  CODE_FIDELITY_LEVELS,
  assertValidCodeGraphSnapshot,
  type CodeFactProvenance,
  type CodeFidelityLevel,
  type CodeGraphCoverage,
  type CodeGraphSnapshot,
  type CodeIndexRequest,
  type CodeIntelligenceCapabilities,
  type CodeIntelligenceProvider,
  type CodeLanguageCoverage,
  type CodeNode,
  type CodeProviderCoverage,
  type CodeRelation,
} from "./code-intelligence.js";
import {
  inferCodeLanguageFromPath,
  materializeCodeFileHierarchy,
  type CodeFileInventory,
} from "./code-map-hierarchy.js";

export interface CompositeCodeIntelligenceProviderOptions {
  now?: () => string;
}

interface ProviderContribution {
  provider: CodeIntelligenceProvider;
  providerId: string;
  status: "fresh" | "stale";
  graph: CodeGraphSnapshot;
}

const FIDELITY_RANK = new Map<CodeFidelityLevel, number>(
  CODE_FIDELITY_LEVELS.map((value, index) => [value, index]),
);

function normalizedPath(value: string | undefined): string {
  return (value ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
}

function locationKey(location: CodeNode["location"]): string {
  if (!location) return "";
  return [
    normalizedPath(location.path),
    location.startLine ?? "",
    location.startColumn ?? "",
    location.endLine ?? "",
    location.endColumn ?? "",
  ].join(":");
}

function nodeMergeKey(node: CodeNode): string {
  return [
    node.canonicalIdentity,
    node.kind,
    node.language?.toLowerCase() ?? "",
    locationKey(node.location),
  ].join("\u0000");
}

function stableRelationId(value: string): string {
  return `code:relation:${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function relationMergeKey(relation: Pick<CodeRelation, "from" | "to" | "kind">): string {
  return `${relation.from}\u0000${relation.kind}\u0000${relation.to}`;
}

function provenanceKey(provenance: CodeFactProvenance): string {
  return provenance.providerId;
}

function mergeProvenance(
  existing: readonly CodeFactProvenance[] | undefined,
  additions: readonly CodeFactProvenance[],
): CodeFactProvenance[] {
  const byProvider = new Map<string, CodeFactProvenance>();
  for (const entry of existing ?? []) byProvider.set(provenanceKey(entry), entry);
  for (const entry of additions) byProvider.set(provenanceKey(entry), entry);
  return [...byProvider.values()].sort((left, right) => left.providerId.localeCompare(right.providerId));
}

function providerProvenance(
  provider: CodeIntelligenceProvider,
  providerId: string,
  freshness: "fresh" | "stale",
): CodeFactProvenance {
  return {
    providerId,
    ...(provider.fidelity ? { fidelity: provider.fidelity } : {}),
    freshness,
  };
}

function annotateContribution(contribution: ProviderContribution): CodeGraphSnapshot {
  const provenance = providerProvenance(
    contribution.provider,
    contribution.providerId,
    contribution.status,
  );
  return {
    ...contribution.graph,
    nodes: contribution.graph.nodes.map((node) => ({
      ...node,
      provenance: mergeProvenance(node.provenance, [provenance]),
    })),
    relations: contribution.graph.relations.map((relation) => ({
      ...relation,
      provenance: mergeProvenance(relation.provenance, [provenance]),
    })),
  };
}

function mergeEvidence(
  existing: CodeRelation["evidence"],
  additions: CodeRelation["evidence"],
): CodeRelation["evidence"] {
  const byKey = new Map<string, NonNullable<CodeRelation["evidence"]>[number]>();
  for (const evidence of [...(existing ?? []), ...(additions ?? [])]) {
    byKey.set(JSON.stringify({ location: evidence.location, label: evidence.label }), evidence);
  }
  const values = [...byKey.values()];
  return values.length > 0 ? values : undefined;
}

function mergeProviderGraphs(
  request: CodeIndexRequest,
  contributions: readonly ProviderContribution[],
): CodeGraphSnapshot {
  const nodes: CodeNode[] = [];
  const relations: CodeRelation[] = [];
  const nodeByMergeKey = new Map<string, CodeNode>();
  const disputedLexicalExtent = new Set<string>();
  const nodeIdByProviderId = new Map<string, Map<string, string>>();
  const usedNodeIds = new Set<string>();
  const relationByMergeKey = new Map<string, CodeRelation>();
  const usedRelationIds = new Set<string>();

  for (const contribution of contributions) {
    const graph = annotateContribution(contribution);
    const idMap = new Map<string, string>();
    nodeIdByProviderId.set(contribution.providerId, idMap);

    for (const node of graph.nodes) {
      const key = nodeMergeKey(node);
      const existing = nodeByMergeKey.get(key);
      if (existing) {
        idMap.set(node.id, existing.id);
        const merged: CodeNode = {
          ...existing,
          ...(existing.language === undefined && node.language !== undefined ? { language: node.language } : {}),
          ...(existing.location === undefined && node.location !== undefined ? { location: node.location } : {}),
          ...(disputedLexicalExtent.has(key)
            || (existing.lexicalExtent && node.lexicalExtent
              && locationKey(existing.lexicalExtent) !== locationKey(node.lexicalExtent))
            ? { lexicalExtent: undefined }
            : existing.lexicalExtent === undefined && node.lexicalExtent !== undefined
              ? { lexicalExtent: node.lexicalExtent } : {}),
          ...(existing.signature === undefined && node.signature !== undefined ? { signature: node.signature } : {}),
          ...(existing.exported === undefined && node.exported !== undefined ? { exported: node.exported } : {}),
          provenance: mergeProvenance(existing.provenance, node.provenance ?? []),
        };
        const index = nodes.findIndex((candidate) => candidate.id === existing.id);
        if (existing.lexicalExtent && node.lexicalExtent
          && locationKey(existing.lexicalExtent) !== locationKey(node.lexicalExtent)) disputedLexicalExtent.add(key);
        nodes[index] = merged;
        nodeByMergeKey.set(key, merged);
        continue;
      }

      let id = node.id;
      if (usedNodeIds.has(id)) {
        id = `code:node:${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
      }
      const added = id === node.id ? node : { ...node, id };
      nodes.push(added);
      usedNodeIds.add(id);
      nodeByMergeKey.set(key, added);
      idMap.set(node.id, id);
    }
  }

  for (const contribution of contributions) {
    const graph = annotateContribution(contribution);
    const idMap = nodeIdByProviderId.get(contribution.providerId)!;
    for (const relation of graph.relations) {
      const remapped: CodeRelation = {
        ...relation,
        from: idMap.get(relation.from) ?? relation.from,
        to: idMap.get(relation.to) ?? relation.to,
      };
      const key = relationMergeKey(remapped);
      const existing = relationByMergeKey.get(key);
      if (existing) {
        const evidence = mergeEvidence(existing.evidence, remapped.evidence);
        const merged: CodeRelation = {
          ...existing,
          confidence: Math.max(existing.confidence, remapped.confidence),
          ...(evidence ? { evidence } : {}),
          provenance: mergeProvenance(existing.provenance, remapped.provenance ?? []),
        };
        const index = relations.findIndex((candidate) => candidate.id === existing.id);
        relations[index] = merged;
        relationByMergeKey.set(key, merged);
        continue;
      }

      let id = remapped.id;
      if (usedRelationIds.has(id)) id = stableRelationId(key);
      const added = id === remapped.id ? remapped : { ...remapped, id };
      relations.push(added);
      usedRelationIds.add(id);
      relationByMergeKey.set(key, added);
    }
  }

  return {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId: request.projectId,
    rootPath: request.rootPath,
    indexedAt: contributions
      .map((entry) => entry.graph.indexedAt)
      .sort()
      .at(-1) ?? new Date(0).toISOString(),
    nodes,
    relations,
    ...(contributions.some((contribution) => contribution.graph.providerRuns?.length) ? {
      providerRuns: contributions.flatMap((contribution) => contribution.graph.providerRuns ?? [])
        .sort((a, b) => a.providerId.localeCompare(b.providerId)),
    } : {}),
  };
}

function maxFidelity(values: readonly (CodeFidelityLevel | undefined)[]): CodeFidelityLevel {
  let selected: CodeFidelityLevel = "file-only";
  for (const value of values) {
    if (value && (FIDELITY_RANK.get(value) ?? 0) > (FIDELITY_RANK.get(selected) ?? 0)) selected = value;
  }
  return selected;
}

function languageCoverage(
  graph: CodeGraphSnapshot,
  providers: readonly CodeProviderCoverage[],
  contributions: readonly ProviderContribution[],
): CodeLanguageCoverage[] {
  const fileNodes = graph.nodes.filter((node) => node.kind === "file" && node.location?.path);
  const filesByLanguage = new Map<string, CodeNode[]>();
  for (const file of fileNodes) {
    const language = file.language ?? inferCodeLanguageFromPath(file.location!.path) ?? "unknown";
    const bucket = filesByLanguage.get(language) ?? [];
    bucket.push(file);
    filesByLanguage.set(language, bucket);
  }

  return [...filesByLanguage.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([language, files]) => {
      const paths = new Set(files.map((file) => normalizedPath(file.location?.path)));
      const facts = graph.nodes.filter((node) => node.location?.path && paths.has(normalizedPath(node.location.path)));
      const provenance = facts.flatMap((node) => node.provenance ?? []);
      const providerIds = [...new Set(provenance.map((entry) => entry.providerId))].sort();
      const fidelity = maxFidelity(provenance.map((entry) => entry.fidelity));
      const affectedByProviderFailure = providers.some((provider) =>
        provider.status !== "fresh"
        && (provider.languages === undefined || provider.languages.includes(language)),
      );
      const semanticScopes = contributions
        .map((contribution) => contribution.graph.coverage?.languages.find((entry) => entry.language === language))
        .filter((entry): entry is CodeLanguageCoverage => Boolean(entry?.semanticEligibleFileCount !== undefined));
      const semanticEligibleFileCount = semanticScopes.length > 0
        ? Math.max(...semanticScopes.map((entry) => entry.semanticEligibleFileCount ?? 0))
        : undefined;
      const semanticIndexedFileCount = semanticScopes.length > 0
        ? Math.max(...semanticScopes.map((entry) => entry.semanticIndexedFileCount ?? entry.semanticEligibleFileCount ?? 0))
        : undefined;
      const semanticExcludedFileCount = semanticEligibleFileCount === undefined
        ? undefined
        : Math.max(0, files.length - semanticEligibleFileCount);
      return {
        language,
        fileCount: files.length,
        ...(semanticEligibleFileCount !== undefined ? { semanticEligibleFileCount } : {}),
        ...(semanticIndexedFileCount !== undefined ? { semanticIndexedFileCount } : {}),
        ...(semanticExcludedFileCount !== undefined ? { semanticExcludedFileCount } : {}),
        ...(semanticExcludedFileCount ? { semanticExclusionReason: "provider_project_scope" as const } : {}),
        fidelity,
        providerIds,
        degraded: affectedByProviderFailure,
      };
    });
}

function makeCoverage(
  graph: CodeGraphSnapshot,
  providers: readonly CodeProviderCoverage[],
  contributions: readonly ProviderContribution[],
): CodeGraphCoverage {
  return {
    degraded: providers.some((provider) => provider.status !== "fresh"),
    providers,
    languages: languageCoverage(graph, providers, contributions),
  };
}

/**
 * Provider-neutral fan-in for mixed-language Code Map indexing.
 *
 * Provider order is significant only for stable identity preservation: the first
 * contribution that describes an exact logical node/relation keeps its stable id.
 * Later providers merge provenance/evidence into that fact instead of replacing it.
 */
export class CompositeCodeIntelligenceProvider implements CodeIntelligenceProvider {
  readonly providerId: string;
  readonly capabilities: CodeIntelligenceCapabilities;
  readonly #providers: readonly CodeIntelligenceProvider[];
  readonly #fileInventory: CodeFileInventory;
  readonly #now: () => string;
  readonly #lastGood = new Map<string, Map<string, CodeGraphSnapshot>>();

  constructor(
    providers: readonly CodeIntelligenceProvider[],
    fileInventory: CodeFileInventory,
    options: CompositeCodeIntelligenceProviderOptions = {},
  ) {
    const ids = providers.map((provider, index) => provider.providerId?.trim() || `provider-${index + 1}`);
    if (new Set(ids).size !== ids.length) throw new TypeError("Composite Code Map provider ids must be unique");
    this.#providers = providers;
    this.#fileInventory = fileInventory;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.providerId = providers.length === 0
      ? "file-inventory"
      : providers.length === 1
        ? ids[0]!
        : "composite";
    this.capabilities = {
      incrementalIndexing: providers.length > 0 && providers.every((provider) => provider.capabilities.incrementalIndexing),
      impactAnalysis: providers.some((provider) => provider.capabilities.impactAnalysis),
      callTrace: providers.some((provider) => provider.capabilities.callTrace),
    };
  }

  async indexProject(request: CodeIndexRequest): Promise<CodeGraphSnapshot> {
    const inventory = await this.#fileInventory.listFiles(request.rootPath);
    const contributions: ProviderContribution[] = [];
    const providerCoverage: CodeProviderCoverage[] = [];

    for (const [index, provider] of this.#providers.entries()) {
      const providerId = provider.providerId?.trim() || `provider-${index + 1}`;
      try {
        const graph = await provider.indexProject(request);
        if (graph.projectId !== request.projectId) {
          throw new Error(`Code intelligence provider ${providerId} returned project ${graph.projectId} for ${request.projectId}`);
        }
        if (graph.rootPath !== request.rootPath) {
          throw new Error(`Code intelligence provider ${providerId} returned root ${graph.rootPath} for ${request.rootPath}`);
        }
        assertValidCodeGraphSnapshot(graph);
        const byProject = this.#lastGood.get(providerId) ?? new Map<string, CodeGraphSnapshot>();
        byProject.set(request.projectId, graph);
        this.#lastGood.set(providerId, byProject);
        contributions.push({ provider, providerId, status: "fresh", graph });
        providerCoverage.push({
          providerId,
          status: "fresh",
          ...(provider.fidelity ? { fidelity: provider.fidelity } : {}),
          ...(provider.languages ? { languages: [...provider.languages] } : {}),
          nodeCount: graph.nodes.length,
          relationCount: graph.relations.length,
        });
      } catch {
        const stale = this.#lastGood.get(providerId)?.get(request.projectId);
        if (stale) {
          contributions.push({ provider, providerId, status: "stale", graph: stale });
          providerCoverage.push({
            providerId,
            status: "stale",
            ...(provider.fidelity ? { fidelity: provider.fidelity } : {}),
            ...(provider.languages ? { languages: [...provider.languages] } : {}),
            nodeCount: stale.nodes.length,
            relationCount: stale.relations.length,
          });
        } else {
          providerCoverage.push({
            providerId,
            status: "failed",
            ...(provider.fidelity ? { fidelity: provider.fidelity } : {}),
            ...(provider.languages ? { languages: [...provider.languages] } : {}),
            nodeCount: 0,
            relationCount: 0,
          });
        }
      }
    }

    const merged = mergeProviderGraphs(request, contributions);
    const withFiles = materializeCodeFileHierarchy(
      { ...merged, indexedAt: this.#now() },
      inventory,
    );
    const coverage = makeCoverage(withFiles, providerCoverage, contributions);
    const snapshot: CodeGraphSnapshot = { ...withFiles, coverage };
    assertValidCodeGraphSnapshot(snapshot);
    return snapshot;
  }
}
