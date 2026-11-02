import { randomUUID } from "node:crypto";
import { computeCodeMapSnapshotIdentity, type CodeMapSnapshotIdentity } from "./code-map-snapshot-identity.js";
import {
  assertValidCodeGraphSnapshot,
  type CodeGraphSnapshot,
  type CodeNode,
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
  queryCodeSourceSubsystems,
  type CodeSourceSubsystemQueryInput,
  type CodeSourceSubsystemQueryResult,
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
  queryCodeMapContinuations,
  type CodeMapContinuationQueryInput,
  type CodeMapContinuationResult,
} from "./code-map-continuation.js";
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
import type { SourceStructureChannelSelection } from "./source-structure-channel.js";
import type { SourceStructureSyncGraph } from "./source-structure-sync-graph.js";
import type {
  TaskCodeScopeBinding, CodeScopePinnedRelink,
} from "./code-scope-binding.js";
import type { SourceStructureSelection } from "./source-structure-sync-graph.js";
import {
  createCodeMapSourceTreePage,
  type CodeMapSourceTreeRequest,
  type CodeMapSourceTreePage,
} from "./code-map-web-read.js";

export type CodeMapRefreshMode = "full" | "incremental" | "cache-hit";
export type CodeMapIsolatedReadOperation =
  "query" | "continuations" | "subsystems" | "subsystem_read" | "status"
  | "source_structure_preview" | "source_structure_apply" | "web_bootstrap"
  | "source_tree" | "investigation_preview" | "code_scope_relink";
export interface SourceStructureApplySource {
  graph: SourceStructureSyncGraph;
  selection: SourceStructureSelection;
}
export interface CodeMapIsolatedReadRequest {
  projectId: string;
  rootPath: string;
  operation: CodeMapIsolatedReadOperation;
  input?: unknown;
  manualRelations: readonly ReturnType<CodeMapManualRelationReader["listCodeMapManualRelations"]>[number][];
}
export type CodeMapIsolatedReadExecutor = (request: CodeMapIsolatedReadRequest, signal?: AbortSignal) => Promise<unknown>;

