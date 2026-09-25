import { createHash, randomUUID } from "node:crypto";
import type {
  ActorRef,
  BoardNodePosition,
  InvestigationItem,
  InvestigationItemLink,
  InvestigationNode,
} from "../core/domain.js";
import type { MutationRequest, QuestBoardRepository } from "./quest-board-repository.js";
import type { CodeMapService } from "./code-map-service.js";
import type {
  CodeArchitectureNode,
  CodeArchitectureNodeKind,
  CodeArchitectureProjection,
  CodeArchitectureRelation,
  CodeArchitectureRelationKind,
} from "./code-map-projection.js";

export const CODE_MAP_INVESTIGATION_BINDING_STATES = ["active", "stale", "detached"] as const;
export type CodeMapInvestigationBindingState = (typeof CODE_MAP_INVESTIGATION_BINDING_STATES)[number];

export const CODE_MAP_INVESTIGATION_NODE_PREVIEW_STATES = [
  "create",
  "unchanged",
  "evidence_changed",
  "stale",
  "detached",
] as const;
export type CodeMapInvestigationNodePreviewState = (typeof CODE_MAP_INVESTIGATION_NODE_PREVIEW_STATES)[number];

export const CODE_MAP_INVESTIGATION_RELATION_PREVIEW_STATES = [
  "create",
  "unchanged",
  "evidence_changed",
  "stale",
  "detached",
  "blocked",
] as const;
export type CodeMapInvestigationRelationPreviewState = (typeof CODE_MAP_INVESTIGATION_RELATION_PREVIEW_STATES)[number];

export interface CodeMapInvestigationNodeBinding {
  projectId: string;
  codeNodeId: string;
  investigationNodeId?: string;
  sourceKind: CodeArchitectureNodeKind;
  sourceTitle: string;
  sourceFingerprint: string;
  sourceIndexedAt: string;
  syncState: CodeMapInvestigationBindingState;
  firstSyncedAt: string;
  lastSyncedAt: string;
}

export interface CodeMapInvestigationRelationBinding {
  projectId: string;
  codeRelationId: string;
  fromCodeNodeId: string;
  toCodeNodeId: string;
  investigationItemId?: string;
  investigationItemLinkId?: string;
  relationKind: CodeArchitectureRelationKind;
  sourceRelationIds: readonly string[];
  sourceFingerprint: string;
  sourceIndexedAt: string;
  syncState: CodeMapInvestigationBindingState;
  firstSyncedAt: string;
  lastSyncedAt: string;
}

export interface CodeMapInvestigationSyncSelection {
  codeNodeIds?: readonly string[];
  includeRelations?: boolean;
  recreateDetached?: boolean;
}

export interface CodeMapInvestigationNodePreviewEntry {
  codeNodeId: string;
  codeNodeKind: CodeArchitectureNodeKind;
  sourceTitle: string;
  sourceFingerprint: string;
  state: CodeMapInvestigationNodePreviewState;
  investigationNodeId?: string;
}

export interface CodeMapInvestigationRelationPreviewEntry {
  codeRelationId: string;
  fromCodeNodeId: string;
  toCodeNodeId: string;
  relationKind: CodeArchitectureRelationKind;
  sourceFingerprint: string;
  state: CodeMapInvestigationRelationPreviewState;
  investigationItemId?: string;
  investigationItemLinkId?: string;
  blockedReason?: "from_node_unselected" | "to_node_unselected" | "from_node_detached" | "to_node_detached";
}

export interface CodeMapInvestigationSyncPreviewCounts {
  nodes: Record<CodeMapInvestigationNodePreviewState, number>;
  relations: Record<CodeMapInvestigationRelationPreviewState, number>;
}

export interface CodeMapInvestigationSyncPreview {
  projectId: string;
  sourceIndexedAt: string;
  projectionFingerprint: string;
  selection: CodeMapInvestigationSyncSelection;
  nodes: readonly CodeMapInvestigationNodePreviewEntry[];
  relations: readonly CodeMapInvestigationRelationPreviewEntry[];
  counts: CodeMapInvestigationSyncPreviewCounts;
}

export interface CodeMapInvestigationSyncApplyInput extends CodeMapInvestigationSyncSelection {
  expectedProjectionFingerprint: string;
}

