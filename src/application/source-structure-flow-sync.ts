import { createHash, randomUUID } from "node:crypto";
import type { ActorRef, InvestigationItem, InvestigationItemLink, InvestigationNode } from "../core/domain.js";
import { deriveSourceStructureSyncGraph, type SourceStructureSelection, type SourceStructureSyncGraph } from "./source-structure-sync-graph.js";
import type { CodeGraphSnapshot } from "./code-intelligence.js";
import { SourceStructureBindingConflict, type SourceStructureBinding, type SourceStructureWrite } from "./source-structure-binding.js";
import type { MutationRequest } from "./quest-board-repository.js";
import { SqliteQuestBoardRepository } from "../storage/sqlite/sqlite-quest-board-repository.js";

/**
 * S4-only local domain service. S5 owns external authorization and the transport
 * adapters. The supplier must be a server-owned snapshot cache, not client JSON.
 */
export interface SourceStructureTrustedSource {
  read(projectId: string): { graph: CodeGraphSnapshot; snapshotId: string };
}
export type SourceStructurePreviewState =
  "create" | "unchanged" | "evidence_changed" | "stale" | "detached" | "blocked";
export interface SourceStructurePreviewEntry {
  bindingId: string;
  sourceId: string;
  state: SourceStructurePreviewState;
  reason?: string;
  targetId?: string | undefined;
  fromBindingId?: string;
  toBindingId?: string;
  relationKind?: string;
  rawRelationIds?: readonly string[];
  evidenceCount?: number;
  evidenceTruncated?: boolean;
}
export interface SourceStructureFlowPreview {
  projectId: string;
  snapshotId: string;
  sourceIndexedAt: string;
  selectionFingerprint: string;
  evidenceFingerprint: string;
  selectionKey: string;
  expectedSelectionRevision: number | null;
  selection: SourceStructureSyncGraph["selection"];
  diagnostics: SourceStructureSyncGraph["diagnostics"];
  nodes: SourceStructurePreviewEntry[];
  relations: SourceStructurePreviewEntry[];
  counts: Record<SourceStructurePreviewState, number>;
  warnings: string[];
  /** No user changes are ever overwritten, and no delete is supported. */
  destructiveActions: 0;
}
export interface SourceStructureApplyInput {
  projectId: string;
  selectionKey: string;
  selection: SourceStructureSelection;
  expectedSnapshotId: string;
  expectedSourceIndexedAt: string;
  expectedSelectionFingerprint: string;
  expectedSelectionRevision: number | null;
  requestId: string;
  actor: ActorRef;
  /** Distinct acknowledgement of the exact preview; never a default. */
  approved: true;
}
export interface SourceStructureApplyResult {
  preview: SourceStructureFlowPreview;
  createdNodes: number;
  createdRelationItems: number;
  createdRelationLinks: number;
  nodeIds: string[];
  itemIds: string[];
  linkIds: string[];
  replayed: boolean;
}
const fingerprint = (data: unknown) => createHash("sha256").update(JSON.stringify(data)).digest("hex");
function deny(code: string, message: string): never { throw new SourceStructureBindingConflict(code, message); }
const states = (): Record<SourceStructurePreviewState, number> => ({
  create: 0, unchanged: 0, evidence_changed: 0, stale: 0, detached: 0, blocked: 0,
});
const occupied = (binding: SourceStructureBinding) =>
  binding.entityType === "node"
    ? binding.target.investigationNodeId ?? undefined
    : binding.target.investigationItemLinkId ?? binding.target.investigationItemId ?? undefined;

/** Strict no-delete synchronization: existing bound Flow entities are only reused. */
export class SourceStructureFlowSyncService {
  constructor(
    private readonly repository: SqliteQuestBoardRepository,
    private readonly source: SourceStructureTrustedSource,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly newId: () => string = randomUUID,
  ) {}

  private derive(projectId: string, selection: SourceStructureSelection): SourceStructureSyncGraph {
    if (!this.repository.getProject(projectId)) deny("project_not_found", "Unknown project");
    const fresh = this.source.read(projectId);
    if (!fresh || fresh.graph.projectId !== projectId) deny("source_project_mismatch", "Trusted source project mismatch");
    return deriveSourceStructureSyncGraph(fresh.graph, selection, fresh.snapshotId);
  }