export interface CodeMapSnapshotReadSummary {
  indexed: boolean;
  indexedAt?: string;
  nodeCount?: number;
  relationCount?: number;
  projectionQuality?: CodeArchitectureProjection["quality"];
  snapshotState?: CodeMapSnapshotLifecycleState;
  snapshotIdentity?: CodeMapSnapshotIdentity;
  hydrationDiagnostic?: CodeMapHydrationDiagnostic;
  providerCapabilities?: CodeMapProviderCapabilityReport;
}
export interface CodeMapWebBootstrap extends CodeMapSnapshotReadSummary {
  /** Light compatibility-only lens; no raw member/relation ID arrays. */
  projection?: {
    projectId: string;
    sourceIndexedAt: string;
    quality: CodeArchitectureProjection["quality"];
    nodes: readonly (Pick<CodeArchitectureProjection["nodes"][number], "id" | "kind" | "title"> & { memberCount: number })[];
    relations: readonly (Pick<CodeArchitectureProjection["relations"][number], "id" | "from" | "to" | "kind"> & { sourceRelationCount: number })[];
  };
  nodeKinds: readonly string[];
  manualRelations: readonly CodeMapManualRelationView[];
}
export interface CodeMapInvestigationPreviewSource {
  projection: CodeArchitectureProjection;
  /** Only requested raw IDs that actually exist. Never the full raw graph. */
  matchedRawCodeNodeIds: readonly string[];
}
/** Bounded IPC receipt from a separate indexing process, never a full graph. */
export interface CodeMapIsolatedRefreshReceipt {
  projectId: string;
  indexedAt: string;
  snapshotId: string;
  mode: CodeMapRefreshMode;
  nodeCount: number;
  relationCount: number;
  changedCodeNodeCount: number;
  changedArchitectureNodeCount: number;
}
export type CodeMapIsolatedRefreshExecutor =
  (request: CodeIndexRequest) => Promise<CodeMapIsolatedRefreshReceipt>;

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
  readonly #snapshotIdentities = new Map<string, CodeMapSnapshotIdentity>();
  readonly #sourceManifestFingerprints = new Map<string, string | undefined>();
  readonly #hydrationDiagnostics = new Map<string, CodeMapHydrationDiagnostic>();
  readonly #hydrationAttempted = new Set<string>();
  readonly #refreshJobs = new Map<string, CodeMapRefreshJobReceipt>();
  readonly #refreshTasks = new Map<string, Promise<void>>();
  #isolatedRefreshExecutor: CodeMapIsolatedRefreshExecutor | undefined;
  #isolatedReadExecutor: CodeMapIsolatedReadExecutor | undefined;

  /** Opt in only for daemon background refresh; direct refresh keeps its tested contract. */
  setIsolatedRefreshExecutor(executor: CodeMapIsolatedRefreshExecutor): void {
    if (this.#isolatedRefreshExecutor) throw new Error("Code Map isolated refresh executor already configured");
    this.#isolatedRefreshExecutor = executor;
  }

  /** Isolate graph-heavy *read* work while preserving existing sync domain APIs. */
  setIsolatedReadExecutor(executor: CodeMapIsolatedReadExecutor): void {
    if (this.#isolatedReadExecutor) throw new Error("Code Map isolated read executor already configured");
    this.#isolatedReadExecutor = executor;
  }

  get isolatedReadsEnabled(): boolean {
    return Boolean(this.#isolatedReadExecutor);
  }

  async #isolatedRead<T>(
    projectId: string, operation: CodeMapIsolatedReadOperation, input?: unknown,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    const executor = this.#isolatedReadExecutor;
    if (!executor) return undefined;
    // Use only a root resolved from the server-owned Project registry, never
    // accept a client-supplied file system path through the read transport.
    const rootPath = this.#persistence?.rootPathForProject?.(projectId);
    if (!rootPath) throw new CodeMapQueryError("code_map_not_indexed",
      "Code Map has no trusted project root for isolated read");
    return await executor({
      projectId, rootPath, operation,
      ...(input !== undefined ? { input } : {}),
      manualRelations: this.#manualRelations?.listCodeMapManualRelations(projectId) ?? [],
    }, signal) as T;
  }

  async queryAsync(projectId: string, input: CodeMapQueryInput, signal?: AbortSignal): Promise<CodeMapQueryResult> {
    return await this.#isolatedRead<CodeMapQueryResult>(projectId, "query", input, signal)
      ?? this.query(projectId, input);
  }

  async queryContinuationsAsync(
    projectId: string, input: CodeMapContinuationQueryInput, signal?: AbortSignal,
  ): Promise<CodeMapContinuationResult> {
    return await this.#isolatedRead<CodeMapContinuationResult>(projectId, "continuations", input, signal)
      ?? this.queryContinuations(projectId, input);
  }

  async querySourceSubsystemsAsync(
    projectId: string, input: CodeSourceSubsystemQueryInput, signal?: AbortSignal,
  ): Promise<CodeSourceSubsystemQueryResult> {
    return await this.#isolatedRead<CodeSourceSubsystemQueryResult>(projectId, "subsystems", input, signal)
      ?? this.querySourceSubsystems(projectId, input);
  }

  async sourceSubsystemsAsync(projectId: string, signal?: AbortSignal): Promise<CodeSourceSubsystemRead> {
    return await this.#isolatedRead<CodeSourceSubsystemRead>(projectId, "subsystem_read", undefined, signal)
      ?? this.sourceSubsystems(projectId);
  }

  /** A bounded, server-owned pinned source selection for read-only Flow preview.
   * Never exposes a raw CodeGraphSnapshot to the daemon or the client. */
  async sourceStructurePreviewGraphAsync(
    projectId: string, selection: SourceStructureChannelSelection, signal?: AbortSignal,
  ): Promise<SourceStructureSyncGraph> {
    if (!this.#isolatedReadExecutor) {
      throw new CodeMapQueryError("code_map_query_invalid",
        "Source Structure isolated preview requires an isolated Code Map reader");
    }
    if (selection.projectId !== projectId) {
      throw new CodeMapQueryError("code_map_query_invalid", "Source Structure project identity mismatch");
    }
    const result = await this.#isolatedRead<SourceStructureSyncGraph>(
      projectId, "source_structure_preview", selection, signal,
    );
    if (!result || result.projectId !== projectId
      || result.snapshotId !== selection.expectedSnapshotId
      || result.sourceIndexedAt !== selection.expectedSourceIndexedAt) {
      throw new CodeMapQueryError("code_map_snapshot_changed",
        "Source Structure isolated preview snapshot identity changed");
    }
    return result;
  }

  /** Web initial read with no full graph or full six-role member lists in IPC. */
  async webBootstrapAsync(projectId: string, signal?: AbortSignal): Promise<CodeMapWebBootstrap> {
    return await this.#isolatedRead<CodeMapWebBootstrap>(projectId, "web_bootstrap", undefined, signal)
      ?? this.webBootstrap(projectId);
  }

  /** Both page and graph are derived in the SAME disposable child from one
   * exact pinned snapshot. Never trust a client-created subsystem page. */
  async sourceStructureApplySourceAsync(
    projectId: string, selection: SourceStructureChannelSelection, signal?: AbortSignal,
  ): Promise<SourceStructureApplySource> {
    if (!this.#isolatedReadExecutor || selection.projectId !== projectId) {
      throw new CodeMapQueryError("code_map_query_invalid",
        "Source Structure apply requires a trusted isolated reader");
    }
    const result = await this.#isolatedRead<SourceStructureApplySource>(
      projectId, "source_structure_apply", selection, signal,
    );
    if (!result || result.graph.projectId !== projectId
      || result.graph.snapshotId !== selection.expectedSnapshotId
      || result.graph.sourceIndexedAt !== selection.expectedSourceIndexedAt
      || result.selection.expectedSnapshotId !== selection.expectedSnapshotId
      || result.selection.expectedSourceIndexedAt !== selection.expectedSourceIndexedAt) {
      throw new CodeMapQueryError("code_map_snapshot_changed",
        "Source Structure apply read returned a different snapshot");
    }
    return result;
  }

  async sourceTreePageAsync(
    projectId: string, input: CodeMapSourceTreeRequest, signal?: AbortSignal,
  ): Promise<CodeMapSourceTreePage> {
    return await this.#isolatedRead<CodeMapSourceTreePage>(projectId, "source_tree", input, signal)
      ?? this.sourceTreePage(projectId, input);
  }

  /** Called only inside the disposable read process when isolated mode is on. */
  async webBootstrap(projectId: string): Promise<CodeMapWebBootstrap> {
    const summary = await this.snapshotReadSummary(projectId);
    const cached = this.getCached(projectId);
    return {
      ...summary,
      nodeKinds: cached ? [...new Set(cached.graph.nodes.map((node) => node.kind))].sort() : [],
      manualRelations: cached ? this.manualRelations(projectId) : [],
      ...(cached ? { projection: {
        projectId: cached.projection.projectId,
        sourceIndexedAt: cached.projection.sourceIndexedAt,
        quality: cached.projection.quality,
        nodes: cached.projection.nodes.map(({ id, kind, title, memberNodeIds }) =>
          ({ id, kind, title, memberCount: memberNodeIds.length })),
        relations: cached.projection.relations.map(({ id, from, to, kind, sourceRelationIds }) =>
          ({ id, from, to, kind, sourceRelationCount: sourceRelationIds.length })),
      } } : {}),
    };
  }

  sourceTreePage(projectId: string, input: CodeMapSourceTreeRequest): CodeMapSourceTreePage {
    const cached = this.getCached(projectId);
    if (!cached) throw new CodeMapQueryError("code_map_not_indexed", "Code Map is not indexed");
    return createCodeMapSourceTreePage(cached.graph, this.#snapshotIdentities.get(projectId), input);
  }

  async investigationPreviewSourceAsync(
    projectId: string, requestedCodeNodeIds?: readonly string[], signal?: AbortSignal,
  ): Promise<CodeMapInvestigationPreviewSource> {
    return await this.#isolatedRead<CodeMapInvestigationPreviewSource>(
      projectId, "investigation_preview", requestedCodeNodeIds ?? [], signal,
    ) ?? this.investigationPreviewSource(projectId, requestedCodeNodeIds);
  }

  /** Exact compatibility projection and raw-ID validation evidence, evaluated
   * inside the disposable worker in isolated mode. Apply retains its own CAS. */
  investigationPreviewSource(
    projectId: string, requestedCodeNodeIds?: readonly string[],
  ): CodeMapInvestigationPreviewSource {
    const cached = this.getCached(projectId);
    if (!cached) throw new CodeMapQueryError("code_map_not_indexed", "Code Map is not indexed");
    const selected = new Set(requestedCodeNodeIds ?? []);
    return {
      projection: cached.projection,
      matchedRawCodeNodeIds: selected.size
        ? cached.graph.nodes.filter((node) => selected.has(node.id)).map((node) => node.id) : [],
    };
  }

  async snapshotReadSummary(projectId: string, signal?: AbortSignal): Promise<CodeMapSnapshotReadSummary> {
    const isolated = await this.#isolatedRead<CodeMapSnapshotReadSummary>(projectId, "status", undefined, signal);
    if (isolated) return isolated;
    const cached = this.getCached(projectId);
    const snapshotState = this.snapshotLifecycleState(projectId);
    const snapshotIdentity = this.snapshotIdentity(projectId);
    const hydrationDiagnostic = this.hydrationDiagnostic(projectId);
    const providerCapabilities = this.providerCapabilities(projectId);
    return {
      indexed: Boolean(cached),
      ...(cached ? {
        indexedAt: cached.graph.indexedAt,
        nodeCount: cached.graph.nodes.length,
        relationCount: cached.graph.relations.length,
        projectionQuality: cached.projection.quality,
      } : {}),
      ...(snapshotState ? { snapshotState } : {}),
      ...(snapshotIdentity ? { snapshotIdentity } : {}),
      ...(hydrationDiagnostic ? { hydrationDiagnostic } : {}),
      ...(providerCapabilities ? { providerCapabilities } : {}),
    };
  }

  /** Pre-index provider discovery does not hydrate any giant cached raw graph. */
  snapshotRevisionToken(projectId: string): string {
    const token = this.#persistence?.store.revisionToken?.(projectId);
    if (!token) throw new CodeMapQueryError("code_map_not_indexed",
      "Trusted persisted Code Map snapshot revision is unavailable");
    return token;
  }

  assertSnapshotRevision(projectId: string, expected: string): void {
    if (this.snapshotRevisionToken(projectId) !== expected) {
      throw new CodeMapQueryError("code_map_snapshot_changed",
        "Trusted Code Map snapshot changed while preparing the mutation");
    }
  }

  /** A single native exact-node fact from a pinned child, coupled with the
   * synchronous revision fence that must run inside the SQLite transaction. */
  async pinnedNodeForMutation(
    projectId: string, nodeId: string,
  ): Promise<{ node: CodeNode; assertCurrent: () => void }> {
    if (!this.#isolatedReadExecutor) {
      throw new CodeMapQueryError("code_map_query_invalid",
        "Pinned CodeScope mutation requires an isolated Code Map reader");
    }
    const revision = this.snapshotRevisionToken(projectId);
    const result = await this.queryAsync(projectId, {
      operation: "get_node", nodeId, limit: 1,
    });
    if (result.operation !== "get_node" || result.node.id !== nodeId || !result.snapshotId) {
      throw new CodeMapQueryError("code_map_snapshot_changed",
        "Pinned CodeScope node does not match the trusted source");
    }
    const assertCurrent = () => this.assertSnapshotRevision(projectId, revision);
    assertCurrent();
    return { node: result.node, assertCurrent };
  }

  async pinnedRelinkForMutation(binding: TaskCodeScopeBinding): Promise<CodeScopePinnedRelink> {
    if (!this.#isolatedReadExecutor) {
      throw new CodeMapQueryError("code_map_query_invalid",
        "Pinned CodeScope relink requires an isolated Code Map reader");
    }
    const revision = this.snapshotRevisionToken(binding.projectId);
    const result = await this.#isolatedRead<{
      snapshotId: string; analysis: CodeScopePinnedRelink["analysis"];
    }>(binding.projectId, "code_scope_relink", binding);
    if (!result?.snapshotId || !result.analysis?.state) {
      throw new CodeMapQueryError("code_map_snapshot_changed",
        "CodeScope relink analysis has no trusted source identity");
    }
    const assertCurrent = () => this.assertSnapshotRevision(binding.projectId, revision);
    assertCurrent();
    return { binding, analysis: result.analysis, assertCurrent };
  }

  /** Pre-index provider discovery does not hydrate any giant cached raw graph. */
  async unindexedProviderCapabilities(
    projectId: string, canonicalRootPath?: string,
  ): Promise<CodeMapProviderCapabilityReport | undefined> {
    const rootPath = canonicalRootPath ?? this.#persistence?.rootPathForProject?.(projectId);
    if (!this.#providerRegistry) return undefined;
    const preflight = await inspectCodeMapPreflight(rootPath, this.#preflightInventory);
    return this.#providerRegistry.report(undefined, rootPath, preflight);
  }

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

  snapshotIdentity(projectId: string): CodeMapSnapshotIdentity | undefined {
    this.getCached(projectId);
    return this.#snapshotIdentities.get(projectId);
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

  querySourceSubsystems(
    projectId: string,
    input: CodeSourceSubsystemQueryInput,
  ): CodeSourceSubsystemQueryResult {
    const cached = this.getCached(projectId);
    if (!cached) {
      throw new CodeMapQueryError(
        "code_map_not_indexed",
        `Code Map has not been indexed for project ${projectId}`,
      );
    }
    return queryCodeSourceSubsystems(
      cached.graph,
      cached.projection,
      input,
      this.providerCapabilities(projectId),
      this.#snapshotIdentities.get(projectId)?.snapshotId,
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
    // Publish only after a durable write succeeds. Otherwise a restart
    // exposes the previous snapshot while the daemon claims "current".
    this.#recordFreshIndex(request.projectId, request.rootPath, graph);
    this.#cache.set(request.projectId, snapshot);
    this.#hydrationAttempted.add(request.projectId);
    this.#hydrationDiagnostics.delete(request.projectId);

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
      const isolated = this.#isolatedRefreshExecutor
        ? await this.#isolatedRefreshExecutor(request)
        : undefined;
      // Child has already written a fully pinned immutable snapshot. Do not
      // pass or deserialize the graph through IPC. Existing sync readers still
      // hydrate lazily on their next request (migration to child read API is P2).
      if (isolated) {
        if (isolated.projectId !== request.projectId || !isolated.snapshotId
          || !isolated.indexedAt || !Number.isSafeInteger(isolated.nodeCount)
          || isolated.nodeCount < 0 || !Number.isSafeInteger(isolated.relationCount)
          || isolated.relationCount < 0) {
          throw new Error("Isolated Code Map receipt is invalid");
        }
        this.invalidate(request.projectId);
      }
      const refreshed = isolated ? undefined : await this.refresh(request);
      const finishedAt = this.#now();
      const completed: CodeMapRefreshJobReceipt = {
        ...indexing,
        state: "succeeded",
        phase: "complete",
        updatedAt: finishedAt,
        finishedAt,
        indexedAt: isolated?.indexedAt ?? refreshed!.graph.indexedAt,
        mode: isolated?.mode ?? refreshed!.mode,
        nodeCount: isolated?.nodeCount ?? refreshed!.graph.nodes.length,
        relationCount: isolated?.relationCount ?? refreshed!.graph.relations.length,
        changedCodeNodeCount: isolated?.changedCodeNodeCount ?? refreshed!.changedCodeNodeIds.length,
        changedArchitectureNodeCount: isolated?.changedArchitectureNodeCount ?? refreshed!.changedArchitectureNodeIds.length,
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
    const identity = this.#snapshotIdentities.get(projectId);
    if (input.expectedSnapshotId && identity?.snapshotId !== input.expectedSnapshotId) {
      throw new CodeMapQueryError("code_map_snapshot_changed", "Requested Code Map snapshot is not the current exact snapshot");
    }
    const graph = this.#manualRelations
      ? augmentCodeGraphWithManualRelations(
          cached.graph,
          this.#manualRelations.listCodeMapManualRelations(projectId),
        )
      : cached.graph;
    const result = queryCodeGraph(graph, this.providerId, input);
    return identity ? { ...result, snapshotId: identity.snapshotId } : result;
  }

  queryContinuations(
    projectId: string,
    input: CodeMapContinuationQueryInput,
  ): CodeMapContinuationResult {
    const cached = this.getCached(projectId);
    if (!cached) {
      throw new CodeMapQueryError(
        "code_map_not_indexed",
        `Code Map has not been indexed for project ${projectId}`,
      );
    }
    const identity = this.#snapshotIdentities.get(projectId);
    if (input.expectedSnapshotId && identity?.snapshotId !== input.expectedSnapshotId) {
      throw new CodeMapQueryError("code_map_snapshot_changed", "Requested Code Map snapshot is not the current exact snapshot");
    }
    const result = queryCodeMapContinuations(cached.graph, input, identity?.snapshotId);
    return identity ? { ...result, snapshotId: identity.snapshotId } : result;
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
    this.#snapshotIdentities.delete(projectId);
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
    try {
      const envelope: PersistedCodeMapSnapshotEnvelope = {
        formatVersion: CODE_MAP_PERSISTED_SNAPSHOT_FORMAT_VERSION,
        graphSchemaVersion: graph.schemaVersion,
        projectId,
        rootIdentity: persistence.sourceState.rootIdentity(rootPath),
        providerConfigFingerprint: persistence.providerConfigFingerprint,
        ...computeCodeMapSnapshotIdentity({
          projectId,
          rootIdentity: persistence.sourceState.rootIdentity(rootPath),
          providerConfigFingerprint: persistence.providerConfigFingerprint,
          sourceManifestFingerprint,
          graph,
        }),
        ...(sourceManifestFingerprint ? { sourceManifestFingerprint } : {}),
        persistedAt: persistence.now?.() ?? new Date().toISOString(),
        graph,
      };
      persistence.store.save(projectId, envelope);
      this.#sourceManifestFingerprints.set(projectId, sourceManifestFingerprint);
      this.#snapshotStates.set(projectId, state);
      this.#snapshotIdentities.set(projectId, {
        graphDigest: envelope.graphDigest!,
        snapshotId: envelope.snapshotId!,
        ...(envelope.providerRunFingerprint ? { providerRunFingerprint: envelope.providerRunFingerprint } : {}),
      });
    } catch (error) {
      // Durable-write failure cannot be reported as a successful refresh.
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      const prior = this.#snapshotStates.get(projectId);
      this.#snapshotStates.set(projectId, {
        snapshotSource: prior?.snapshotSource ?? "persisted",
        freshness: "stale",
        staleReason: "snapshot_save_failed",
        persistenceWarning: "Newest index was NOT saved; previous disk snapshot remains: " + reason,
      });
      throw new Error("Code Map snapshot not saved; refresh not committed: " + reason, { cause: error });
    }
  }

  #refreshFreshness(projectId: string, rootPath: string): CodeMapSnapshotLifecycleState {
    const currentState = this.#snapshotStates.get(projectId)
      ?? { snapshotSource: "fresh-index" as const, freshness: "unknown" as const };
    if (currentState.staleReason === "snapshot_save_failed") return currentState;
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

    // Older envelopes hydrate without an exact pin; partial or tampered new
    // identity fields fail closed instead of being treated as legacy snapshots.
    if (envelope.graphDigest !== undefined || envelope.snapshotId !== undefined
      || envelope.providerRunFingerprint !== undefined) {
      try {
        const identity = computeCodeMapSnapshotIdentity({
          projectId, rootIdentity,
          providerConfigFingerprint: persistence.providerConfigFingerprint,
          sourceManifestFingerprint: envelope.sourceManifestFingerprint,
          graph,
        });
        if (envelope.graphDigest !== identity.graphDigest || envelope.snapshotId !== identity.snapshotId
          || envelope.providerRunFingerprint !== identity.providerRunFingerprint) {
          throw new Error("Persisted identity does not match the graph or provider runs");
        }
        this.#snapshotIdentities.set(projectId, identity);
      } catch {
        this.#hydrationDiagnostics.set(projectId, { hydrationRejectReason: "identity_invalid" });
        return;
      }
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