export interface CodeMapInvestigationSyncApplyCounts {
  createdNodes: number;
  createdRelationItems: number;
  createdRelationLinks: number;
  updatedBindings: number;
  staleBindings: number;
  detachedBindings: number;
  unchangedNodes: number;
  unchangedRelations: number;
  blockedRelations: number;
}

export interface CodeMapInvestigationSyncResult {
  projectId: string;
  sourceIndexedAt: string;
  projectionFingerprint: string;
  counts: CodeMapInvestigationSyncApplyCounts;
  investigationNodeIds: readonly string[];
  investigationItemIds: readonly string[];
  investigationItemLinkIds: readonly string[];
}

export const CODE_MAP_INVESTIGATION_RELATION_LABELS: Record<CodeArchitectureRelationKind, string> = {
  invokes: "invokes",
  depends_on_contract: "depends on contract",
  implemented_by: "implemented by",
  persists_to: "persists to",
};

export function investigationKindForCodeMapNode(kind: CodeArchitectureNodeKind): string {
  return `code-map/${kind}`;
}

export function investigationRelationItemTitle(
  relation: Pick<CodeArchitectureRelation, "kind">,
  target: Pick<CodeArchitectureNode, "title">,
): string {
  return `${CODE_MAP_INVESTIGATION_RELATION_LABELS[relation.kind]} → ${target.title}`;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function relationIdentity(relation: CodeArchitectureRelation): string {
  return `${relation.id}:${relation.from}:${relation.kind}:${relation.to}`;
}

export function fingerprintCodeMapInvestigationNode(
  node: CodeArchitectureNode,
  projection: Pick<CodeArchitectureProjection, "relations">,
): string {
  const attachedRelationIdentities = projection.relations
    .filter((relation) => relation.from === node.id || relation.to === node.id)
    .map(relationIdentity)
    .sort();

  return stableHash({
    id: node.id,
    kind: node.kind,
    title: node.title,
    memberNodeIds: [...node.memberNodeIds].sort(),
    attachedRelationIdentities,
  });
}

export function fingerprintCodeMapInvestigationRelation(relation: CodeArchitectureRelation): string {
  return stableHash({
    id: relation.id,
    from: relation.from,
    to: relation.to,
    kind: relation.kind,
    sourceRelationIds: [...relation.sourceRelationIds].sort(),
  });
}

export function fingerprintCodeMapInvestigationProjection(projection: CodeArchitectureProjection): string {
  const nodeFingerprints = projection.nodes
    .map((node) => [node.id, fingerprintCodeMapInvestigationNode(node, projection)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const relationFingerprints = projection.relations
    .map((relation) => [relation.id, fingerprintCodeMapInvestigationRelation(relation)] as const)
    .sort(([left], [right]) => left.localeCompare(right));

  return stableHash({
    projectId: projection.projectId,
    sourceIndexedAt: projection.sourceIndexedAt,
    nodeFingerprints,
    relationFingerprints,
  });
}

export class CodeMapInvestigationSyncError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CodeMapInvestigationSyncError";
  }
}

export class CodeMapNotIndexedError extends CodeMapInvestigationSyncError {
  constructor(projectId: string) {
    super("code_map_not_indexed", `Code Map has not been indexed for project ${projectId}`);
  }
}

export class CodeMapSyncPreviewStaleError extends CodeMapInvestigationSyncError {
  constructor() {
    super("code_map_sync_preview_stale", "Code Map projection changed after preview");
  }
}

export class CodeMapSyncDetachedRequiresConfirmationError extends CodeMapInvestigationSyncError {
  constructor() {
    super(
      "code_map_sync_detached_requires_confirmation",
      "Detached Code Map bindings require recreateDetached=true before they can be recreated",
    );
  }
}

export class CodeMapSyncInvalidSelectionError extends CodeMapInvestigationSyncError {
  constructor(message: string) {
    super("code_map_sync_invalid_selection", message);
  }
}

type Now = () => string;
type IdFactory = () => string;

interface NormalizedSelection {
  codeNodeIds: readonly string[];
  includeRelations: boolean;
  recreateDetached: boolean;
  fullSelection: boolean;
}

const INITIAL_NODE_POSITIONS: Record<CodeArchitectureNodeKind, { x: number; y: number }> = {
  http_api: { x: 0, y: -120 },
  agent_mcp: { x: 0, y: 120 },
  application_service: { x: 320, y: 0 },
  repository_contract: { x: 640, y: 0 },
  sqlite_repository: { x: 960, y: 0 },
  sqlite: { x: 1280, y: 0 },
};

function emptyPreviewCounts(): CodeMapInvestigationSyncPreviewCounts {
  return {
    nodes: { create: 0, unchanged: 0, evidence_changed: 0, stale: 0, detached: 0 },
    relations: { create: 0, unchanged: 0, evidence_changed: 0, stale: 0, detached: 0, blocked: 0 },
  };
}

function emptyApplyCounts(): CodeMapInvestigationSyncApplyCounts {
  return {
    createdNodes: 0,
    createdRelationItems: 0,
    createdRelationLinks: 0,
    updatedBindings: 0,
    staleBindings: 0,
    detachedBindings: 0,
    unchangedNodes: 0,
    unchangedRelations: 0,
    blockedRelations: 0,
  };
}

function nextSortOrder(items: readonly { sortOrder: number }[]): number {
  return items.reduce((highest, item) => Math.max(highest, item.sortOrder), -1) + 1;
}

function normalizeSyncRequestId(requestId: string): string {
  const normalized = requestId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(normalized)) {
    throw new TypeError("requestId must be 8-128 characters using letters, numbers, dot, underscore, colon, or hyphen");
  }
  return normalized;
}

