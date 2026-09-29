import {
  assertValidCodeGraphSnapshot,
  type CodeGraphSnapshot,
  type CodeIndexRequest,
  type CodeIntelligenceProvider,
} from "./code-intelligence.js";
import {
  overlayCodeMapTasks,
  type CodeMapTaskLink,
  type CodeMapTaskOverlay,
} from "./code-map-overlay.js";
import {
  projectCodeArchitecture,
  type CodeArchitectureProjection,
} from "./code-map-projection.js";
import {
  materializeCodeFileHierarchy,
  type CodeFileInventory,
} from "./code-map-hierarchy.js";
import {
  CodeMapQueryError,
  queryCodeGraph,
  type CodeMapQueryInput,
  type CodeMapQueryResult,
} from "./code-map-query.js";
import {
  CodeMapProviderRegistry,
  type CodeMapProviderCapabilityReport,
  type CodeProviderInstallRequest,
} from "./code-map-provider-registry.js";
import {
  augmentCodeGraphWithManualRelations,
  projectCodeMapManualRelations,
  type CodeMapManualRelationReader,
  type CodeMapManualRelationView,
} from "./code-map-augmentation.js";

export type CodeMapRefreshMode = "full" | "incremental" | "cache-hit";

export interface CodeMapSnapshot {
  /** Canonical provider-neutral Code Map source of truth. */
  graph: CodeGraphSnapshot;
  /** Compatibility / optional human architecture lens derived from graph. */
  projection: CodeArchitectureProjection;
}

export interface CodeMapRefreshResult extends CodeMapSnapshot {
  mode: CodeMapRefreshMode;
  changedCodeNodeIds: readonly string[];
  /** Compatibility signal for consumers that still use the architecture lens. */
  changedArchitectureNodeIds: readonly string[];
}

