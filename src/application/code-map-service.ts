import { randomUUID } from "node:crypto";
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
  createCodeSourceSubsystemRead,
  type CodeSourceSubsystemRead,
} from "./code-map-subsystem-read.js";
import {
  materializeCodeFileHierarchy,
  type CodeFileInventory,
} from "./code-map-hierarchy.js";
import {
  inspectCodeMapPreflight,
  type CodeMapPreflightReport,
} from "./code-map-preflight.js";
import {
  CodeMapQueryError,
  queryCodeGraph,
  type CodeMapQueryInput,
  type CodeMapQueryResult,
} from "./code-map-query.js";
import {
  CodeMapProviderRegistry,
  CodeProviderLifecycleError,
  type CodeMapProviderCapabilityReport,
  type CodeProviderInstallRequest,
} from "./code-map-provider-registry.js";
import {
  augmentCodeGraphWithManualRelations,
  projectCodeMapManualRelations,
  type CodeMapManualRelationReader,
  type CodeMapManualRelationView,
} from "./code-map-augmentation.js";
import { CODE_GRAPH_SCHEMA_VERSION } from "./code-intelligence.js";
import {
  CODE_MAP_PERSISTED_SNAPSHOT_FORMAT_VERSION,
  type CodeMapHydrationDiagnostic,
  type CodeMapHydrationRejectReason,
  type CodeMapPersistenceConfig,
  type CodeMapSnapshotLifecycleState,
  type PersistedCodeMapSnapshotEnvelope,
} from "./code-map-persistence.js";
import type { CodeMapRefreshJobReceipt } from "./code-map-persistence.js";

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

function pushAttachedRelation(
  index: Map<string, string[]>,
  nodeId: string,
  fingerprint: string,
): void {
  const existing = index.get(nodeId);
  if (existing) existing.push(fingerprint);
  else index.set(nodeId, [fingerprint]);
}

function codeRelationFingerprintsByNode(graph: CodeGraphSnapshot): Map<string, readonly string[]> {
  const index = new Map<string, string[]>();
  for (const relation of graph.relations) {
    const fingerprint = `${relation.id}:${codeRelationFingerprint(relation)}`;
    pushAttachedRelation(index, relation.from, fingerprint);
    if (relation.to !== relation.from) pushAttachedRelation(index, relation.to, fingerprint);
  }
  for (const fingerprints of index.values()) fingerprints.sort();
  return index;
}

function codeNodeFingerprint(
  node: CodeGraphSnapshot["nodes"][number],
  attachedRelations: readonly string[],
): string {
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
  const previousRelationsByNode = codeRelationFingerprintsByNode(previous);
  const nextRelationsByNode = codeRelationFingerprintsByNode(next);
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
      codeNodeFingerprint(before, previousRelationsByNode.get(id) ?? [])
      !== codeNodeFingerprint(after, nextRelationsByNode.get(id) ?? [])
    ) {
      changed.push(id);
    }
  }
  return changed.sort();
}

function architectureRelationFingerprintsByNode(
  projection: CodeArchitectureProjection,
): Map<string, readonly string[]> {
  const index = new Map<string, string[]>();
  for (const relation of projection.relations) {
    const fingerprint = `${relation.from}:${relation.kind}:${relation.to}`;
    pushAttachedRelation(index, relation.from, fingerprint);
    if (relation.to !== relation.from) pushAttachedRelation(index, relation.to, fingerprint);
  }
  for (const fingerprints of index.values()) fingerprints.sort();
  return index;
}

function architectureNodeFingerprint(
  node: CodeArchitectureProjection["nodes"][number],
  attachedRelations: readonly string[],
): string {
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
  const previousRelationsByNode = architectureRelationFingerprintsByNode(previous);
  const nextRelationsByNode = architectureRelationFingerprintsByNode(next);
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
      architectureNodeFingerprint(before, previousRelationsByNode.get(id) ?? []) !==
      architectureNodeFingerprint(after, nextRelationsByNode.get(id) ?? [])
    ) {
      changed.push(id);
    }
  }
  return changed.sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRefreshJobReceipt(
  value: unknown,
  projectId: string,
  providerId: string,
): CodeMapRefreshJobReceipt | undefined {
  if (!isRecord(value)) return undefined;
  if (value.projectId !== projectId || value.providerId !== providerId) return undefined;
  if (typeof value.jobId !== "string" || typeof value.startedAt !== "string" || typeof value.updatedAt !== "string") return undefined;
  if (value.state !== "running" && value.state !== "succeeded" && value.state !== "failed") return undefined;
  if (value.phase !== "queued" && value.phase !== "indexing" && value.phase !== "complete" && value.phase !== "interrupted") return undefined;
  return value as unknown as CodeMapRefreshJobReceipt;
}