  preview(projectId: string, selectionKey: string, selection: SourceStructureSelection): SourceStructureFlowPreview {
    return this.previewGraph(this.derive(projectId, selection), selectionKey);
  }

  /** Trusted server-only projection from the pinned P2 read child. No raw graph
   * is hydrated into the daemon for a read-only preview. Apply still re-derives
   * inside the SQLite transaction and preserves its original strict CAS. */
  previewTrustedProjection(
    projectId: string, selectionKey: string, graph: SourceStructureSyncGraph,
  ): SourceStructureFlowPreview {
    if (!this.repository.getProject(projectId)) deny("project_not_found", "Unknown project");
    if (graph.projectId !== projectId || !graph.snapshotId || !graph.sourceIndexedAt) {
      deny("source_project_mismatch", "Trusted Source Structure preview identity mismatch");
    }
    return this.previewGraph(graph, selectionKey);
  }

  private previewGraph(graph: SourceStructureSyncGraph, selectionKey: string): SourceStructureFlowPreview {
    if (!selectionKey.trim()) deny("selection_key_required", "Selection key is mandatory");
    const previousSelection = this.repository.sourceStructureBindings.getSelection(graph.projectId, selectionKey);
    const counts = states();
    const nodes: SourceStructurePreviewEntry[] = [];
    const relations: SourceStructurePreviewEntry[] = [];
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const existingBindings = this.repository.sourceStructureBindings.listBindings(graph.projectId);
    const allBindings = new Map(existingBindings.map((binding) => [binding.bindingId, binding]));
    const classify = (id: string): { state: SourceStructurePreviewState; reason?: string; binding?: SourceStructureBinding } => {
      const binding = allBindings.get(id);
      if (!binding) return { state: "create" };
      const target = this.repository.sourceStructureBindings.inspectTarget(binding);
      if (binding.state === "detached" || !target.intact) return { state: "detached", reason: "flow_target_removed", binding };
      if (binding.state === "blocked" || target.manuallyChanged) return { state: "blocked", reason: "manual_flow_edit_or_collision", binding };
      if (binding.state === "stale" || binding.snapshotId !== graph.snapshotId ||
        binding.indexedAt !== graph.sourceIndexedAt) return { state: "stale", reason: "source_snapshot_changed", binding };
      if (binding.state === "evidence_changed" ||
        binding.graphEvidenceFingerprint !== graph.evidenceFingerprint ||
        binding.selectionFingerprint !== graph.selectionFingerprint) {
        return { state: "evidence_changed", reason: "source_evidence_or_selection_changed", binding };
      }
      return { state: "unchanged", binding };
    };
    for (const node of graph.nodes) {
      const state = classify(node.id);
      // Stable source binding IDs cannot take over a different semantic identity.
      if (state.binding && (state.binding.entityType !== "node" || state.binding.identityKey !== node.identityKey)) {
        state.state = "blocked";
        state.reason = "semantic_identity_collision";
      }
      counts[state.state]++;
      nodes.push({ bindingId: node.id, sourceId: node.sourceId, state: state.state,
        ...(state.reason ? { reason: state.reason } : {}),
        ...(occupiedTarget(state.binding) ? { targetId: occupiedTarget(state.binding) } : {}) });
    }
    const nodeState = new Map(nodes.map((node) => [node.bindingId, node.state]));
    for (const relation of graph.relations) {
      const state = classify(relation.id);
      if (state.binding && (state.binding.entityType !== "relation" || state.binding.fromBindingId !== relation.from ||
        state.binding.toBindingId !== relation.to || state.binding.relationKind !== relation.kind)) {
        state.state = "blocked";
        state.reason = "relation_identity_collision";
      }
      if (!nodesById.has(relation.from) || !nodesById.has(relation.to)) {
        state.state = "blocked";
        state.reason = !nodesById.has(relation.from) ? "from_node_unselected" : "to_node_unselected";
      } else if (nodeState.get(relation.from) !== "create" && nodeState.get(relation.from) !== "unchanged") {
        state.state = "blocked";
        state.reason = "from_node_unavailable";
      } else if (nodeState.get(relation.to) !== "create" && nodeState.get(relation.to) !== "unchanged") {
        state.state = "blocked";
        state.reason = "to_node_unavailable";
      }
      counts[state.state]++;
      relations.push({ bindingId: relation.id, sourceId: relation.sourceId, state: state.state,
        fromBindingId: relation.from, toBindingId: relation.to, relationKind: relation.kind,
        rawRelationIds: relation.rawRelationIds, evidenceCount: relation.sourceRelationCount,
        evidenceTruncated: relation.evidenceTruncated,
        ...(state.reason ? { reason: state.reason } : {}),
        ...(occupiedTarget(state.binding) ? { targetId: occupiedTarget(state.binding) } : {}) });
    }
    const warnings: string[] = [];
    if (graph.relations.length === 0) warnings.push(
      "No selected raw-evidence-backed relations: " + (graph.diagnostics.noSelectedRelationsReason ?? "no_eligible_edges"));
    if (graph.selection.omittedEligibleRelationCount) warnings.push("Eligible relations omitted by explicit selection");
    if (graph.diagnostics.evidenceSamplesTruncated) warnings.push("Raw evidence samples truncated; full count retained");
    if (graph.selection.subsystemPage.truncated) warnings.push("Subsystem page is truncated; never sync entire project implicitly");
    if (counts.detached || counts.blocked || counts.stale || counts.evidence_changed)
      warnings.push("Review protected bindings; apply refuses unresolved conflicts");
    for (const node of nodes) if (!relations.some((r) => r.fromBindingId === node.bindingId || r.toBindingId === node.bindingId))
      warnings.push("Isolated selected source node: " + node.bindingId);
    // Even a valid marker is not permission to claim an unbound manual target.
    return { projectId: graph.projectId, snapshotId: graph.snapshotId,
      sourceIndexedAt: graph.sourceIndexedAt, selectionFingerprint: graph.selectionFingerprint,
      evidenceFingerprint: graph.evidenceFingerprint, selectionKey,
      expectedSelectionRevision: previousSelection?.revision ?? null,
      selection: graph.selection, diagnostics: graph.diagnostics, nodes, relations, counts, warnings,
      destructiveActions: 0 };
  }

