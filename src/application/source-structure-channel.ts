import type { ActorRef } from "../core/domain.js";
import type { CodeMapService } from "./code-map-service.js";
import type { SourceStructureSelection } from "./source-structure-sync-graph.js";
import type { CodeSourceSubsystemQueryInput, CodeSourceSubsystemQueryResult } from "./code-map-subsystem-read.js";

export class SourceStructureChannelError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SourceStructureChannelError";
  }
}

/** This authority comes only from the hosting transport, never from arguments/headers alone. */
export type SourceStructureApplyAuthority = (
  projectId: string,
  claimedActor: ActorRef,
) => ActorRef | undefined;

const denied = (code: string, message: string): never => {
  throw new SourceStructureChannelError(code, message);
};
const MAX_CHANNEL_BODY_BYTES = 24_576;
const MAX_ID_BYTES = 512;
const MAX_OFFSET = 1_000_000;
const PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_./-]*$/;

export interface SourceStructureChannelSelection {
  projectId: string;
  selectionKey: string;
  pathPrefixFilter?: string;
  offset: number;
  limit: number;
  selectedSubsystemIds: string[];
  selectedRawAnchorIds?: string[];
  selectedRelationIds?: string[];
  expectedSourceIndexedAt: string;
  expectedSnapshotId: string;
}

export function sourceStructureObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return denied("source_structure_bad_request", "Source Structure input must be an object");
  }
  // Bound nested page/ID payloads even for direct MCP/tool calls bypassing HTTP body caps.
  let size: number;
  try { size = Buffer.byteLength(JSON.stringify(input)); }
  catch { return denied("source_structure_bad_request", "Invalid Source Structure input"); }
  if (size > MAX_CHANNEL_BODY_BYTES) {
    return denied("source_structure_request_too_large", "Source Structure selection exceeds the bounded request size");
  }
  return input as Record<string, unknown>;
}

function text(value: unknown, key: string, max = 256): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max ||
    /[\r\n\0]/.test(value)) {
    return denied("source_structure_bad_request", key + " must be bounded nonempty text");
  }
  return value;
}
function id(value: unknown, key: string): string {
  const v = text(value, key, MAX_ID_BYTES);
  if (!PATTERN.test(v)) return denied("source_structure_bad_request", key + " has an invalid identifier");
  return v;
}
function list(value: unknown, key: string, cap: number, prefixes: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length > cap) {
    return denied("source_structure_selection_cap", key + " exceeds the selection cap");
  }
  const ids = value.map((part) => id(part, key));
  if (new Set(ids).size !== ids.length ||
    ids.some((part) => !prefixes.some((prefix) => part.startsWith(prefix)))) {
    return denied("source_structure_bad_request", key + " has duplicate or unsupported identities");
  }
  return ids;
}
function nonnegativeInt(value: unknown, key: string, cap: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > cap) {
    return denied("source_structure_bad_request", key + " is outside its bounded range");
  }
  return value;
}
function selectionKey(input: Record<string, unknown>): string {
  return id(input.selectionKey, "selectionKey");
}
function project(input: Record<string, unknown>): string {
  return id(input.projectId, "projectId");
}

/** Returns metadata only. No raw source file contents, absolute paths or provider dumps. */
function sourceStructureCandidateQuery(raw: unknown): { projectId: string; query: CodeSourceSubsystemQueryInput } {
  const args = sourceStructureObject(raw);
  const projectId = project(args);
  const offset = nonnegativeInt(args.offset ?? 0, "offset", MAX_OFFSET);
  const limit = nonnegativeInt(args.limit ?? 12, "limit", 12);
  if (!limit) return denied("source_structure_bad_request", "limit must be between 1 and 12");
  const pathPrefix = args.pathPrefix === undefined ? undefined : text(args.pathPrefix, "pathPrefix", 256);
  if (pathPrefix && (pathPrefix.startsWith("/") || pathPrefix.includes("\\") ||
    pathPrefix.split("/").includes(".."))) {
    return denied("source_structure_bad_request", "Only relative project-local path prefixes are accepted");
  }
  const expectedSnapshotId = args.expectedSnapshotId === undefined ? undefined
    : text(args.expectedSnapshotId, "expectedSnapshotId", 256);
  const expectedSourceIndexedAt = args.expectedSourceIndexedAt === undefined ? undefined
    : text(args.expectedSourceIndexedAt, "expectedSourceIndexedAt", 128);
  return { projectId, query: {
    operation: "list_subsystems", offset, limit,
    ...(pathPrefix ? { pathPrefix } : {}),
    ...(expectedSnapshotId ? { expectedSnapshotId } : {}),
    ...(expectedSourceIndexedAt ? { expectedSourceIndexedAt } : {}),
  } };
}

