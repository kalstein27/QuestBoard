// Phase 7 A4 read-only live acceptance probe.
// Reads the existing persisted ChatGPT2Codex Code Map snapshot and applies the
// current local A2/A3 projection/subsystem readers. It never refreshes, saves,
// opens QuestBoard SQLite, or mutates the indexed repository.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertValidCodeGraphSnapshot,
  createCodeSourceSubsystemRead,
  projectCodeArchitecture,
  type CodeGraphSnapshot,
} from "../index.js";

const projectId = process.env.QUESTBOARD_PHASE7_PROJECT_ID?.trim();
assert.ok(projectId, "QUESTBOARD_PHASE7_PROJECT_ID is required for the Phase 7 live acceptance probe");
const storageRoot = resolve(
  process.env.QUESTBOARD_CODE_MAP_STORAGE_ROOT?.trim()
    || join(homedir(), ".local", "share", "questboard", "code-map"),
);
const digest = createHash("sha256").update(projectId).digest("hex");
const snapshotPath = join(storageRoot, "snapshots", digest, "snapshot.json");
assert.ok(existsSync(snapshotPath), `Persisted snapshot not found: ${snapshotPath}`);

const envelope = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
  projectId?: string;
  persistedAt?: string;
  sourceManifestFingerprint?: string;
  graph?: CodeGraphSnapshot;
};
assert.equal(envelope.projectId, projectId);
assert.ok(envelope.graph, "Persisted snapshot graph is missing");
const graph = envelope.graph;
assertValidCodeGraphSnapshot(graph);
assert.equal(graph.projectId, projectId);

const projection = projectCodeArchitecture(graph);
const subsystems = createCodeSourceSubsystemRead(graph, projection);

const handler = graph.nodes.find((node) =>
  node.canonicalIdentity.startsWith(
    "source-registration:src/server/tools.ts:registerTool:managed_mcp_update:",
  ));
assert.ok(handler, "managed_mcp_update registration handler is missing");
const withErrorMapping = graph.nodes.find((node) =>
  node.name === "withErrorMapping" && node.location?.path === "src/server/tools.ts");
assert.ok(withErrorMapping, "withErrorMapping raw node is missing");
const handlerDirect = graph.relations.find((relation) =>
  relation.kind === "calls"
    && relation.from === handler.id
    && relation.to === withErrorMapping.id);
assert.ok(handlerDirect, "managed_mcp_update -> withErrorMapping direct raw call is missing");

const registerTools = graph.nodes.find((node) =>
  node.kind === "function"
    && node.name === "registerTools"
    && node.location?.path === "src/server/tools.ts");
assert.ok(registerTools, "registerTools raw node is missing");
const updateManagedMcp = graph.nodes.find((node) =>
  node.kind === "function"
    && node.name === "updateManagedMcp"
    && node.location?.path === "src/mcp/managed-mcp.ts");
assert.ok(updateManagedMcp, "updateManagedMcp raw node is missing");
const outerDownstream = graph.relations.find((relation) =>
  relation.kind === "calls"
    && relation.from === registerTools.id
    && relation.to === updateManagedMcp.id);
assert.ok(outerDownstream, "registerTools -> updateManagedMcp raw call is missing");

const serverSubsystem = subsystems.nodes.find((node) => node.pathPrefix === "src/server");
const mcpSubsystem = subsystems.nodes.find((node) => node.pathPrefix === "src/mcp");
assert.ok(serverSubsystem, "src/server subsystem is missing");
assert.ok(mcpSubsystem, "src/mcp subsystem is missing");
const handlerNotable = serverSubsystem.notableNodes.find((node) => node.rawNodeId === handler.id);
const operationStatusHandler = graph.nodes.find((node) =>
  node.canonicalIdentity.startsWith(
    "source-registration:src/server/tools.ts:registerTool:operation_status:",
  ));
assert.ok(operationStatusHandler, "operation_status registration handler is missing");
const operationStatusNotable = serverSubsystem.notableNodes.find(
  (node) => node.rawNodeId === operationStatusHandler.id,
);
if (handlerNotable) {
  assert.equal(handlerNotable.registrationContext, true);
  assert.ok(handlerNotable.directSourceRelationIds.includes(handlerDirect.id));
}

const serverToMcp = subsystems.relations.find((relation) =>
  relation.kind === "calls"
    && relation.fromPathPrefix === "src/server"
    && relation.toPathPrefix === "src/mcp");
assert.ok(serverToMcp, "src/server -> src/mcp aggregate is missing");

const falseHandlerTransitive = subsystems.relations.flatMap((relation) => relation.evidenceSample)
  .filter((entry) => entry.fromNodeId === handler.id && entry.toNodeId === updateManagedMcp.id);