  apply(
    input: SourceStructureApplyInput,
    trusted?: { graph: SourceStructureSyncGraph; assertCurrent: () => void },
  ): SourceStructureApplyResult {
    if (input.approved !== true || !input.actor?.id?.trim() || !input.actor.provider?.trim() ||
      !input.requestId?.trim() || !input.expectedSelectionFingerprint?.trim() ||
      !input.expectedSnapshotId?.trim() || !input.expectedSourceIndexedAt?.trim()) {
      deny("explicit_approval_required", "Apply requires actor, approval, request ID and exact preview pins");
    }
    if (input.selection.expectedSnapshotId !== input.expectedSnapshotId ||
      input.selection.expectedSourceIndexedAt !== input.expectedSourceIndexedAt) {
      deny("snapshot_pin_mismatch", "Apply pins must match the selected page pins");
    }
    const mutation: MutationRequest = {
      operation: "source-structure.flow-sync.apply", requestId: input.requestId,
      actorId: input.actor.id, createdAt: this.now(),
      fingerprint: fingerprint({ projectId: input.projectId, selectionKey: input.selectionKey,
        selection: input.selection, snapshotId: input.expectedSnapshotId,
        indexedAt: input.expectedSourceIndexedAt, fingerprint: input.expectedSelectionFingerprint,
        revision: input.expectedSelectionRevision, actor: input.actor }),
    };
    if (trusted && (trusted.graph.projectId !== input.projectId
      || trusted.graph.snapshotId !== input.expectedSnapshotId
      || trusted.graph.sourceIndexedAt !== input.expectedSourceIndexedAt)) {
      deny("preview_stale", "Trusted apply graph does not match the approved source");
    }
    // Legacy mode re-derives from the trusted source inside this transaction.
    // P2 mode uses a trusted child projection and verifies its persisted-source
    // revision before and after writes, alongside the existing Flow CAS.
    const execution = this.repository.runIdempotentMutation(mutation, () => {
      trusted?.assertCurrent();
      const graph = trusted?.graph ?? this.derive(input.projectId, input.selection);
      if (graph.snapshotId !== input.expectedSnapshotId ||
        graph.sourceIndexedAt !== input.expectedSourceIndexedAt ||
        graph.selectionFingerprint !== input.expectedSelectionFingerprint) {
        deny("preview_stale", "Current trusted source no longer matches approved preview");
      }
      const preview = this.previewGraph(graph, input.selectionKey);
      if (preview.expectedSelectionRevision !== input.expectedSelectionRevision)
        deny("selection_revision_conflict", "Selected Flow binding changed since preview");
      const conflicts = preview.nodes.concat(preview.relations).filter((entry) =>
        entry.state !== "create" && entry.state !== "unchanged");
      if (conflicts.length) deny("protected_binding_conflict", "Stale, detached or manually edited bindings require separate review");
      const timestamp = this.now();
      const nodeMap = new Map<string, string>();
      const writes: SourceStructureWrite[] = [];
      const nodeIds: string[] = [], itemIds: string[] = [], linkIds: string[] = [];
      for (const entry of preview.nodes) {
        if (entry.state === "unchanged") {
          if (!entry.targetId) deny("missing_owned_target", "Existing node binding is missing target");
          nodeMap.set(entry.bindingId, entry.targetId);
          continue;
        }
        const sourceNode = graph.nodes.find((n) => n.id === entry.bindingId)!;
        const id = this.newId();
        const node: InvestigationNode = {
          id, projectId: graph.projectId, title: sourceNode.title,
          description: "Source Structure " + sourceNode.sourceType + " (" + sourceNode.pathPrefix + ")",
          kind: "source-structure/" + sourceNode.sourceType,
          createdAt: timestamp, updatedAt: timestamp, revision: 1,
        };
        this.repository.createInvestigationNode(node);
        nodeMap.set(entry.bindingId, id);
        nodeIds.push(id);
        writes.push({ bindingId: entry.bindingId, target: { investigationNodeId: id }, expectedRevision: null });
      }
      for (const entry of preview.relations) {
        if (entry.state !== "create") continue;
        const sourceRel = graph.relations.find((r) => r.id === entry.bindingId)!;
        const from = nodeMap.get(sourceRel.from), to = nodeMap.get(sourceRel.to);
        if (!from || !to) deny("relation_endpoint_missing", "An unselected or detached endpoint cannot be linked");
        const id = this.newId(), linkId = this.newId();
        const item: InvestigationItem = {
          id, nodeId: from, title: sourceRel.kind + " → " + graph.nodes.find((n) => n.id === sourceRel.to)!.title,
          description: "Source Structure directed " + sourceRel.kind + "; raw facts: " + sourceRel.rawRelationIds.join(", "),
          sortOrder: this.repository.listInvestigationNodeItems(from).length,
          createdAt: timestamp, updatedAt: timestamp, revision: 1,
        };
        this.repository.createInvestigationItem(item);
        const link: InvestigationItemLink = {
          id: linkId, projectId: graph.projectId, fromItemId: id, toNodeId: to,
          label: sourceRel.kind, kind: "source-structure/" + sourceRel.kind,
          createdBy: input.actor.id, createdAt: timestamp,
        };
        this.repository.createInvestigationItemLink(link);
        itemIds.push(id); linkIds.push(linkId);
        writes.push({ bindingId: entry.bindingId,
          target: { investigationItemId: id, investigationItemLinkId: linkId }, expectedRevision: null });
      }
      if (writes.length) this.repository.sourceStructureBindings.record({
        graph, selectionKey: input.selectionKey, expectedSelectionRevision: input.expectedSelectionRevision,
        currentSnapshotId: graph.snapshotId, currentIndexedAt: graph.sourceIndexedAt,
        requestId: input.requestId, actor: input.actor, recordedAt: timestamp, writes,
      });
      // If a background atomic snapshot replacement crossed this transaction,
      // throw before SQLite commit so none of the Flow writes survive.
      trusted?.assertCurrent();
      return { preview, createdNodes: nodeIds.length, createdRelationItems: itemIds.length,
        createdRelationLinks: linkIds.length, nodeIds, itemIds, linkIds, replayed: false };
    });
    return { ...execution.value, replayed: execution.replayed };
  }
}
function occupiedTarget(binding?: SourceStructureBinding): string | undefined {
  return binding ? occupied(binding) : undefined;
}
