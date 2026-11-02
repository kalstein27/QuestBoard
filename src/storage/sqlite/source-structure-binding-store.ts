import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  SOURCE_STRUCTURE_SYNC_BINDING_PREFIX,
  SOURCE_STRUCTURE_SYNC_RELATION_PREFIX,
  SOURCE_STRUCTURE_SYNC_LIMITS,
} from "../../application/source-structure-sync-graph.js";
import type { SourceStructureSyncGraph } from "../../application/source-structure-sync-graph.js";
import {
  SourceStructureBindingConflict,
  type SourceStructureBinding, type SourceStructureBindingState,
  type SourceStructureRecordRequest, type SourceStructureRecordResult,
  type SourceStructureSelectionRecord, type SourceStructureTarget,
  type SourceStructureTargetBaseline,
} from "../../application/source-structure-binding.js";

const STATES = new Set<SourceStructureBindingState>([
  "active", "evidence_changed", "stale", "detached", "no_longer_selected", "blocked",
]);
const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code: string, message: string): never => {
  throw new SourceStructureBindingConflict(code, message);
};

type Row = Record<string, string | number | null>;
type SelectionRow = Row;
type BindingRow = Row;

/**
 * Add-only migration. No old 6-role / manual Flow data is read, rewritten,
 * transformed or deleted. All ON DELETE behavior retains source metadata.
 */
export function migrateSourceStructureBindings(db: DatabaseSync): void {
  db.exec("SAVEPOINT source_structure_binding_migration");
  try {
    db.exec(`
    CREATE TABLE IF NOT EXISTS source_structure_selections (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      selection_key TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      snapshot_id TEXT NOT NULL,
      indexed_at TEXT NOT NULL,
      selection_fingerprint TEXT NOT NULL,
      evidence_fingerprint TEXT NOT NULL,
      node_ids_json TEXT NOT NULL,
      relation_ids_json TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      actor_id TEXT NOT NULL,
      actor_provider TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, selection_key)
    );
    CREATE TABLE IF NOT EXISTS source_structure_bindings (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      binding_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      entity_type TEXT NOT NULL CHECK (entity_type IN ('node', 'relation')),
      identity_key TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      from_binding_id TEXT,
      to_binding_id TEXT,
      relation_kind TEXT,
      evidence_count INTEGER NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
      evidence_digest TEXT NOT NULL,
      raw_relation_ids_json TEXT NOT NULL DEFAULT '[]',
      indexed_at TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      selection_fingerprint TEXT NOT NULL,
      graph_evidence_fingerprint TEXT NOT NULL,
      investigation_node_id TEXT UNIQUE REFERENCES investigation_nodes(id) ON DELETE SET NULL,
      investigation_item_id TEXT UNIQUE REFERENCES investigation_items(id) ON DELETE SET NULL,
      investigation_item_link_id TEXT UNIQUE REFERENCES investigation_item_links(id) ON DELETE SET NULL,
      baseline_json TEXT NOT NULL DEFAULT '{}',
      sync_state TEXT NOT NULL CHECK (sync_state IN
        ('active', 'evidence_changed', 'stale', 'detached', 'no_longer_selected', 'blocked')),
      last_actor_id TEXT NOT NULL,
      last_actor_provider TEXT NOT NULL,
      first_synced_at TEXT NOT NULL,
      last_synced_at TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      PRIMARY KEY (project_id, binding_id),
      UNIQUE (project_id, entity_type, identity_key),
      CHECK (
        (entity_type = 'node' AND from_binding_id IS NULL AND to_binding_id IS NULL
          AND relation_kind IS NULL AND investigation_item_id IS NULL AND investigation_item_link_id IS NULL)
        OR
        (entity_type = 'relation' AND from_binding_id IS NOT NULL AND to_binding_id IS NOT NULL
          AND relation_kind IS NOT NULL AND investigation_node_id IS NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS source_structure_bindings_state_idx
      ON source_structure_bindings(project_id, sync_state);
    CREATE TABLE IF NOT EXISTS source_structure_mutation_receipts (
      request_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS source_structure_node_detach
    BEFORE DELETE ON investigation_nodes FOR EACH ROW BEGIN
      UPDATE source_structure_bindings
      SET investigation_node_id = NULL, sync_state = 'detached', revision = revision + 1
      WHERE investigation_node_id = OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS source_structure_item_detach
    BEFORE DELETE ON investigation_items FOR EACH ROW BEGIN
      UPDATE source_structure_bindings
      SET investigation_item_id = NULL, sync_state = 'detached', revision = revision + 1
      WHERE investigation_item_id = OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS source_structure_link_detach
    BEFORE DELETE ON investigation_item_links FOR EACH ROW BEGIN
      UPDATE source_structure_bindings
      SET investigation_item_link_id = NULL, sync_state = 'detached', revision = revision + 1
      WHERE investigation_item_link_id = OLD.id;
    END;
    `);
    db.exec("RELEASE SAVEPOINT source_structure_binding_migration");
  } catch (error) {
    db.exec("ROLLBACK TO SAVEPOINT source_structure_binding_migration");
    db.exec("RELEASE SAVEPOINT source_structure_binding_migration");
    throw error;
  }
}

