import type { SourceStructureSyncGraph } from "./source-structure-sync-graph.js";

/** S3 persistence contract only. This module cannot create, update or delete Flow objects. */
export type SourceStructureBindingState =
  | "active" | "evidence_changed" | "stale" | "detached" | "no_longer_selected" | "blocked";

export type SourceStructureTarget = {
  investigationNodeId?: string | null;
  investigationItemId?: string | null;
  investigationItemLinkId?: string | null;
};

/** The exact target values seen at initial attach; all layout and user edits remain authoritative. */
export interface SourceStructureTargetBaseline {
  title?: string;
  description?: string;
  kind?: string | null;
  revision?: number;
  /** A changed canvas position or Work Group membership blocks silent overwrite. */
  positionSignature?: string;
  membershipSignature?: string;
  /** Item/link fields are recorded as seen, not replaced with generated content. */
  contentSignature?: string;
}

export interface SourceStructureBinding {
  projectId: string;
  bindingId: string;
  schemaVersion: 1;
  entityType: "node" | "relation";
  identityKey: string;
  sourceId: string;
  sourceType: string;
  fromBindingId: string | null;
  toBindingId: string | null;
  relationKind: string | null;
  evidenceCount: number;
  evidenceDigest: string;
  rawRelationIds: string[];
  indexedAt: string;
  snapshotId: string;
  selectionFingerprint: string;
  graphEvidenceFingerprint: string;
  target: SourceStructureTarget;
  baseline: SourceStructureTargetBaseline;
  state: SourceStructureBindingState;
  lastSyncActorId: string;
  lastSyncActorProvider: string;
  firstSyncedAt: string;
  lastSyncedAt: string;
  revision: number;
}

export interface SourceStructureSelectionRecord {
  projectId: string;
  selectionKey: string;
  schemaVersion: 1;
  snapshotId: string;
  indexedAt: string;
  selectionFingerprint: string;
  evidenceFingerprint: string;
  selectedNodeIds: string[];
  selectedRelationIds: string[];
  revision: number;
  actorId: string;
  actorProvider: string;
  updatedAt: string;
}

export interface SourceStructureWrite {
  bindingId: string;
  target?: SourceStructureTarget;
  baseline?: SourceStructureTargetBaseline;
  /** Preserve the old attachment or explicitly detach; an absent target never deletes Flow. */
  state?: SourceStructureBindingState;
  /** null means this is an insert and fails when the binding already exists. */
  expectedRevision: number | null;
}

export interface SourceStructureRecordRequest {
  graph: SourceStructureSyncGraph;
  selectionKey: string;
  expectedSelectionRevision: number | null;
  /** Independently refreshed snapshot, never inferred from the submitted graph. */
  currentSnapshotId: string;
  currentIndexedAt: string;
  requestId: string;
  actor: { id: string; provider: string };
  recordedAt: string;
  writes: readonly SourceStructureWrite[];
}

export interface SourceStructureRecordResult {
  selection: SourceStructureSelectionRecord;
  bindings: SourceStructureBinding[];
  replayed: boolean;
}

export class SourceStructureBindingConflict extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "SourceStructureBindingConflict";
  }
}

export interface SourceStructureReconciliation {
  bindingId: string;
  state: SourceStructureBindingState;
  reason: string;
  /** Whether a future S4 apply may consider the binding without explicit human resolution. */
  automaticWriteAllowed: false;
}

/** Conservative, read-only reconciliation. A snapshot-wide fingerprint may stale on unrelated changes. */
export function reconcileSourceStructureBinding(
  previous: SourceStructureBinding,
  graph: SourceStructureSyncGraph | undefined,
  targetIntact: boolean,
  targetManuallyChanged: boolean,
): SourceStructureReconciliation {
  const result = (state: SourceStructureBindingState, reason: string): SourceStructureReconciliation =>
    ({ bindingId: previous.bindingId, state, reason, automaticWriteAllowed: false });
  if (previous.state === "detached" || !targetIntact) return result("detached", "flow_target_removed_or_detached");
  if (previous.state === "blocked" || targetManuallyChanged) return result("blocked", "manual_flow_edit_or_collision");
  if (previous.state === "stale") return result("stale", "previous_stale_state_requires_explicit_review");
  if (previous.state === "evidence_changed") return result("evidence_changed", "changed_evidence_requires_explicit_review");
  if (!graph || graph.projectId !== previous.projectId || graph.schemaVersion !== previous.schemaVersion
    || graph.snapshotId !== previous.snapshotId || graph.sourceIndexedAt !== previous.indexedAt) {
    return result("stale", "pinned_source_snapshot_changed");
  }
  const match = previous.entityType === "node"
    ? graph.nodes.find((item) => item.id === previous.bindingId)
    : graph.relations.find((item) => item.id === previous.bindingId);
  if (!match) return result("no_longer_selected", "explicit_selection_excludes_binding");
  if (previous.selectionFingerprint !== graph.selectionFingerprint
    || previous.graphEvidenceFingerprint !== graph.evidenceFingerprint) {
    return result("evidence_changed", "selection_or_raw_evidence_fingerprint_changed");
  }
  return result("active", "same_identity_snapshot_and_evidence");
}