function codeRelationFingerprint(relation: CodeGraphSnapshot["relations"][number]): string {
  return JSON.stringify({
    from: relation.from,
    to: relation.to,
    kind: relation.kind,
    confidence: relation.confidence,
    evidence: [...(relation.evidence ?? [])]
      .map((entry) => ({ location: entry.location, label: entry.label }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    provenance: [...(relation.provenance ?? [])]
      .map((entry) => ({
        providerId: entry.providerId,
        fidelity: entry.fidelity,
        freshness: entry.freshness,
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  });
}

function codeNodeFingerprint(
  node: CodeGraphSnapshot["nodes"][number],
  graph: CodeGraphSnapshot,
): string {
  const attachedRelations = graph.relations
    .filter((relation) => relation.from === node.id || relation.to === node.id)
    .map((relation) => `${relation.id}:${codeRelationFingerprint(relation)}`)
    .sort();
  return JSON.stringify({
    kind: node.kind,
    name: node.name,
    canonicalIdentity: node.canonicalIdentity,
    language: node.language,
    location: node.location,
    signature: node.signature,
    exported: node.exported,
    provenance: [...(node.provenance ?? [])]
      .map((entry) => ({
        providerId: entry.providerId,
        fidelity: entry.fidelity,
        freshness: entry.freshness,
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    relations: attachedRelations,
  });
}

function changedCodeNodeIds(
  previous: CodeGraphSnapshot | undefined,
  next: CodeGraphSnapshot,
): string[] {
  if (!previous) return next.nodes.map((node) => node.id).sort();

  const previousById = new Map(previous.nodes.map((node) => [node.id, node] as const));
  const nextById = new Map(next.nodes.map((node) => [node.id, node] as const));
  const allIds = new Set([...previousById.keys(), ...nextById.keys()]);
  const changed: string[] = [];

  for (const id of allIds) {
    const before = previousById.get(id);
    const after = nextById.get(id);
    if (!before || !after) {
      changed.push(id);
      continue;
    }
    if (codeNodeFingerprint(before, previous) !== codeNodeFingerprint(after, next)) {
      changed.push(id);
    }
  }
  return changed.sort();
}

function architectureNodeFingerprint(
  node: CodeArchitectureProjection["nodes"][number],
  projection: CodeArchitectureProjection,
): string {
  const attachedRelations = projection.relations
    .filter((relation) => relation.from === node.id || relation.to === node.id)
    .map((relation) => `${relation.from}:${relation.kind}:${relation.to}`)
    .sort();
  return JSON.stringify({
    kind: node.kind,
    title: node.title,
    members: [...node.memberNodeIds].sort(),
    relations: attachedRelations,
  });
}

function changedArchitectureNodeIds(
  previous: CodeArchitectureProjection | undefined,
  next: CodeArchitectureProjection,
): string[] {
  if (!previous) return next.nodes.map((node) => node.id);

  const previousById = new Map(previous.nodes.map((node) => [node.id, node] as const));
  const nextById = new Map(next.nodes.map((node) => [node.id, node] as const));
  const allIds = new Set([...previousById.keys(), ...nextById.keys()]);
  const changed: string[] = [];

  for (const id of allIds) {
    const before = previousById.get(id);
    const after = nextById.get(id);
    if (!before || !after) {
      changed.push(id);
      continue;
    }
    if (
      architectureNodeFingerprint(before, previous) !==
      architectureNodeFingerprint(after, next)
    ) {
      changed.push(id);
    }
  }
  return changed.sort();
}

export class CodeMapService {
  readonly #provider: CodeIntelligenceProvider;
  readonly #fileInventory: CodeFileInventory | undefined;
  readonly #providerRegistry: CodeMapProviderRegistry | undefined;
  readonly #manualRelations: CodeMapManualRelationReader | undefined;
  readonly #cache = new Map<string, CodeMapSnapshot>();

  constructor(
    provider: CodeIntelligenceProvider,
    fileInventory?: CodeFileInventory,
    providerRegistry?: CodeMapProviderRegistry,
    manualRelations?: CodeMapManualRelationReader,
  ) {
    this.#provider = provider;
    this.#fileInventory = fileInventory;
    this.#providerRegistry = providerRegistry;
    this.#manualRelations = manualRelations;
  }

  get capabilities(): CodeIntelligenceProvider["capabilities"] {
    return this.#provider.capabilities;
  }

  get providerId(): string {
    return this.#provider.providerId ?? "unknown";
  }

  getCached(projectId: string): CodeMapSnapshot | undefined {
    return this.#cache.get(projectId);
  }

  providerCapabilities(projectId: string): CodeMapProviderCapabilityReport | undefined {
    return this.#providerRegistry?.report(this.#cache.get(projectId)?.graph);
  }

  requestProviderInstall(projectId: string, providerId: string): CodeProviderInstallRequest {
    if (!this.#providerRegistry) {
      throw new Error("Code Map provider registry is not available in this runtime");
    }
    return this.#providerRegistry.requestInstall(projectId, providerId);
  }

  manualRelations(projectId: string): CodeMapManualRelationView[] {
    const cached = this.#cache.get(projectId);
    if (!cached || !this.#manualRelations) return [];
    return projectCodeMapManualRelations(
      cached.graph,
      this.#manualRelations.listCodeMapManualRelations(projectId),
    );
  }

  async refresh(request: CodeIndexRequest): Promise<CodeMapRefreshResult> {
    const cached = this.#cache.get(request.projectId);
    if (cached && request.changes && request.changes.length === 0) {
      return {
        ...cached,
        mode: "cache-hit",
        changedCodeNodeIds: [],
        changedArchitectureNodeIds: [],
      };
    }

    const providerGraph = await this.#provider.indexProject(request);
    if (providerGraph.projectId !== request.projectId) {
      throw new Error(
        `Code intelligence provider returned project ${providerGraph.projectId} for ${request.projectId}`,
      );
    }
    if (providerGraph.rootPath !== request.rootPath) {
      throw new Error(
        `Code intelligence provider returned root ${providerGraph.rootPath} for ${request.rootPath}`,
      );
    }
    assertValidCodeGraphSnapshot(providerGraph);

    const graph = this.#fileInventory
      ? materializeCodeFileHierarchy(
          providerGraph,
          await this.#fileInventory.listFiles(request.rootPath),
        )
      : providerGraph;

    const projection = projectCodeArchitecture(graph);
    const changedRawNodeIds = changedCodeNodeIds(cached?.graph, graph);
    const changedMacroNodeIds = changedArchitectureNodeIds(cached?.projection, projection);
    const snapshot: CodeMapSnapshot = { graph, projection };
    this.#cache.set(request.projectId, snapshot);

    return {
      ...snapshot,
      mode: cached && request.changes ? "incremental" : "full",
      changedCodeNodeIds: changedRawNodeIds,
      changedArchitectureNodeIds: changedMacroNodeIds,
    };
  }

  query(projectId: string, input: CodeMapQueryInput): CodeMapQueryResult {
    const cached = this.#cache.get(projectId);
    if (!cached) {
      throw new CodeMapQueryError(
        "code_map_not_indexed",
        `Code Map has not been indexed for project ${projectId}`,
      );
    }
    const graph = this.#manualRelations
      ? augmentCodeGraphWithManualRelations(
          cached.graph,
          this.#manualRelations.listCodeMapManualRelations(projectId),
        )
      : cached.graph;
    return queryCodeGraph(graph, this.providerId, input);
  }

  overlayTasks(projectId: string, links: readonly CodeMapTaskLink[]): CodeMapTaskOverlay {
    const cached = this.#cache.get(projectId);
    if (!cached) {
      throw new Error(`Code Map has not been indexed for project ${projectId}`);
    }
    return overlayCodeMapTasks(cached.projection, links);
  }

  invalidate(projectId: string): void {
    this.#cache.delete(projectId);
  }
}