function persistedEnvelopeOrReason(
  raw: unknown,
  expectedProjectId: string,
  expectedRootIdentity: string,
  expectedProviderFingerprint: string,
): { envelope?: PersistedCodeMapSnapshotEnvelope; reason?: CodeMapHydrationRejectReason } {
  if (!isRecord(raw)) return { reason: "corrupt" };
  if (raw.formatVersion !== CODE_MAP_PERSISTED_SNAPSHOT_FORMAT_VERSION) return { reason: "format_changed" };
  if (raw.graphSchemaVersion !== CODE_GRAPH_SCHEMA_VERSION) return { reason: "schema_changed" };
  if (raw.projectId !== expectedProjectId) return { reason: "project_changed" };
  if (raw.rootIdentity !== expectedRootIdentity) return { reason: "root_changed" };
  if (raw.providerConfigFingerprint !== expectedProviderFingerprint) return { reason: "provider_changed" };
  if (!isRecord(raw.graph)) return { reason: "corrupt" };
  return { envelope: raw as unknown as PersistedCodeMapSnapshotEnvelope };
}

export class CodeMapService {
  readonly #provider: CodeIntelligenceProvider;
  readonly #fileInventory: CodeFileInventory | undefined;
  readonly #preflightInventory: CodeFileInventory | undefined;
  readonly #providerRegistry: CodeMapProviderRegistry | undefined;
  readonly #manualRelations: CodeMapManualRelationReader | undefined;
  readonly #persistence: CodeMapPersistenceConfig | undefined;
  readonly #cache = new Map<string, CodeMapSnapshot>();
  readonly #snapshotStates = new Map<string, CodeMapSnapshotLifecycleState>();
  readonly #sourceManifestFingerprints = new Map<string, string | undefined>();
  readonly #hydrationDiagnostics = new Map<string, CodeMapHydrationDiagnostic>();
  readonly #hydrationAttempted = new Set<string>();
  readonly #refreshJobs = new Map<string, CodeMapRefreshJobReceipt>();
  readonly #refreshTasks = new Map<string, Promise<void>>();

  constructor(
    provider: CodeIntelligenceProvider,
    fileInventory?: CodeFileInventory,
    providerRegistry?: CodeMapProviderRegistry,
    manualRelations?: CodeMapManualRelationReader,
    persistence?: CodeMapPersistenceConfig,
    preflightInventory?: CodeFileInventory,
  ) {
    this.#provider = provider;
    this.#fileInventory = fileInventory;
    this.#preflightInventory = preflightInventory ?? fileInventory;
    this.#providerRegistry = providerRegistry;
    this.#manualRelations = manualRelations;
    this.#persistence = persistence;
  }

  get capabilities(): CodeIntelligenceProvider["capabilities"] {
    return this.#provider.capabilities;
  }

  get providerId(): string {
    return this.#provider.providerId ?? "unknown";
  }