function formatSourceStructureCandidates(projectId: string, result: CodeSourceSubsystemQueryResult) {
  if (result.operation !== "list_subsystems") {
    return denied("source_structure_bad_request", "Expected source subsystem page");
  }
  return {
    projectId, snapshotId: result.snapshotId ?? null, sourceIndexedAt: result.sourceIndexedAt,
    operation: result.operation, offset: result.offset, limit: result.limit,
    candidateCount: result.candidateCount, returnedCount: result.returnedCount,
    hasMore: result.hasMore, truncated: result.truncated,
    ...(result.nextOffset !== undefined ? { nextOffset: result.nextOffset } : {}),
    nodes: result.nodes.map((node) => ({
      id: node.id, pathPrefix: node.pathPrefix, classification: node.classification,
      fileCount: node.fileCount, symbolCount: node.symbolCount,
      incomingCrossBoundaryCallCount: node.incomingCrossBoundaryCallCount,
      outgoingCrossBoundaryCallCount: node.outgoingCrossBoundaryCallCount,
    })),
    limits: { nodes: 12, relations: 24, evidence: 16 },
    notFullGraphSync: true as const,
  };
}

export function listSourceStructureCandidates(codeMap: CodeMapService, raw: unknown) {
  const { projectId, query } = sourceStructureCandidateQuery(raw);
  return formatSourceStructureCandidates(projectId, codeMap.querySourceSubsystems(projectId, query));
}

/** Read-only candidate listing never hydrates the daemon when P2 is enabled. */
export async function listSourceStructureCandidatesAsync(codeMap: CodeMapService, raw: unknown, signal?: AbortSignal) {
  const { projectId, query } = sourceStructureCandidateQuery(raw);
  return formatSourceStructureCandidates(projectId, await codeMap.querySourceSubsystemsAsync(projectId, query, signal));
}

