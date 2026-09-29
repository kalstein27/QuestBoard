import { createHash, randomUUID } from "node:crypto";
import type { ActorRef } from "../core/domain.js";
import { EntityNotFoundError, EntityRevisionConflictError } from "../core/errors.js";
import {
  CODE_RELATION_KINDS,
  type CodeGraphSnapshot,
  type CodeRelation,
  type CodeRelationKind,
} from "./code-intelligence.js";
import type { CodeMapService } from "./code-map-service.js";
import type { MutationRequest, QuestBoardRepository } from "./quest-board-repository.js";

export const CODE_MAP_MANUAL_RELATION_STATES = ["active", "stale"] as const;
export type CodeMapManualRelationState = (typeof CODE_MAP_MANUAL_RELATION_STATES)[number];

export interface CodeMapManualRelation {
  id: string;
  projectId: string;
  fromCodeNodeId: string;
  fromCanonicalIdentity: string;
  toCodeNodeId: string;
  toCanonicalIdentity: string;
  relationKind: CodeRelationKind;
  label: string;
  rationale: string;
  provenance: "manual";
  createdBy: string;
  createdByProvider: string;
  createdAt: string;
  updatedBy: string;
  updatedByProvider: string;
  updatedAt: string;
  revision: number;
}

export interface CodeMapManualRelationView extends CodeMapManualRelation {
  state: CodeMapManualRelationState;
  staleReason?: "from_missing" | "to_missing" | "from_identity_changed" | "to_identity_changed";
}

export interface CodeMapManualRelationReader {
  listCodeMapManualRelations(projectId: string): CodeMapManualRelation[];
}

export interface CreateCodeMapManualRelationInput {
  projectId: string;
  fromCodeNodeId: string;
  toCodeNodeId: string;
  relationKind: CodeRelationKind;
  label?: string;
  rationale?: string;
}

export interface UpdateCodeMapManualRelationInput {
  expectedRevision?: number;
  fromCodeNodeId?: string;
  toCodeNodeId?: string;
  relationKind?: CodeRelationKind;
  label?: string;
  rationale?: string;
}

export interface CodeMapAugmentationMutationOptions {
  requestId?: string;
  expectedRevision?: number;
}

export class CodeMapAugmentationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CodeMapAugmentationError";
  }
}

function relationState(
  relation: CodeMapManualRelation,
  graph: CodeGraphSnapshot,
): Pick<CodeMapManualRelationView, "state" | "staleReason"> {
  const from = graph.nodes.find((node) => node.id === relation.fromCodeNodeId);
  if (!from) return { state: "stale", staleReason: "from_missing" };
  if (from.canonicalIdentity !== relation.fromCanonicalIdentity) {
    return { state: "stale", staleReason: "from_identity_changed" };
  }
  const to = graph.nodes.find((node) => node.id === relation.toCodeNodeId);
  if (!to) return { state: "stale", staleReason: "to_missing" };
  if (to.canonicalIdentity !== relation.toCanonicalIdentity) {
    return { state: "stale", staleReason: "to_identity_changed" };
  }
  return { state: "active" };
}

export function projectCodeMapManualRelations(
  graph: CodeGraphSnapshot,
  relations: readonly CodeMapManualRelation[],
): CodeMapManualRelationView[] {
  return relations.map((relation) => ({ ...relation, ...relationState(relation, graph) }));
}

export function augmentCodeGraphWithManualRelations(
  graph: CodeGraphSnapshot,
  relations: readonly CodeMapManualRelation[],
): CodeGraphSnapshot {
  const active = projectCodeMapManualRelations(graph, relations).filter((relation) => relation.state === "active");
  if (active.length === 0) return graph;
  const manualEdges: CodeRelation[] = active.map((relation) => ({
    id: `manual:${relation.id}`,
    from: relation.fromCodeNodeId,
    to: relation.toCodeNodeId,
    kind: relation.relationKind,
    confidence: 1,
    provenance: [{ providerId: "manual", freshness: "fresh" }],
  }));
  return { ...graph, relations: [...graph.relations, ...manualEdges] };
}

function requireRelationKind(value: string): CodeRelationKind {
  if (!CODE_RELATION_KINDS.includes(value as CodeRelationKind)) {
    throw new TypeError(`Unsupported Code Map relation kind: ${value}`);
  }
  return value as CodeRelationKind;
}

function optionalText(value: string | undefined): string {
  return value?.trim() ?? "";
}

function normalizeRequestId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length < 8 || normalized.length > 128) {
    throw new TypeError("requestId must be between 8 and 128 characters");
  }
  return normalized;
}