  getCached(projectId: string): CodeMapSnapshot | undefined {
    if (!this.#cache.has(projectId)) this.#hydrate(projectId);
    return this.#cache.get(projectId);
  }

  snapshotLifecycleState(projectId: string): CodeMapSnapshotLifecycleState | undefined {
    const cached = this.getCached(projectId);
    if (!cached) return undefined;
    return this.#refreshFreshness(projectId, cached.graph.rootPath);
  }

  hydrationDiagnostic(projectId: string): CodeMapHydrationDiagnostic | undefined {
    this.getCached(projectId);
    return this.#hydrationDiagnostics.get(projectId);
  }

  async preflight(projectId: string): Promise<CodeMapPreflightReport> {
    const cached = this.getCached(projectId)?.graph;
    const rootPath = cached?.rootPath ?? this.#persistence?.rootPathForProject?.(projectId);
    return inspectCodeMapPreflight(rootPath, this.#preflightInventory);
  }

  providerCapabilities(projectId: string): CodeMapProviderCapabilityReport | undefined {
    const cached = this.getCached(projectId)?.graph;
    const rootPath = cached?.rootPath ?? this.#persistence?.rootPathForProject?.(projectId);
    return this.#providerRegistry?.report(cached, rootPath);
  }

  sourceSubsystems(projectId: string): CodeSourceSubsystemRead {
    const cached = this.getCached(projectId);
    if (!cached) {
      throw new CodeMapQueryError(
        "code_map_not_indexed",
        `Code Map has not been indexed for project ${projectId}`,
      );
    }
    return createCodeSourceSubsystemRead(
      cached.graph,
      cached.projection,
      this.providerCapabilities(projectId),
    );
  }

  async providerCapabilitiesWithPreflight(
    projectId: string,
    canonicalRootPath?: string,
  ): Promise<CodeMapProviderCapabilityReport | undefined> {
    if (!this.#providerRegistry) return undefined;
    const cached = this.getCached(projectId)?.graph;
    const rootPath = cached?.rootPath ?? canonicalRootPath ?? this.#persistence?.rootPathForProject?.(projectId);
    if (cached) return this.#providerRegistry.report(cached, rootPath);
    const preflight = await inspectCodeMapPreflight(rootPath, this.#preflightInventory);
    return this.#providerRegistry.report(undefined, rootPath, preflight);
  }

  async requestProviderInstall(
    projectId: string,
    providerId: string,
    canonicalRootPath?: string,
  ): Promise<CodeProviderInstallRequest> {
    if (!this.#providerRegistry) {
      throw new Error("Code Map provider registry is not available in this runtime");
    }
    const capabilities = await this.providerCapabilitiesWithPreflight(projectId, canonicalRootPath);
    const projectProvider = capabilities?.providers.find((provider) => provider.providerId === providerId);
    if (projectProvider?.requirement === "not_needed") {
      throw new CodeProviderLifecycleError(
        "code_map_provider_not_needed",
        `Code Map provider ${providerId} is not needed for the languages detected in this project`,
      );
    }
    if (projectProvider?.requirement === "unknown") {
      throw new CodeProviderLifecycleError(
        "code_map_provider_requirement_unknown",
        `Code Map provider ${providerId} requirement cannot be determined until project language inventory is available`,
      );
    }
    const rootPath = this.getCached(projectId)?.graph.rootPath
      ?? canonicalRootPath
      ?? this.#persistence?.rootPathForProject?.(projectId);
    return this.#providerRegistry.requestInstall(projectId, providerId, rootPath);
  }

  refreshJob(projectId: string): CodeMapRefreshJobReceipt | undefined {
    const cached = this.#refreshJobs.get(projectId);
    if (cached) return cached;
    const load = this.#persistence?.store.loadRefreshJob;
    if (!load) return undefined;
    let parsed: CodeMapRefreshJobReceipt | undefined;
    try {
      parsed = parseRefreshJobReceipt(load.call(this.#persistence!.store, projectId), projectId, this.providerId);
    } catch {
      return undefined;
    }
    if (!parsed) return undefined;
    if (parsed.state === "running") {
      const now = this.#now();
      parsed = {
        ...parsed,
        state: "failed",
        phase: "interrupted",
        updatedAt: now,
        finishedAt: now,
        error: {
          code: "refresh_interrupted",
          message: "Code Map refresh was interrupted by a service restart",
        },
      };
      this.#persistRefreshJob(parsed);
    }
    this.#refreshJobs.set(projectId, parsed);
    return parsed;
  }

  startRefresh(request: CodeIndexRequest): CodeMapRefreshJobReceipt {
    this.#persistence?.validateStorageRootForProject?.(request.rootPath);
    const existing = this.refreshJob(request.projectId);
    if (existing?.state === "running") return existing;

    const now = this.#now();
    const receipt: CodeMapRefreshJobReceipt = {
      jobId: `refresh_${randomUUID()}`,
      projectId: request.projectId,
      providerId: this.providerId,
      state: "running",
      phase: "queued",
      startedAt: now,
      updatedAt: now,
    };
    this.#refreshJobs.set(request.projectId, receipt);
    this.#persistRefreshJob(receipt);

    queueMicrotask(() => {
      const task = this.#runRefreshJob(request, receipt.jobId);
      this.#refreshTasks.set(request.projectId, task);
      void task.finally(() => {
        if (this.#refreshTasks.get(request.projectId) === task) this.#refreshTasks.delete(request.projectId);
      });
    });
    return receipt;
  }

  manualRelations(projectId: string): CodeMapManualRelationView[] {
    const cached = this.getCached(projectId);
    if (!cached || !this.#manualRelations) return [];
    return projectCodeMapManualRelations(
      cached.graph,
      this.#manualRelations.listCodeMapManualRelations(projectId),
    );
  }

  async refresh(request: CodeIndexRequest): Promise<CodeMapRefreshResult> {
    this.#persistence?.validateStorageRootForProject?.(request.rootPath);
    const cached = this.getCached(request.projectId);
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
    this.#hydrationAttempted.add(request.projectId);
    this.#hydrationDiagnostics.delete(request.projectId);
    this.#recordFreshIndex(request.projectId, request.rootPath, graph);

    return {
      ...snapshot,
      mode: cached && request.changes ? "incremental" : "full",
      changedCodeNodeIds: changedRawNodeIds,
      changedArchitectureNodeIds: changedMacroNodeIds,
    };
  }

  async #runRefreshJob(request: CodeIndexRequest, jobId: string): Promise<void> {
    const current = this.#refreshJobs.get(request.projectId);
    if (!current || current.jobId !== jobId) return;
    const indexing: CodeMapRefreshJobReceipt = {
      ...current,
      phase: "indexing",
      updatedAt: this.#now(),
    };
    this.#refreshJobs.set(request.projectId, indexing);
    this.#persistRefreshJob(indexing);

    try {
      const refreshed = await this.refresh(request);
      const finishedAt = this.#now();
      const completed: CodeMapRefreshJobReceipt = {
        ...indexing,
        state: "succeeded",
        phase: "complete",
        updatedAt: finishedAt,
        finishedAt,
        indexedAt: refreshed.graph.indexedAt,
        mode: refreshed.mode,
        nodeCount: refreshed.graph.nodes.length,
        relationCount: refreshed.graph.relations.length,
        changedCodeNodeCount: refreshed.changedCodeNodeIds.length,
        changedArchitectureNodeCount: refreshed.changedArchitectureNodeIds.length,
      };
      this.#refreshJobs.set(request.projectId, completed);
      this.#persistRefreshJob(completed);
    } catch (error) {
      const finishedAt = this.#now();
      const failed: CodeMapRefreshJobReceipt = {
        ...indexing,
        state: "failed",
        phase: "complete",
        updatedAt: finishedAt,
        finishedAt,
        error: {
          code: "refresh_failed",
          message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        },
      };
      this.#refreshJobs.set(request.projectId, failed);
      this.#persistRefreshJob(failed);
    }
  }

  #now(): string {
    return this.#persistence?.now?.() ?? new Date().toISOString();
  }

  #persistRefreshJob(receipt: CodeMapRefreshJobReceipt): void {
    try {
      this.#persistence?.store.saveRefreshJob?.(receipt.projectId, receipt);
    } catch {
      // Job receipts improve restart recovery. In-memory lifecycle remains authoritative for this process.
    }
  }

  query(projectId: string, input: CodeMapQueryInput): CodeMapQueryResult {
    const cached = this.getCached(projectId);
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
    const cached = this.getCached(projectId);
    if (!cached) {
      throw new Error(`Code Map has not been indexed for project ${projectId}`);
    }
    return overlayCodeMapTasks(cached.projection, links);
  }

  invalidate(projectId: string): void {
    this.#cache.delete(projectId);
    this.#snapshotStates.delete(projectId);
    this.#sourceManifestFingerprints.delete(projectId);
    this.#hydrationDiagnostics.delete(projectId);
    this.#hydrationAttempted.delete(projectId);
  }

  #recordFreshIndex(projectId: string, rootPath: string, graph: CodeGraphSnapshot): void {
    const persistence = this.#persistence;
    if (!persistence) {
      this.#snapshotStates.set(projectId, { snapshotSource: "fresh-index", freshness: "unknown" });
      return;
    }

    let sourceManifestFingerprint: string | undefined;
    let state: CodeMapSnapshotLifecycleState;
    try {
      sourceManifestFingerprint = persistence.sourceState.sourceManifestFingerprint(rootPath);
      state = { snapshotSource: "fresh-index", freshness: "current" };
    } catch {
      state = {
        snapshotSource: "fresh-index",
        freshness: "unknown",
        staleReason: "source_check_failed",
      };
    }
    this.#sourceManifestFingerprints.set(projectId, sourceManifestFingerprint);
    this.#snapshotStates.set(projectId, state);

    try {
      const envelope: PersistedCodeMapSnapshotEnvelope = {
        formatVersion: CODE_MAP_PERSISTED_SNAPSHOT_FORMAT_VERSION,
        graphSchemaVersion: graph.schemaVersion,
        projectId,
        rootIdentity: persistence.sourceState.rootIdentity(rootPath),
        providerConfigFingerprint: persistence.providerConfigFingerprint,
        ...(sourceManifestFingerprint ? { sourceManifestFingerprint } : {}),
        persistedAt: persistence.now?.() ?? new Date().toISOString(),
        graph,
      };
      persistence.store.save(projectId, envelope);
    } catch {
      // Persistence is a restart optimization. A successful fresh index remains usable in memory.
    }
  }

  #refreshFreshness(projectId: string, rootPath: string): CodeMapSnapshotLifecycleState {
    const currentState = this.#snapshotStates.get(projectId)
      ?? { snapshotSource: "fresh-index" as const, freshness: "unknown" as const };
    const persistence = this.#persistence;
    if (!persistence) return currentState;

    if (!this.#sourceManifestFingerprints.has(projectId)) {
      const unknown: CodeMapSnapshotLifecycleState = {
        snapshotSource: currentState.snapshotSource,
        freshness: "unknown",
        staleReason: "source_check_failed",
      };
      this.#snapshotStates.set(projectId, unknown);
      return unknown;
    }
    const baseline = this.#sourceManifestFingerprints.get(projectId);
    if (!baseline) {
      const unknown: CodeMapSnapshotLifecycleState = {
        snapshotSource: currentState.snapshotSource,
        freshness: "unknown",
        staleReason: "source_check_failed",
      };
      this.#snapshotStates.set(projectId, unknown);
      return unknown;
    }

    try {
      const current = persistence.sourceState.sourceManifestFingerprint(rootPath);
      const next: CodeMapSnapshotLifecycleState = current === baseline
        ? { snapshotSource: currentState.snapshotSource, freshness: "current" }
        : { snapshotSource: currentState.snapshotSource, freshness: "stale", staleReason: "source_changed" };
      this.#snapshotStates.set(projectId, next);
      return next;
    } catch {
      const unknown: CodeMapSnapshotLifecycleState = {
        snapshotSource: currentState.snapshotSource,
        freshness: "unknown",
        staleReason: "source_check_failed",
      };
      this.#snapshotStates.set(projectId, unknown);
      return unknown;
    }
  }

  #hydrate(projectId: string): void {
    const persistence = this.#persistence;
    if (!persistence || this.#hydrationAttempted.has(projectId)) return;
    this.#hydrationAttempted.add(projectId);

    const rootPath = persistence.rootPathForProject?.(projectId);
    if (!rootPath) return;

    try {
      persistence.validateStorageRootForProject?.(rootPath);
    } catch {
      this.#hydrationDiagnostics.set(projectId, { hydrationRejectReason: "storage_inside_project" });
      return;
    }

    let raw: unknown;
    try {
      raw = persistence.store.load(projectId);
    } catch {
      this.#hydrationDiagnostics.set(projectId, { hydrationRejectReason: "corrupt" });
      return;
    }
    if (raw === undefined) return;

    let rootIdentity: string;
    try {
      rootIdentity = persistence.sourceState.rootIdentity(rootPath);
    } catch {
      this.#hydrationDiagnostics.set(projectId, { hydrationRejectReason: "root_changed" });
      return;
    }

    const parsed = persistedEnvelopeOrReason(
      raw,
      projectId,
      rootIdentity,
      persistence.providerConfigFingerprint,
    );
    if (!parsed.envelope) {
      this.#hydrationDiagnostics.set(projectId, {
        hydrationRejectReason: parsed.reason ?? "corrupt",
      });
      return;
    }

    const envelope = parsed.envelope;
    const graph = envelope.graph;
    if (graph.projectId !== projectId) {
      this.#hydrationDiagnostics.set(projectId, { hydrationRejectReason: "project_changed" });
      return;
    }
    if (graph.schemaVersion !== CODE_GRAPH_SCHEMA_VERSION) {
      this.#hydrationDiagnostics.set(projectId, { hydrationRejectReason: "schema_changed" });
      return;
    }
    let persistedGraphRootIdentity: string;
    try {
      persistedGraphRootIdentity = persistence.sourceState.rootIdentity(graph.rootPath);
    } catch {
      this.#hydrationDiagnostics.set(projectId, { hydrationRejectReason: "root_changed" });
      return;
    }
    if (persistedGraphRootIdentity !== rootIdentity) {
      this.#hydrationDiagnostics.set(projectId, { hydrationRejectReason: "root_changed" });
      return;
    }
    try {
      assertValidCodeGraphSnapshot(graph);
    } catch {
      this.#hydrationDiagnostics.set(projectId, { hydrationRejectReason: "graph_invalid" });
      return;
    }

    const snapshot: CodeMapSnapshot = {
      graph,
      projection: projectCodeArchitecture(graph),
    };
    this.#cache.set(projectId, snapshot);
    this.#sourceManifestFingerprints.set(projectId, envelope.sourceManifestFingerprint);
    this.#snapshotStates.set(projectId, { snapshotSource: "persisted", freshness: "unknown" });
    this.#hydrationDiagnostics.delete(projectId);
    this.#refreshFreshness(projectId, rootPath);
  }
}