function selectionFrom(row: SelectionRow): SourceStructureSelectionRecord {
  return {
    projectId: String(row.project_id), selectionKey: String(row.selection_key),
    schemaVersion: 1, snapshotId: String(row.snapshot_id), indexedAt: String(row.indexed_at),
    selectionFingerprint: String(row.selection_fingerprint),
    evidenceFingerprint: String(row.evidence_fingerprint),
    selectedNodeIds: JSON.parse(String(row.node_ids_json)) as string[],
    selectedRelationIds: JSON.parse(String(row.relation_ids_json)) as string[],
    revision: Number(row.revision), actorId: String(row.actor_id),
    actorProvider: String(row.actor_provider), updatedAt: String(row.updated_at),
  };
}
function bindingFrom(row: BindingRow): SourceStructureBinding {
  return {
    projectId: String(row.project_id), bindingId: String(row.binding_id),
    schemaVersion: 1, entityType: row.entity_type as "node" | "relation",
    identityKey: String(row.identity_key), sourceId: String(row.source_id),
    sourceType: String(row.source_type),
    fromBindingId: row.from_binding_id as string | null,
    toBindingId: row.to_binding_id as string | null,
    relationKind: row.relation_kind as string | null,
    evidenceCount: Number(row.evidence_count), evidenceDigest: String(row.evidence_digest),
    rawRelationIds: JSON.parse(String(row.raw_relation_ids_json)) as string[],
    indexedAt: String(row.indexed_at), snapshotId: String(row.snapshot_id),
    selectionFingerprint: String(row.selection_fingerprint),
    graphEvidenceFingerprint: String(row.graph_evidence_fingerprint),
    target: {
      investigationNodeId: row.investigation_node_id as string | null,
      investigationItemId: row.investigation_item_id as string | null,
      investigationItemLinkId: row.investigation_item_link_id as string | null,
    },
    baseline: JSON.parse(String(row.baseline_json)) as SourceStructureTargetBaseline,
    state: row.sync_state as SourceStructureBindingState,
    lastSyncActorId: String(row.last_actor_id), lastSyncActorProvider: String(row.last_actor_provider),
    firstSyncedAt: String(row.first_synced_at), lastSyncedAt: String(row.last_synced_at),
    revision: Number(row.revision),
  };
}
function equivalentTargets(a: SourceStructureTarget, b: SourceStructureTarget): boolean {
  return (a.investigationNodeId ?? null) === (b.investigationNodeId ?? null)
    && (a.investigationItemId ?? null) === (b.investigationItemId ?? null)
    && (a.investigationItemLinkId ?? null) === (b.investigationItemLinkId ?? null);
}

export class SqliteSourceStructureBindingStore {
  constructor(private readonly db: DatabaseSync) {}

  getSelection(projectId: string, selectionKey: string): SourceStructureSelectionRecord | undefined {
    const row = this.db.prepare(
      "SELECT * FROM source_structure_selections WHERE project_id = ? AND selection_key = ?",
    ).get(projectId, selectionKey) as SelectionRow | undefined;
    return row ? selectionFrom(row) : undefined;
  }