export class CodeMapInvestigationSyncService {
  constructor(
    private readonly codeMap: Pick<CodeMapService, "getCached">,
    private readonly repository: QuestBoardRepository,
    private readonly now: Now = () => new Date().toISOString(),
    private readonly newId: IdFactory = randomUUID,
  ) {}

  preview(projectId: string, selection: CodeMapInvestigationSyncSelection = {}): CodeMapInvestigationSyncPreview {
    const projection = this.projection(projectId);
    const normalized = this.normalizeSelection(projection, selection);
    return this.previewProjection(projection, normalized);
  }

  apply(
    projectId: string,
    input: CodeMapInvestigationSyncApplyInput,
    actor: ActorRef,
    requestId: string,
  ): CodeMapInvestigationSyncResult {
    const projection = this.projection(projectId);
    const projectionFingerprint = fingerprintCodeMapInvestigationProjection(projection);
    if (projectionFingerprint !== input.expectedProjectionFingerprint) {
      throw new CodeMapSyncPreviewStaleError();
    }
    const selection = this.normalizeSelection(projection, input);
    const normalizedRequestId = normalizeSyncRequestId(requestId);
    const request: MutationRequest = {
      requestId: normalizedRequestId,
      operation: "code-map.investigation-sync.apply",
      actorId: actor.id,
      fingerprint: stableHash({
        operation: "code-map.investigation-sync.apply",
        actor: { id: actor.id, provider: actor.provider },
        projectId,
        selection: {
          codeNodeIds: selection.codeNodeIds,
          includeRelations: selection.includeRelations,
          recreateDetached: selection.recreateDetached,
        },
        expectedProjectionFingerprint: input.expectedProjectionFingerprint,
      }),
      createdAt: this.now(),
    };

    return this.repository.runIdempotentMutation(request, () => {
      const freshProjection = this.projection(projectId);
      if (fingerprintCodeMapInvestigationProjection(freshProjection) !== input.expectedProjectionFingerprint) {
        throw new CodeMapSyncPreviewStaleError();
      }
      const preview = this.previewProjection(freshProjection, selection);
      if (!selection.recreateDetached) {
        const currentNodeIds = new Set(freshProjection.nodes.map((node) => node.id));
        const currentRelationIds = new Set(freshProjection.relations.map((relation) => relation.id));
        const hasRecreatableDetachedBinding = preview.nodes.some(
          (entry) => entry.state === "detached" && currentNodeIds.has(entry.codeNodeId),
        ) || preview.relations.some(
          (entry) => entry.state === "detached" && currentRelationIds.has(entry.codeRelationId),
        );
        if (hasRecreatableDetachedBinding) throw new CodeMapSyncDetachedRequiresConfirmationError();
      }
      return this.applyPreview(freshProjection, preview, actor);
    }).value;
  }

  private projection(projectId: string): CodeArchitectureProjection {
    if (!this.repository.getProject(projectId)) {
      throw new CodeMapSyncInvalidSelectionError(`Unknown project ${projectId}`);
    }
    const cached = this.codeMap.getCached(projectId);
    if (!cached) throw new CodeMapNotIndexedError(projectId);
    return cached.projection;
  }