function fingerprint(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export class CodeMapAugmentationService {
  constructor(
    private readonly codeMap: CodeMapService,
    private readonly repository: QuestBoardRepository,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly newId: () => string = randomUUID,
  ) {}

  list(projectId: string): CodeMapManualRelationView[] {
    if (!this.repository.getProject(projectId)) throw new EntityNotFoundError("Project", projectId);
    const snapshot = this.codeMap.getCached(projectId);
    if (!snapshot) {
      throw new CodeMapAugmentationError("code_map_not_indexed", `Code Map has not been indexed for project ${projectId}`);
    }
    return projectCodeMapManualRelations(snapshot.graph, this.repository.listCodeMapManualRelations(projectId));
  }

  create(
    input: CreateCodeMapManualRelationInput,
    actor: ActorRef,
    options: CodeMapAugmentationMutationOptions = {},
  ): CodeMapManualRelationView {
    return this.runMutation("code-map.manual-relation.create", actor, options.requestId, input, () => {
      if (!this.repository.getProject(input.projectId)) throw new EntityNotFoundError("Project", input.projectId);
      const snapshot = this.requireSnapshot(input.projectId);
      const from = this.requireNode(snapshot.graph, input.fromCodeNodeId);
      const to = this.requireNode(snapshot.graph, input.toCodeNodeId);
      if (from.id === to.id) throw new TypeError("Manual Code Map relation endpoints must be different nodes");
      const timestamp = this.now();
      const relation: CodeMapManualRelation = {
        id: this.newId(),
        projectId: input.projectId,
        fromCodeNodeId: from.id,
        fromCanonicalIdentity: from.canonicalIdentity,
        toCodeNodeId: to.id,
        toCanonicalIdentity: to.canonicalIdentity,
        relationKind: requireRelationKind(input.relationKind),
        label: optionalText(input.label),
        rationale: optionalText(input.rationale),
        provenance: "manual",
        createdBy: actor.id,
        createdByProvider: actor.provider,
        createdAt: timestamp,
        updatedBy: actor.id,
        updatedByProvider: actor.provider,
        updatedAt: timestamp,
        revision: 1,
      };
      const created = this.repository.createCodeMapManualRelation(relation);
      return { ...created, ...relationState(created, snapshot.graph) };
    });
  }

  update(
    relationId: string,
    patch: UpdateCodeMapManualRelationInput,
    actor: ActorRef,
    options: CodeMapAugmentationMutationOptions = {},
  ): CodeMapManualRelationView {
    return this.runMutation("code-map.manual-relation.update", actor, options.requestId, { relationId, patch }, () => {
      const current = this.repository.getCodeMapManualRelation(relationId);
      if (!current) throw new EntityNotFoundError("Code Map manual relation", relationId);
      const snapshot = this.requireSnapshot(current.projectId);
      const from = patch.fromCodeNodeId !== undefined
        ? this.requireNode(snapshot.graph, patch.fromCodeNodeId)
        : this.requireStoredNode(snapshot.graph, current.fromCodeNodeId, current.fromCanonicalIdentity);
      const to = patch.toCodeNodeId !== undefined
        ? this.requireNode(snapshot.graph, patch.toCodeNodeId)
        : this.requireStoredNode(snapshot.graph, current.toCodeNodeId, current.toCanonicalIdentity);
      if (from.id === to.id) throw new TypeError("Manual Code Map relation endpoints must be different nodes");
      const expectedRevision = patch.expectedRevision ?? current.revision;
      const updated: CodeMapManualRelation = {
        ...current,
        fromCodeNodeId: from.id,
        fromCanonicalIdentity: from.canonicalIdentity,
        toCodeNodeId: to.id,
        toCanonicalIdentity: to.canonicalIdentity,
        relationKind: patch.relationKind !== undefined ? requireRelationKind(patch.relationKind) : current.relationKind,
        label: patch.label !== undefined ? optionalText(patch.label) : current.label,
        rationale: patch.rationale !== undefined ? optionalText(patch.rationale) : current.rationale,
        updatedBy: actor.id,
        updatedByProvider: actor.provider,
        updatedAt: this.now(),
        revision: current.revision + 1,
      };
      const saved = this.repository.updateCodeMapManualRelation(updated, expectedRevision);
      return { ...saved, ...relationState(saved, snapshot.graph) };
    });
  }

  delete(
    relationId: string,
    actor: ActorRef,
    options: CodeMapAugmentationMutationOptions = {},
  ): { deleted: true; relationId: string } {
    return this.runMutation("code-map.manual-relation.delete", actor, options.requestId, {
      relationId,
      expectedRevision: options.expectedRevision,
    }, () => {
      const current = this.repository.getCodeMapManualRelation(relationId);
      if (!current) throw new EntityNotFoundError("Code Map manual relation", relationId);
      this.repository.deleteCodeMapManualRelation(relationId, options.expectedRevision ?? current.revision);
      return { deleted: true as const, relationId };
    });
  }

  private requireSnapshot(projectId: string) {
    const snapshot = this.codeMap.getCached(projectId);
    if (!snapshot) {
      throw new CodeMapAugmentationError("code_map_not_indexed", `Code Map has not been indexed for project ${projectId}`);
    }
    return snapshot;
  }

  private requireNode(graph: CodeGraphSnapshot, nodeId: string) {
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new CodeMapAugmentationError("code_map_node_not_found", `Unknown Code Map node ${nodeId}`);
    return node;
  }

  private requireStoredNode(graph: CodeGraphSnapshot, nodeId: string, canonicalIdentity: string) {
    const node = this.requireNode(graph, nodeId);
    if (node.canonicalIdentity !== canonicalIdentity) {
      throw new CodeMapAugmentationError(
        "code_map_manual_relation_stale",
        `Manual Code Map endpoint ${nodeId} no longer has its stored canonical identity`,
      );
    }
    return node;
  }

  private runMutation<T>(
    operation: string,
    actor: ActorRef,
    requestIdValue: string | undefined,
    input: unknown,
    execute: () => T,
  ): T {
    const requestId = normalizeRequestId(requestIdValue);
    const request: MutationRequest | undefined = requestId
      ? {
          requestId,
          operation,
          actorId: actor.id,
          fingerprint: fingerprint({ operation, actor: { id: actor.id, provider: actor.provider }, input }),
          createdAt: this.now(),
        }
      : undefined;
    return this.repository.runIdempotentMutation(request, execute).value;
  }
}

export function assertCodeMapManualRelationRevision(
  relation: CodeMapManualRelation,
  expectedRevision: number,
): void {
  if (relation.revision !== expectedRevision) {
    throw new EntityRevisionConflictError(
      "Code Map manual relation",
      relation.id,
      expectedRevision,
      relation.revision,
    );
  }
}