/** S5 does not accept a client-crafted subsystemPage, source graph or binding. */
export function sourceStructureChannelSelection(raw: unknown): SourceStructureChannelSelection {
  const args = sourceStructureObject(raw);
  const selectedSubsystemIds = list(args.selectedSubsystemIds, "selectedSubsystemIds", 12,
    ["code-subsystem:node:"]);
  if (!selectedSubsystemIds.length) {
    return denied("source_structure_bad_request", "At least one explicit subsystem is required");
  }
  const selectedRawAnchorIds = args.selectedRawAnchorIds === undefined ? undefined
    : list(args.selectedRawAnchorIds, "selectedRawAnchorIds", 12, ["code:node:"]);
  if (selectedSubsystemIds.length + (selectedRawAnchorIds?.length ?? 0) > 12) {
    return denied("source_structure_selection_cap", "Source Structure selection exceeds 12 nodes");
  }
  const selectedRelationIds = args.selectedRelationIds === undefined ? undefined
    : list(args.selectedRelationIds, "selectedRelationIds", 24,
      ["code-subsystem:relation:", "source-structure-sync:raw-relation:v1:"]);
  const offset = nonnegativeInt(args.offset ?? 0, "offset", MAX_OFFSET);
  const limit = nonnegativeInt(args.limit ?? 12, "limit", 12);
  if (!limit) return denied("source_structure_bad_request", "limit must be between 1 and 12");
  const pathPrefixFilter = args.pathPrefix === undefined ? undefined : text(args.pathPrefix, "pathPrefix", 256);
  if (pathPrefixFilter && (pathPrefixFilter.startsWith("/") || pathPrefixFilter.includes("\\") ||
    pathPrefixFilter.split("/").includes(".."))) {
    return denied("source_structure_bad_request", "Only relative project-local path prefixes are accepted");
  }
  // Disallow clients substituting a derived graph/page for the freshly fetched server page.
  if ("subsystemPage" in args || "graph" in args || "sourceGraph" in args) {
    return denied("source_structure_bad_request", "Client-supplied source graphs or pages are not accepted");
  }
  return {
    projectId: project(args), selectionKey: selectionKey(args), offset, limit,
    selectedSubsystemIds,
    ...(pathPrefixFilter ? { pathPrefixFilter } : {}),
    ...(selectedRawAnchorIds ? { selectedRawAnchorIds } : {}),
    ...(selectedRelationIds ? { selectedRelationIds } : {}),
    expectedSnapshotId: text(args.expectedSnapshotId, "expectedSnapshotId", 256),
    expectedSourceIndexedAt: text(args.expectedSourceIndexedAt, "expectedSourceIndexedAt", 128),
  };
}
export function resolveSourceStructureSelection(
  codeMap: CodeMapService,
  input: SourceStructureChannelSelection,
): SourceStructureSelection {
  const page = codeMap.querySourceSubsystems(input.projectId, {
    operation: "list_subsystems", offset: input.offset, limit: input.limit,
    expectedSourceIndexedAt: input.expectedSourceIndexedAt,
    expectedSnapshotId: input.expectedSnapshotId,
    ...(input.pathPrefixFilter ? { pathPrefix: input.pathPrefixFilter } : {}),
  });
  if (page.operation !== "list_subsystems") {
    return denied("source_structure_bad_request", "Expected exact pinned subsystem page");
  }
  return {
    subsystemPage: page,
    ...(input.pathPrefixFilter ? { pathPrefixFilter: input.pathPrefixFilter } : {}),
    selectedSubsystemIds: input.selectedSubsystemIds,
    ...(input.selectedRawAnchorIds ? { selectedRawAnchorIds: input.selectedRawAnchorIds } : {}),
    ...(input.selectedRelationIds ? { selectedRelationIds: input.selectedRelationIds } : {}),
    expectedSnapshotId: input.expectedSnapshotId,
    expectedSourceIndexedAt: input.expectedSourceIndexedAt,
  };
}
export function sourceStructureApplyActor(
  authority: SourceStructureApplyAuthority | undefined,
  projectId: string,
  actor: ActorRef,
): ActorRef {
  const trusted = authority?.(projectId, actor);
  if (!trusted || trusted.id !== actor.id || trusted.provider !== actor.provider) {
    return denied("source_structure_apply_unauthorized",
      "Source Structure apply requires transport-verified identity and project permission");
  }
  return trusted;
}
export function sourceStructureApplyRequestFields(raw: unknown): {
  approved: true; requestId: string; expectedSelectionFingerprint: string;
  expectedSelectionRevision: number | null;
} {
  const args = sourceStructureObject(raw);
  if (args.approved !== true) {
    return denied("source_structure_approval_required", "Explicit approved:true is required");
  }
  const expectedSelectionFingerprint = text(
    args.expectedSelectionFingerprint, "expectedSelectionFingerprint", 128);
  if (!/^[a-f0-9]{64}$/.test(expectedSelectionFingerprint)) {
    return denied("source_structure_bad_request", "Expected selection fingerprint must be SHA-256");
  }
  const requestId = id(args.requestId, "requestId");
  if (requestId.length < 8 || requestId.length > 128) {
    return denied("source_structure_bad_request", "Request id length must be 8..128");
  }
  const revision = args.expectedSelectionRevision;
  if (revision !== null && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1)) {
    return denied("source_structure_bad_request", "expectedSelectionRevision must be null or positive integer");
  }
  return { approved: true, requestId, expectedSelectionFingerprint,
    expectedSelectionRevision: revision as number | null };
}