assert.equal(
  falseHandlerTransitive.length,
  0,
  "managed_mcp_update must not be rewritten as the raw owner of updateManagedMcp",
);

const rawById = new Map(graph.relations.map((relation) => [relation.id, relation] as const));
for (const relation of subsystems.relations) {
  for (const relationId of relation.sourceRelationIds) {
    assert.ok(rawById.has(relationId), `Missing raw trace relation ${relationId}`);
  }
  assert.equal(relation.sourceRelationIds.length, relation.evidenceSample.length);
  assert.equal(
    relation.evidenceTruncated,
    relation.sourceRelationCount > relation.sourceRelationIds.length,
  );
}

console.log(JSON.stringify({
  mode: "persisted_snapshot_read_only",
  projectId,
  storageRoot,
  snapshotPath,
  persistedAt: envelope.persistedAt ?? null,
  sourceManifestFingerprint: envelope.sourceManifestFingerprint ?? null,
  indexedAt: graph.indexedAt,
  raw: {
    nodeCount: graph.nodes.length,
    relationCount: graph.relations.length,
  },
  compatibility: {
    groupCount: projection.nodes.length,
    relationCount: projection.relations.length,
    nodeIds: projection.nodes.map((node) => ({ id: node.id, kind: node.kind })),
    relationIds: projection.relations.map((relation) => ({
      id: relation.id,
      from: relation.from,
      to: relation.to,
      kind: relation.kind,
    })),
  },
  subsystemRead: {
    nodeCount: subsystems.nodes.length,
    relationCount: subsystems.relations.length,
    truncated: subsystems.truncated,
    truncation: subsystems.truncation,
    caps: subsystems.caps,
    quality: subsystems.quality,
    nodes: subsystems.nodes.map((node) => ({
      id: node.id,
      pathPrefix: node.pathPrefix,
      classification: node.classification,
      fileCount: node.fileCount,
      symbolCount: node.symbolCount,
      incomingCalls: node.incomingCrossBoundaryCallCount,
      outgoingCalls: node.outgoingCrossBoundaryCallCount,
      notableNodeCount: node.notableNodeCount,
      registrationEntrypointCount: node.registrationEntrypointCount,
      flowRoleHint: node.flowRoleHint ?? null,
    })),
    relations: subsystems.relations.map((relation) => ({
      id: relation.id,
      from: relation.fromPathPrefix,
      to: relation.toPathPrefix,
      kind: relation.kind,
      sourceRelationCount: relation.sourceRelationCount,
      sourceRelationIds: relation.sourceRelationIds,
      evidenceSampleCount: relation.evidenceSample.length,
      evidenceTruncated: relation.evidenceTruncated,
      evidenceTruncationReason: relation.evidenceTruncationReason ?? null,
    })),
  },
  handlerTrace: {
    registrationHandler: {
      nodeId: handler.id,
      canonicalIdentity: handler.canonicalIdentity,
      source: handler.location,
      boundedNotable: Boolean(handlerNotable),
      directRelationId: handlerDirect.id,
      directTargetNodeId: withErrorMapping.id,
      directTargetName: withErrorMapping.name,
      directEvidence: handlerDirect.evidence ?? [],
      directProvenance: handlerDirect.provenance ?? [],
    },
    rawDownstreamOwner: {
      nodeId: registerTools.id,
      name: registerTools.name,
      relationId: outerDownstream.id,
      targetNodeId: updateManagedMcp.id,
      targetName: updateManagedMcp.name,
      targetSource: updateManagedMcp.location,
      provenance: outerDownstream.provenance ?? [],
    },
    subsystem: {
      fromSubsystemId: serverSubsystem.id,
      toSubsystemId: mcpSubsystem.id,
      aggregateRelationId: serverToMcp.id,
      aggregateSourceRelationCount: serverToMcp.sourceRelationCount,
      aggregateContainsRawRelation: serverToMcp.sourceRelationIds.includes(outerDownstream.id),
    },
    boundedPhase6HandlerExposure: {
      managedMcpUpdate: Boolean(handlerNotable),
      operationStatus: Boolean(operationStatusNotable),
      exposedCount: Number(Boolean(handlerNotable)) + Number(Boolean(operationStatusNotable)),
      notableRegistrationHandlers: serverSubsystem.notableNodes
        .filter((node) => node.registrationContext)
        .map((node) => ({ name: node.name, rawNodeId: node.rawNodeId })),
    },
    falseHandlerTransitiveEdgeCount: falseHandlerTransitive.length,
  },
}, null, 2));