  getBinding(projectId: string, bindingId: string): SourceStructureBinding | undefined {
    const row = this.db.prepare(
      "SELECT * FROM source_structure_bindings WHERE project_id = ? AND binding_id = ?",
    ).get(projectId, bindingId) as BindingRow | undefined;
    return row ? bindingFrom(row) : undefined;
  }

  listBindings(projectId: string): SourceStructureBinding[] {
    return (this.db.prepare(
      "SELECT * FROM source_structure_bindings WHERE project_id = ? ORDER BY entity_type, binding_id",
    ).all(projectId) as BindingRow[]).map(bindingFrom);
  }

  /** Read-only conservative conflict evaluation for S4. */
  inspectTarget(binding: SourceStructureBinding): { intact: boolean; manuallyChanged: boolean } {
    if (binding.state === "detached" || !Object.values(binding.target).some(Boolean)) {
      return { intact: false, manuallyChanged: false };
    }
    try {
      const current = this.targetBaseline(binding.projectId, binding.entityType, binding.target);
      return { intact: true, manuallyChanged: hash(current) !== hash(binding.baseline) };
    } catch (error) {
      if (error instanceof SourceStructureBindingConflict) {
        if (error.code === "target_missing") return { intact: false, manuallyChanged: false };
        if (error.code === "manual_target_protected" || error.code === "target_collision") {
          return { intact: true, manuallyChanged: true };
        }
      }
      throw error;
    }
  }

  private targetBaseline(
    projectId: string, type: "node" | "relation", target: SourceStructureTarget,
  ): SourceStructureTargetBaseline {
    if (type === "node") {
      if (!target.investigationNodeId) return {};
      const node = this.db.prepare("SELECT * FROM investigation_nodes WHERE id = ? AND project_id = ?")
        .get(target.investigationNodeId, projectId) as Row | undefined;
      if (!node) return fail("target_missing", "Investigation node missing or from another project");
      if (!String(node.kind ?? "").startsWith("source-structure/")) {
        return fail("manual_target_protected", "Unmarked manual/legacy Flow node cannot be claimed by Source Structure");
      }
      const position = this.db.prepare(
        "SELECT x, y FROM board_positions WHERE project_id = ? AND entity_type = 'investigation_node' AND entity_id = ?",
      ).get(projectId, target.investigationNodeId) as Row | undefined;
      const memberships = this.db.prepare(
        "SELECT group_id FROM flow_work_group_memberships WHERE project_id = ? AND entity_type = 'investigation_node' AND entity_id = ? ORDER BY group_id",
      ).all(projectId, target.investigationNodeId) as Row[];
      return {
        title: String(node.title), description: String(node.description),
        kind: node.kind as string | null, revision: Number(node.revision),
        positionSignature: JSON.stringify(position ? [position.x, position.y] : null),
        membershipSignature: JSON.stringify(memberships.map((value) => value.group_id)),
      };
    }
    if (!target.investigationItemId && !target.investigationItemLinkId) return {};
    const baseline: SourceStructureTargetBaseline = {};
    if (target.investigationItemId) {
      const item = this.db.prepare(
        "SELECT i.*, n.kind AS parent_kind FROM investigation_items i JOIN investigation_nodes n ON n.id = i.node_id WHERE i.id = ? AND n.project_id = ?",
      ).get(target.investigationItemId, projectId) as Row | undefined;
      if (!item) return fail("target_missing", "Investigation item missing or from another project");
      if (!String(item.parent_kind ?? "").startsWith("source-structure/")) {
        return fail("manual_target_protected", "Unmarked manual/legacy Flow item cannot be claimed by Source Structure");
      }
      baseline.title = String(item.title);
      baseline.description = String(item.description);
      baseline.revision = Number(item.revision);
      baseline.contentSignature = JSON.stringify([item.node_id, item.sort_order]);
    }
    if (target.investigationItemLinkId) {
      const link = this.db.prepare(
        "SELECT * FROM investigation_item_links WHERE id = ? AND project_id = ?",
      ).get(target.investigationItemLinkId, projectId) as Row | undefined;
      if (!link) return fail("target_missing", "Investigation link missing or from another project");
      if (!String(link.kind ?? "").startsWith("source-structure/")) {
        return fail("manual_target_protected", "Unmarked manual/legacy Flow link cannot be claimed by Source Structure");
      }
      if (target.investigationItemId && link.from_item_id !== target.investigationItemId) {
        return fail("target_collision", "Investigation link no longer originates from bound item");
      }
      baseline.membershipSignature = JSON.stringify([
        link.from_item_id, link.to_node_id, link.kind, link.label,
      ]);
    }
    return baseline;
  }