  private normalizeSelection(
    projection: CodeArchitectureProjection,
    selection: CodeMapInvestigationSyncSelection,
  ): NormalizedSelection {
    const allIds = projection.nodes.map((node) => node.id);
    const fullSelection = selection.codeNodeIds === undefined;
    const requested = selection.codeNodeIds ?? allIds;
    const unique = [...new Set(requested)];
    if (unique.length !== requested.length) {
      throw new CodeMapSyncInvalidSelectionError("codeNodeIds must not contain duplicates");
    }
    const known = new Set(allIds);
    for (const codeNodeId of unique) {
      if (!known.has(codeNodeId)) {
        throw new CodeMapSyncInvalidSelectionError(`Unknown Code Map node ${codeNodeId}`);
      }
    }
    return {
      codeNodeIds: unique,
      includeRelations: selection.includeRelations ?? true,
      recreateDetached: selection.recreateDetached ?? false,
      fullSelection,
    };
  }

  private previewProjection(
    projection: CodeArchitectureProjection,
    selection: NormalizedSelection,
  ): CodeMapInvestigationSyncPreview {
    const selectedIds = new Set(selection.codeNodeIds);
    const nodeById = new Map(projection.nodes.map((node) => [node.id, node] as const));
    const currentRelationById = new Map(projection.relations.map((relation) => [relation.id, relation] as const));
    const nodeBindings = this.repository.listCodeMapInvestigationNodeBindings(projection.projectId);
    const nodeBindingById = new Map(nodeBindings.map((binding) => [binding.codeNodeId, binding] as const));
    const relationBindings = this.repository.listCodeMapInvestigationRelationBindings(projection.projectId);
    const relationBindingById = new Map(relationBindings.map((binding) => [binding.codeRelationId, binding] as const));
    const nodes: CodeMapInvestigationNodePreviewEntry[] = [];
    const counts = emptyPreviewCounts();

    for (const codeNodeId of selection.codeNodeIds) {
      const node = nodeById.get(codeNodeId)!;
      const sourceFingerprint = fingerprintCodeMapInvestigationNode(node, projection);
      const binding = nodeBindingById.get(codeNodeId);
      const targetExists = binding?.investigationNodeId
        ? this.repository.getInvestigationNode(binding.investigationNodeId) !== undefined
        : false;
      let state: CodeMapInvestigationNodePreviewState;
      if (!binding) state = "create";
      else if (binding.syncState === "detached" || !targetExists) state = "detached";
      else if (binding.syncState === "stale" || binding.sourceFingerprint !== sourceFingerprint) state = "evidence_changed";
      else state = "unchanged";
      counts.nodes[state] += 1;
      nodes.push({
        codeNodeId: node.id,
        codeNodeKind: node.kind,
        sourceTitle: node.title,
        sourceFingerprint,
        state,
        ...(binding?.investigationNodeId ? { investigationNodeId: binding.investigationNodeId } : {}),
      });
    }

    if (selection.fullSelection) {
      for (const binding of nodeBindings) {
        if (nodeById.has(binding.codeNodeId)) continue;
        const targetExists = binding.investigationNodeId
          ? this.repository.getInvestigationNode(binding.investigationNodeId) !== undefined
          : false;
        const state: CodeMapInvestigationNodePreviewState = targetExists ? "stale" : "detached";
        counts.nodes[state] += 1;
        nodes.push({
          codeNodeId: binding.codeNodeId,
          codeNodeKind: binding.sourceKind,
          sourceTitle: binding.sourceTitle,
          sourceFingerprint: binding.sourceFingerprint,
          state,
          ...(binding.investigationNodeId ? { investigationNodeId: binding.investigationNodeId } : {}),
        });
      }
    }

    const nodePreviewById = new Map(nodes.map((entry) => [entry.codeNodeId, entry] as const));
    const relations: CodeMapInvestigationRelationPreviewEntry[] = [];
    if (selection.includeRelations) {
      const projectLinks = this.repository.listInvestigationItemLinks(projection.projectId);
      const candidates = selection.fullSelection
        ? projection.relations
        : projection.relations.filter((relation) => selectedIds.has(relation.from) || selectedIds.has(relation.to));
      for (const relation of candidates) {
        const sourceFingerprint = fingerprintCodeMapInvestigationRelation(relation);
        const binding = relationBindingById.get(relation.id);
        const fromBlocked = this.endpointBlockedReason(
          relation.from,
          selectedIds,
          nodePreviewById,
          nodeBindingById,
          selection.recreateDetached,
          "from",
        );
        const toBlocked = this.endpointBlockedReason(
          relation.to,
          selectedIds,
          nodePreviewById,
          nodeBindingById,
          selection.recreateDetached,
          "to",
        );
        const itemExists = binding?.investigationItemId
          ? this.repository.getInvestigationItem(binding.investigationItemId) !== undefined
          : false;
        const linkExists = binding?.investigationItemLinkId
          ? projectLinks.some((link) => link.id === binding.investigationItemLinkId)
          : false;
        let state: CodeMapInvestigationRelationPreviewState;
        let blockedReason: CodeMapInvestigationRelationPreviewEntry["blockedReason"];
        if (fromBlocked || toBlocked) {
          state = "blocked";
          blockedReason = fromBlocked ?? toBlocked;
        } else if (!binding) state = "create";
        else if (binding.syncState === "detached" || !itemExists || !linkExists) state = "detached";
        else if (binding.syncState === "stale" || binding.sourceFingerprint !== sourceFingerprint) state = "evidence_changed";
        else state = "unchanged";
        counts.relations[state] += 1;
        relations.push({
          codeRelationId: relation.id,
          fromCodeNodeId: relation.from,
          toCodeNodeId: relation.to,
          relationKind: relation.kind,
          sourceFingerprint,
          state,
          ...(binding?.investigationItemId ? { investigationItemId: binding.investigationItemId } : {}),
          ...(binding?.investigationItemLinkId ? { investigationItemLinkId: binding.investigationItemLinkId } : {}),
          ...(blockedReason ? { blockedReason } : {}),
        });
      }

      if (selection.fullSelection) {
        for (const binding of relationBindings) {
          if (currentRelationById.has(binding.codeRelationId)) continue;
          const itemExists = binding.investigationItemId
            ? this.repository.getInvestigationItem(binding.investigationItemId) !== undefined
            : false;
          const linkExists = binding.investigationItemLinkId
            ? projectLinks.some((link) => link.id === binding.investigationItemLinkId)
            : false;
          const state: CodeMapInvestigationRelationPreviewState = itemExists && linkExists ? "stale" : "detached";
          counts.relations[state] += 1;
          relations.push({
            codeRelationId: binding.codeRelationId,
            fromCodeNodeId: binding.fromCodeNodeId,
            toCodeNodeId: binding.toCodeNodeId,
            relationKind: binding.relationKind,
            sourceFingerprint: binding.sourceFingerprint,
            state,
            ...(binding.investigationItemId ? { investigationItemId: binding.investigationItemId } : {}),
            ...(binding.investigationItemLinkId ? { investigationItemLinkId: binding.investigationItemLinkId } : {}),
          });
        }
      }
    }

    return {
      projectId: projection.projectId,
      sourceIndexedAt: projection.sourceIndexedAt,
      projectionFingerprint: fingerprintCodeMapInvestigationProjection(projection),
      selection: {
        codeNodeIds: selection.codeNodeIds,
        includeRelations: selection.includeRelations,
        recreateDetached: selection.recreateDetached,
      },
      nodes,
      relations,
      counts,
    };
  }

  private endpointBlockedReason(
    codeNodeId: string,
    selectedIds: ReadonlySet<string>,
    previewById: ReadonlyMap<string, CodeMapInvestigationNodePreviewEntry>,
    bindingById: ReadonlyMap<string, CodeMapInvestigationNodeBinding>,
    recreateDetached: boolean,
    endpoint: "from" | "to",
  ): CodeMapInvestigationRelationPreviewEntry["blockedReason"] | undefined {
    if (selectedIds.has(codeNodeId)) {
      const entry = previewById.get(codeNodeId);
      if (entry?.state === "detached" && !recreateDetached) {
        return endpoint === "from" ? "from_node_detached" : "to_node_detached";
      }
      return undefined;
    }
    const binding = bindingById.get(codeNodeId);
    if (binding?.investigationNodeId && this.repository.getInvestigationNode(binding.investigationNodeId)) return undefined;
    if (binding?.syncState === "detached") {
      return endpoint === "from" ? "from_node_detached" : "to_node_detached";
    }
    return endpoint === "from" ? "from_node_unselected" : "to_node_unselected";
  }

  private applyPreview(
    projection: CodeArchitectureProjection,
    preview: CodeMapInvestigationSyncPreview,
    actor: ActorRef,
  ): CodeMapInvestigationSyncResult {
    const counts = emptyApplyCounts();
    const timestamp = this.now();
    const nodeById = new Map(projection.nodes.map((node) => [node.id, node] as const));
    const relationById = new Map(projection.relations.map((relation) => [relation.id, relation] as const));
    const activeNodeIds = new Map<string, string>();
    const resultNodeIds: string[] = [];
    const resultItemIds: string[] = [];
    const resultLinkIds: string[] = [];

    for (const binding of this.repository.listCodeMapInvestigationNodeBindings(projection.projectId)) {
      if (binding.investigationNodeId && this.repository.getInvestigationNode(binding.investigationNodeId)) {
        activeNodeIds.set(binding.codeNodeId, binding.investigationNodeId);
      }
    }

    for (const entry of preview.nodes) {
      const source = nodeById.get(entry.codeNodeId);
      const binding = this.repository.getCodeMapInvestigationNodeBinding(projection.projectId, entry.codeNodeId);
      if (entry.state === "create" || (entry.state === "detached" && preview.selection.recreateDetached)) {
        if (!source) continue;
        const node: InvestigationNode = {
          id: this.newId(),
          projectId: projection.projectId,
          title: source.title,
          description: "Generated from Code Map.",
          kind: investigationKindForCodeMapNode(source.kind),
          createdAt: timestamp,
          updatedAt: timestamp,
          revision: 1,
        };
        this.repository.createInvestigationNode(node);
        const initialPosition = INITIAL_NODE_POSITIONS[source.kind];
        const position: BoardNodePosition = {
          projectId: projection.projectId,
          entityType: "investigation_node",
          entityId: node.id,
          x: initialPosition.x,
          y: initialPosition.y,
          updatedBy: actor.id,
          updatedAt: timestamp,
        };
        this.repository.upsertBoardPosition(position);
        this.repository.upsertCodeMapInvestigationNodeBinding({
          projectId: projection.projectId,
          codeNodeId: source.id,
          investigationNodeId: node.id,
          sourceKind: source.kind,
          sourceTitle: source.title,
          sourceFingerprint: entry.sourceFingerprint,
          sourceIndexedAt: projection.sourceIndexedAt,
          syncState: "active",
          firstSyncedAt: binding?.firstSyncedAt ?? timestamp,
          lastSyncedAt: timestamp,
        });
        activeNodeIds.set(source.id, node.id);
        resultNodeIds.push(node.id);
        counts.createdNodes += 1;
        if (binding) counts.updatedBindings += 1;
        continue;
      }

      if (entry.state === "unchanged") {
        counts.unchangedNodes += 1;
        if (entry.investigationNodeId) resultNodeIds.push(entry.investigationNodeId);
        continue;
      }

      if (entry.state === "evidence_changed" && source && binding?.investigationNodeId) {
        this.repository.upsertCodeMapInvestigationNodeBinding({
          ...binding,
          sourceKind: source.kind,
          sourceTitle: source.title,
          sourceFingerprint: entry.sourceFingerprint,
          sourceIndexedAt: projection.sourceIndexedAt,
          syncState: "active",
          lastSyncedAt: timestamp,
        });
        activeNodeIds.set(source.id, binding.investigationNodeId);
        resultNodeIds.push(binding.investigationNodeId);
        counts.updatedBindings += 1;
        continue;
      }

      if (entry.state === "stale" && binding) {
        this.repository.upsertCodeMapInvestigationNodeBinding({
          ...binding,
          sourceIndexedAt: projection.sourceIndexedAt,
          syncState: "stale",
          lastSyncedAt: timestamp,
        });
        counts.staleBindings += 1;
        if (binding.investigationNodeId) resultNodeIds.push(binding.investigationNodeId);
        continue;
      }

      if (entry.state === "detached") counts.detachedBindings += 1;
    }

    const existingLinksById = new Map(
      this.repository.listInvestigationItemLinks(projection.projectId).map((link) => [link.id, link] as const),
    );
    for (const entry of preview.relations) {
      const source = relationById.get(entry.codeRelationId);
      const binding = this.repository.getCodeMapInvestigationRelationBinding(projection.projectId, entry.codeRelationId);
      if (entry.state === "blocked") {
        counts.blockedRelations += 1;
        continue;
      }
      if (entry.state === "create" || (entry.state === "detached" && preview.selection.recreateDetached)) {
        if (!source) continue;
        const fromNodeId = activeNodeIds.get(source.from);
        const toNodeId = activeNodeIds.get(source.to);
        if (!fromNodeId || !toNodeId) {
          counts.blockedRelations += 1;
          continue;
        }
        let item: InvestigationItem | undefined = binding?.investigationItemId
          ? this.repository.getInvestigationItem(binding.investigationItemId)
          : undefined;
        if (!item) {
          const target = nodeById.get(source.to);
          if (!target) {
            counts.blockedRelations += 1;
            continue;
          }
          item = {
            id: this.newId(),
            nodeId: fromNodeId,
            title: investigationRelationItemTitle(source, target),
            description: "Generated from Code Map.",
            sortOrder: nextSortOrder(this.repository.listInvestigationNodeItems(fromNodeId)),
            createdAt: timestamp,
            updatedAt: timestamp,
            revision: 1,
          };
          this.repository.createInvestigationItem(item);
          counts.createdRelationItems += 1;
        }
        let link: InvestigationItemLink | undefined = binding?.investigationItemLinkId
          ? existingLinksById.get(binding.investigationItemLinkId)
          : undefined;
        if (!link) {
          link = {
            id: this.newId(),
            projectId: projection.projectId,
            fromItemId: item.id,
            toNodeId,
            label: CODE_MAP_INVESTIGATION_RELATION_LABELS[source.kind],
            kind: source.kind,
            createdBy: actor.id,
            createdAt: timestamp,
          };
          this.repository.createInvestigationItemLink(link);
          existingLinksById.set(link.id, link);
          counts.createdRelationLinks += 1;
        }
        this.repository.upsertCodeMapInvestigationRelationBinding({
          projectId: projection.projectId,
          codeRelationId: source.id,
          fromCodeNodeId: source.from,
          toCodeNodeId: source.to,
          investigationItemId: item.id,
          investigationItemLinkId: link.id,
          relationKind: source.kind,
          sourceRelationIds: source.sourceRelationIds,
          sourceFingerprint: entry.sourceFingerprint,
          sourceIndexedAt: projection.sourceIndexedAt,
          syncState: "active",
          firstSyncedAt: binding?.firstSyncedAt ?? timestamp,
          lastSyncedAt: timestamp,
        });
        resultItemIds.push(item.id);
        resultLinkIds.push(link.id);
        if (binding) counts.updatedBindings += 1;
        continue;
      }

      if (entry.state === "unchanged") {
        counts.unchangedRelations += 1;
        if (entry.investigationItemId) resultItemIds.push(entry.investigationItemId);
        if (entry.investigationItemLinkId) resultLinkIds.push(entry.investigationItemLinkId);
        continue;
      }

      if (entry.state === "evidence_changed" && source && binding) {
        this.repository.upsertCodeMapInvestigationRelationBinding({
          ...binding,
          fromCodeNodeId: source.from,
          toCodeNodeId: source.to,
          relationKind: source.kind,
          sourceRelationIds: source.sourceRelationIds,
          sourceFingerprint: entry.sourceFingerprint,
          sourceIndexedAt: projection.sourceIndexedAt,
          syncState: "active",
          lastSyncedAt: timestamp,
        });
        counts.updatedBindings += 1;
        if (binding.investigationItemId) resultItemIds.push(binding.investigationItemId);
        if (binding.investigationItemLinkId) resultLinkIds.push(binding.investigationItemLinkId);
        continue;
      }

      if (entry.state === "stale" && binding) {
        this.repository.upsertCodeMapInvestigationRelationBinding({
          ...binding,
          sourceIndexedAt: projection.sourceIndexedAt,
          syncState: "stale",
          lastSyncedAt: timestamp,
        });
        counts.staleBindings += 1;
        if (binding.investigationItemId) resultItemIds.push(binding.investigationItemId);
        if (binding.investigationItemLinkId) resultLinkIds.push(binding.investigationItemLinkId);
        continue;
      }

      if (entry.state === "detached") counts.detachedBindings += 1;
    }

    return {
      projectId: projection.projectId,
      sourceIndexedAt: projection.sourceIndexedAt,
      projectionFingerprint: fingerprintCodeMapInvestigationProjection(projection),
      counts,
      investigationNodeIds: [...new Set(resultNodeIds)],
      investigationItemIds: [...new Set(resultItemIds)],
      investigationItemLinkIds: [...new Set(resultLinkIds)],
    };
  }
}