  private assertTargetFree(projectId: string, type: "node" | "relation", target: SourceStructureTarget): void {
    const checks = [
      [target.investigationNodeId, "code_map_investigation_node_bindings", "investigation_node_id"],
      [target.investigationItemId, "code_map_investigation_relation_bindings", "investigation_item_id"],
      [target.investigationItemLinkId, "code_map_investigation_relation_bindings", "investigation_item_link_id"],
    ] as const;
    for (const [id, table, column] of checks) {
      if (!id) continue;
      const occupied = this.db.prepare(
        `SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`,
      ).get(id);
      if (occupied) return fail("legacy_target_collision", "Flow endpoint belongs to existing 6-role binding");
    }
    if (type === "node" && (target.investigationItemId || target.investigationItemLinkId)) {
      return fail("invalid_target", "Node binding cannot own relation targets");
    }
    if (type === "relation" && target.investigationNodeId) {
      return fail("invalid_target", "Relation binding cannot own node target");
    }
    // Target availability in the new namespace is guarded by SQLite UNIQUE columns.
    // The same transaction also checks the live target's project and current revision.
    void projectId;
  }

  record(request: SourceStructureRecordRequest): SourceStructureRecordResult {
    // No Flow mutation is performed here; only independent S3 metadata is written.
    const { graph, actor, writes } = request;
    if (graph.schemaVersion !== 1 || !graph.projectId || !request.selectionKey.trim()
      || !request.requestId.trim() || !actor.id.trim() || !actor.provider.trim()) {
      return fail("invalid_record", "Missing or unsupported source structure record metadata");
    }
    if (!request.currentSnapshotId || !request.currentIndexedAt
      || graph.snapshotId !== request.currentSnapshotId
      || graph.sourceIndexedAt !== request.currentIndexedAt) {
      return fail("snapshot_pin_mismatch", "Live source snapshot must match both explicit pins");
    }
    if (graph.nodes.length > SOURCE_STRUCTURE_SYNC_LIMITS.nodes
      || graph.relations.length > SOURCE_STRUCTURE_SYNC_LIMITS.relations) {
      return fail("selection_cap", "S2 explicit selection bounds exceeded");
    }
    const ids = new Set([...graph.nodes.map((item) => item.id), ...graph.relations.map((item) => item.id)]);
    if (ids.size !== graph.nodes.length + graph.relations.length || new Set(writes.map((w) => w.bindingId)).size !== writes.length) {
      return fail("duplicate_binding", "Repeated source structure binding identity");
    }
    for (const item of graph.nodes) {
      if (!item.id.startsWith(SOURCE_STRUCTURE_SYNC_BINDING_PREFIX) || !item.identityKey) {
        return fail("invalid_identity", "Only versioned S2 Source Structure node binding IDs are valid");
      }
    }
    for (const item of graph.relations) {
      if (!item.id.startsWith(SOURCE_STRUCTURE_SYNC_RELATION_PREFIX)
        || !graph.nodes.some((node) => node.id === item.from)
        || !graph.nodes.some((node) => node.id === item.to)
        || item.sourceRelationCount <= 0 || item.rawRelationIds.length > SOURCE_STRUCTURE_SYNC_LIMITS.evidence) {
        return fail("invalid_evidence", "Relation endpoints and real bounded raw evidence are mandatory");
      }
    }
    if (writes.some((write) => !ids.has(write.bindingId) || write.expectedRevision === undefined)) {
      return fail("selection_exclusion", "Writes must belong to exact pinned selection with explicit CAS");
    }
    const fingerprint = hash({
      graph, selectionKey: request.selectionKey, expectedSelectionRevision: request.expectedSelectionRevision,
      currentSnapshotId: request.currentSnapshotId, currentIndexedAt: request.currentIndexedAt,
      writes, actor, recordedAt: request.recordedAt,
    });
    // S4 may compose Flow creation and binding metadata inside the repository's
    // already-open BEGIN IMMEDIATE transaction. A nested savepoint shares the
    // same atomic commit/rollback boundary without independently committing Flow.
    const nested = this.db.isTransaction;
    this.db.exec(nested ? "SAVEPOINT source_structure_record" : "BEGIN IMMEDIATE");
    try {
      const existingReceipt = this.db.prepare(
        "SELECT * FROM source_structure_mutation_receipts WHERE request_id = ?",
      ).get(request.requestId) as Row | undefined;
      if (existingReceipt) {
        if (existingReceipt.project_id !== graph.projectId
          || existingReceipt.actor_id !== actor.id || existingReceipt.fingerprint !== fingerprint) {
          return fail("request_id_conflict", "Idempotency request ID reused with different payload");
        }
        const replay = JSON.parse(String(existingReceipt.result_json)) as SourceStructureRecordResult;
        this.db.exec(nested ? "RELEASE SAVEPOINT source_structure_record" : "COMMIT");
        return { ...replay, replayed: true };
      }
      const previousSelection = this.getSelection(graph.projectId, request.selectionKey);
      if ((previousSelection?.revision ?? null) !== request.expectedSelectionRevision) {
        return fail("selection_revision_conflict", "Source selection CAS mismatch");
      }
      const selectionRevision = (previousSelection?.revision ?? 0) + 1;
      this.db.prepare(`
        INSERT INTO source_structure_selections (
          project_id, selection_key, schema_version, snapshot_id, indexed_at,
          selection_fingerprint, evidence_fingerprint, node_ids_json, relation_ids_json,
          revision, actor_id, actor_provider, updated_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, selection_key) DO UPDATE SET
          snapshot_id=excluded.snapshot_id, indexed_at=excluded.indexed_at,
          selection_fingerprint=excluded.selection_fingerprint,
          evidence_fingerprint=excluded.evidence_fingerprint,
          node_ids_json=excluded.node_ids_json, relation_ids_json=excluded.relation_ids_json,
          revision=excluded.revision, actor_id=excluded.actor_id,
          actor_provider=excluded.actor_provider, updated_at=excluded.updated_at
      `).run(graph.projectId, request.selectionKey, graph.snapshotId, graph.sourceIndexedAt,
        graph.selectionFingerprint, graph.evidenceFingerprint,
        JSON.stringify(graph.nodes.map((n) => n.id).sort()),
        JSON.stringify(graph.relations.map((n) => n.id).sort()),
        selectionRevision, actor.id, actor.provider, request.recordedAt);
      const updated: SourceStructureBinding[] = [];
      for (const write of writes) {
        const node = graph.nodes.find((item) => item.id === write.bindingId);
        const relation = graph.relations.find((item) => item.id === write.bindingId);
        if (!node && !relation) return fail("selection_exclusion", "Unselected binding");
        const type = node ? "node" : "relation";
        const prior = this.getBinding(graph.projectId, write.bindingId);
        if ((prior?.revision ?? null) !== write.expectedRevision) {
          return fail("binding_revision_conflict", "Source binding CAS mismatch");
        }
        const identityKey = node?.identityKey ?? relation!.id;
        if (prior && (prior.entityType !== type || prior.identityKey !== identityKey
          || prior.schemaVersion !== graph.schemaVersion)) {
          return fail("identity_changed", "Semantic identity changed: explicit new binding required");
        }
        if (prior && (prior.snapshotId !== graph.snapshotId || prior.indexedAt !== graph.sourceIndexedAt)
          && write.state !== "stale" && write.state !== "blocked") {
          return fail("stale_requires_review", "Changed source snapshot requires an explicit stale decision");
        }
        if (prior && (prior.selectionFingerprint !== graph.selectionFingerprint
          || prior.graphEvidenceFingerprint !== graph.evidenceFingerprint)
          && !["stale", "evidence_changed", "blocked"].includes(write.state ?? "")) {
          return fail("evidence_requires_review", "Changed source evidence requires explicit review state");
        }
        const target = write.target ?? prior?.target ?? {};
        if (prior && !equivalentTargets(prior.target, target)) {
          return fail("target_reassignment_blocked", "Manual/detached Flow targets must never be reassigned implicitly");
        }
        if (prior?.state === "detached" && Object.values(target).some(Boolean)) {
          return fail("detached_protected", "Deleted/detached Flow targets cannot be silently recreated or relinked");
        }
        this.assertTargetFree(graph.projectId, type, target);
        const liveBaseline = this.targetBaseline(graph.projectId, type, target);
        if (prior && hash(liveBaseline) !== hash(prior.baseline)) {
          return fail("manual_edit_conflict", "Flow layout/content/links changed after source binding; preserve user edits");
        }
        if (write.baseline && hash(write.baseline) !== hash(liveBaseline)) {
          return fail("target_revision_conflict", "Caller-supplied Flow baseline differs from current target");
        }
        const state = write.state ?? prior?.state ?? (Object.values(target).some(Boolean) ? "active" : "blocked");
        if (!STATES.has(state)) return fail("invalid_state", "Unknown source structure binding state");
        if ((state === "active" || state === "evidence_changed") && !Object.values(target).some(Boolean)) {
          return fail("unbound_active", "Unattached binding cannot be active");
        }
        const evidenceCount = relation?.sourceRelationCount ?? 0;
        const evidenceDigest = relation ? hash([relation.kind, relation.evidence, relation.rawRelationIds,
          relation.sourceRelationCount, graph.evidenceFingerprint]) : hash([node?.identityKey, graph.evidenceFingerprint]);
        this.db.prepare(`
          INSERT INTO source_structure_bindings (
            project_id, binding_id, schema_version, entity_type, identity_key, source_id, source_type,
            from_binding_id, to_binding_id, relation_kind, evidence_count, evidence_digest,
            raw_relation_ids_json, indexed_at, snapshot_id, selection_fingerprint,
            graph_evidence_fingerprint, investigation_node_id, investigation_item_id,
            investigation_item_link_id, baseline_json, sync_state, last_actor_id,
            last_actor_provider, first_synced_at, last_synced_at, revision
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id, binding_id) DO UPDATE SET
            source_id=excluded.source_id, evidence_count=excluded.evidence_count,
            evidence_digest=excluded.evidence_digest, raw_relation_ids_json=excluded.raw_relation_ids_json,
            indexed_at=excluded.indexed_at, snapshot_id=excluded.snapshot_id,
            selection_fingerprint=excluded.selection_fingerprint,
            graph_evidence_fingerprint=excluded.graph_evidence_fingerprint,
            sync_state=excluded.sync_state, last_actor_id=excluded.last_actor_id,
            last_actor_provider=excluded.last_actor_provider, last_synced_at=excluded.last_synced_at,
            revision=excluded.revision
        `).run(graph.projectId, write.bindingId, type, identityKey,
          node?.sourceId ?? relation!.sourceId, node?.sourceType ?? "source_relation",
          relation?.from ?? null, relation?.to ?? null, relation?.kind ?? null,
          evidenceCount, evidenceDigest, JSON.stringify(relation?.rawRelationIds ?? []),
          graph.sourceIndexedAt, graph.snapshotId, graph.selectionFingerprint, graph.evidenceFingerprint,
          target.investigationNodeId ?? null, target.investigationItemId ?? null,
          target.investigationItemLinkId ?? null, JSON.stringify(liveBaseline),
          state, actor.id, actor.provider, prior?.firstSyncedAt ?? request.recordedAt,
          request.recordedAt, (prior?.revision ?? 0) + 1);
        updated.push(this.getBinding(graph.projectId, write.bindingId)!);
      }
      const result: SourceStructureRecordResult = {
        selection: this.getSelection(graph.projectId, request.selectionKey)!,
        bindings: updated, replayed: false,
      };
      this.db.prepare(`
        INSERT INTO source_structure_mutation_receipts (
          request_id, project_id, actor_id, fingerprint, result_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(request.requestId, graph.projectId, actor.id,
        fingerprint, JSON.stringify(result), request.recordedAt);
      this.db.exec(nested ? "RELEASE SAVEPOINT source_structure_record" : "COMMIT");
      return result;
    } catch (error) {
      if (nested) {
        this.db.exec("ROLLBACK TO SAVEPOINT source_structure_record");
        this.db.exec("RELEASE SAVEPOINT source_structure_record");
      } else {
        this.db.exec("ROLLBACK");
      }
      throw error;
    }
  }
}
