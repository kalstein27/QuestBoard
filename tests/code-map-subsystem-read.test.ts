import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_GRAPH_SCHEMA_VERSION,
  createCodeSourceSubsystemRead,
  projectCodeArchitecture,
  type CodeGraphSnapshot,
  type CodeMapProviderCapabilityReport,
  type CodeNode,
  type CodeRelation,
} from "../src/index.js";

function node(
  id: string,
  name: string,
  path: string,
  startLine: number,
  canonicalIdentity = `scip:${path}#${name}`,
): CodeNode {
  return {
    id,
    kind: "function",
    name,
    canonicalIdentity,
    language: "typescript",
    location: { path, startLine },
  };
}

function call(
  id: string,
  from: string,
  to: string,
  path: string,
  line: number,
): CodeRelation {
  return {
    id,
    from,
    to,
    kind: "calls",
    confidence: 1,
    evidence: [{
      location: { path, startLine: line, startColumn: 2, endLine: line, endColumn: 20 },
      label: "SCIP-resolved direct call",
    }],
    provenance: [{
      providerId: "scip-typescript",
      fidelity: "semantic-call",
      freshness: "fresh",
    }],
  };
}

function evidenceGraph(): CodeGraphSnapshot {
  const nodes: CodeNode[] = [
    node(
      "code:node:handler-managed",
      "managed_mcp_update",
      "src/server/tools.ts",
      11304,
      "source-registration:src/server/tools.ts:registerTool:managed_mcp_update:11304",
    ),
    node("code:node:with-error", "withErrorMapping", "src/server/tools.ts", 4200),
    node("code:node:register-tools", "registerTools", "src/server/tools.ts", 4545),
    node("code:node:managed-update", "updateManagedMcp", "src/mcp/managed-mcp.ts", 811),
    node("code:node:http", "createHttpServer", "src/server/http.ts", 354),
    node("code:node:runtime", "recordRuntime", "src/runtime/connection-diagnostics.ts", 155),
    node("code:node:cli", "main", "src/cli.ts", 20),
    {
      id: "code:node:external",
      kind: "class",
      name: "Promise",
      canonicalIdentity: "scip-external:typescript:Promise",
      language: "typescript",
    },
  ];
  const relations: CodeRelation[] = [
    call(
      "code:relation:handler-with-error",
      "code:node:handler-managed",
      "code:node:with-error",
      "src/server/tools.ts",
      11319,
    ),
    call(
      "code:relation:outer-managed",
      "code:node:register-tools",
      "code:node:managed-update",
      "src/server/tools.ts",
      11327,
    ),
    call(
      "code:relation:http-runtime",
      "code:node:http",
      "code:node:runtime",
      "src/server/http.ts",
      421,
    ),
    call(
      "code:relation:cli-http",
      "code:node:cli",
      "code:node:http",
      "src/cli.ts",
      88,
    ),
    {
      id: "code:relation:broad-dependency",
      from: "code:node:handler-managed",
      to: "code:node:managed-update",
      kind: "depends_on",
      confidence: 1,
    },
    {
      id: "code:relation:external-call",
      from: "code:node:http",
      to: "code:node:external",
      kind: "calls",
      confidence: 1,
    },
  ];
  return {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId: "phase7-a3-read",
    rootPath: "/workspace/phase7-a3-read",
    indexedAt: "2026-10-07T07:29:17.346Z",
    nodes,
    relations,
  };
}

function providerCapabilities(): CodeMapProviderCapabilityReport {
  return {
    providers: [],
    languages: [
      {
        language: "python",
        discoveredFileCount: 3,
        eligibleFileCount: null,
        indexedFileCount: 0,
        excludedFileCount: 0,
        exclusionReason: null,
        symbolCount: 0,
        fidelity: "file-only",
        providerIds: [],
        observedRelationKinds: [],
        semanticCoverage: "unavailable",
        gapReason: "no_trusted_provider_available",
        installOptions: [],
      },
      {
        language: "typescript",
        discoveredFileCount: 4,
        eligibleFileCount: 4,
        indexedFileCount: 4,
        excludedFileCount: 0,
        exclusionReason: null,
        symbolCount: 7,
        fidelity: "semantic-call",
        providerIds: ["scip-typescript"],
        observedRelationKinds: ["calls"],
        semanticCoverage: "complete",
        gapReason: null,
        installOptions: [],
      },
    ],
    indexed: true,
    health: "healthy",
    semanticCoverage: "partial",
    degraded: false,
  };
}

test("bounded subsystem read uses distinct stable derived identities and raw notable navigation", () => {
  const graph = evidenceGraph();
  const projection = projectCodeArchitecture(graph);
  const first = createCodeSourceSubsystemRead(graph, projection, providerCapabilities());

  const reordered = evidenceGraph();
  reordered.nodes = [...reordered.nodes].reverse();
  reordered.relations = [...reordered.relations].reverse();
  const second = createCodeSourceSubsystemRead(
    reordered,
    projectCodeArchitecture(reordered),
    providerCapabilities(),
  );

  assert.deepEqual(second, first);
  assert.equal(first.identityNamespaces.rawNode, "code:node:*");
  assert.equal(first.identityNamespaces.compatibilityArchitectureNode, "code-map:node:*");
  assert.equal(first.identityNamespaces.sourceSubsystemNode, "code-subsystem:node:*");
  assert.ok(first.nodes.every((entry) => entry.id.startsWith("code-subsystem:node:")));
  assert.ok(first.relations.every((entry) => entry.id.startsWith("code-subsystem:relation:")));
  assert.ok(first.relations.every((entry) => entry.directed));

  const server = first.nodes.find((entry) => entry.pathPrefix === "src/server");
  assert.ok(server);
  const handler = server.notableNodes.find(
    (entry) => entry.rawNodeId === "code:node:handler-managed",
  );
  assert.ok(handler);
  assert.equal(handler.registrationContext, true);
  assert.equal(handler.rawRelationOwnerPreserved, true);
  assert.equal(handler.navigation.rawNodeId, "code:node:handler-managed");
  assert.equal(handler.navigation.callers.semantic, "callers");
  assert.equal(handler.navigation.callees.semantic, "callees");
  assert.deepEqual(handler.directSourceRelationIds, ["code:relation:handler-with-error"]);

  const serverToMcp = first.relations.find((entry) =>
    entry.fromPathPrefix === "src/server"
    && entry.toPathPrefix === "src/mcp"
    && entry.kind === "calls");
  assert.ok(serverToMcp);
  assert.deepEqual(serverToMcp.sourceRelationIds, ["code:relation:outer-managed"]);
  assert.equal(
    serverToMcp.evidenceSample.some(
      (entry) => entry.fromNodeId === "code:node:handler-managed",
    ),
    false,
    "registration context must not replace the actual raw registerTools owner",
  );
  assert.equal(
    first.relations.some((entry) =>
      entry.sourceRelationIds.includes("code:relation:broad-dependency")),
    false,
  );
  assert.equal(
    first.relations.some((entry) =>
      entry.sourceRelationIds.includes("code:relation:external-call")),
    false,
  );

  assert.equal(first.semantics.callsPrimary, true);
  assert.equal(first.semantics.syntheticHandlerTransitiveEdges, false);
  assert.deepEqual(first.quality.languageGaps, [{
    language: "python",
    discoveredFileCount: 3,
    eligibleFileCount: null,
    indexedFileCount: 0,
    symbolCount: 0,
    fidelity: "file-only",
    semanticCoverage: "unavailable",
    gapReason: "no_trusted_provider_available",
  }]);
  assert.equal(first.quality.rawCallCount, 5);
  assert.equal(first.quality.subsystemCallEvidenceCount, 3);
  assert.ok(first.quality.eligibleProjectLocalSymbols >= first.quality.compatibilityRepresentedSymbols);
});

test("bounded subsystem read keeps total relation count separate from evidence sample truncation", () => {
  const nodes: CodeNode[] = [];
  const relations: CodeRelation[] = [];
  for (let index = 0; index < 20; index += 1) {
    const caller = `code:node:caller-${index}`;
    const callee = `code:node:callee-${index}`;
    nodes.push(node(caller, `caller${index}`, `src/a/a-${index}.ts`, 1));
    nodes.push(node(callee, `callee${index}`, `src/b/b-${index}.ts`, 1));
    relations.push(call(
      `code:relation:edge-${String(index).padStart(2, "0")}`,
      caller,
      callee,
      `src/a/a-${index}.ts`,
      index + 1,
    ));
  }
  const graph: CodeGraphSnapshot = {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId: "phase7-a3-evidence-cap",
    rootPath: "/workspace/phase7-a3-evidence-cap",
    indexedAt: "2026-10-07T08:00:00.000Z",
    nodes,
    relations,
  };

  const read = createCodeSourceSubsystemRead(graph, projectCodeArchitecture(graph));
  const relation = read.relations.find((entry) =>
    entry.fromPathPrefix === "src/a"
    && entry.toPathPrefix === "src/b"
    && entry.kind === "calls");
  assert.ok(relation);
  assert.equal(relation.sourceRelationCount, 20);
  assert.equal(relation.sourceRelationIds.length, 16);
  assert.equal(relation.evidenceSample.length, 16);
  assert.equal(relation.evidenceTruncated, true);
  assert.equal(relation.evidenceTruncationReason, "evidence_sample_cap");
  assert.deepEqual(
    relation.sourceRelationIds,
    relation.evidenceSample.map((entry) => entry.relationId),
  );
  assert.equal(read.caps.relationEvidence, 16);
});

test("derived subsystem identities survive reindex raw-id churn while snapshot traceability stays raw", () => {
  const firstGraph = evidenceGraph();
  const first = createCodeSourceSubsystemRead(
    firstGraph,
    projectCodeArchitecture(firstGraph),
    providerCapabilities(),
  );

  const reindexed = evidenceGraph();
  const rawNodeIds = new Map(
    reindexed.nodes.map((entry, index) => [entry.id, `code:node:reindexed-${index}`] as const),
  );
  reindexed.nodes = [...reindexed.nodes].reverse().map((entry) => ({
    ...entry,
    id: rawNodeIds.get(entry.id)!,
  }));
  reindexed.relations = [...reindexed.relations].reverse().map((entry, index) => ({
    ...entry,
    id: `code:relation:reindexed-${index}`,
    from: rawNodeIds.get(entry.from)!,
    to: rawNodeIds.get(entry.to)!,
  }));
  reindexed.indexedAt = "2026-10-07T09:00:00.000Z";

  const second = createCodeSourceSubsystemRead(
    reindexed,
    projectCodeArchitecture(reindexed),
    providerCapabilities(),
  );

  assert.notEqual(second.sourceIndexedAt, first.sourceIndexedAt);
  assert.deepEqual(
    second.nodes.map((entry) => [entry.id, entry.pathPrefix, entry.classification]),
    first.nodes.map((entry) => [entry.id, entry.pathPrefix, entry.classification]),
  );
  assert.deepEqual(
    second.relations.map((entry) => [
      entry.id,
      entry.fromSubsystemId,
      entry.toSubsystemId,
      entry.fromPathPrefix,
      entry.toPathPrefix,
      entry.kind,
    ]),
    first.relations.map((entry) => [
      entry.id,
      entry.fromSubsystemId,
      entry.toSubsystemId,
      entry.fromPathPrefix,
      entry.toPathPrefix,
      entry.kind,
    ]),
  );

  const secondRawRelationIds = new Set(reindexed.relations.map((entry) => entry.id));
  assert.ok(second.relations.every((entry) =>
    entry.sourceRelationIds.every((relationId) => secondRawRelationIds.has(relationId))));
  assert.ok(second.relations.every((entry) =>
    entry.evidenceSample.every((sample) => secondRawRelationIds.has(sample.relationId))));
  assert.notDeepEqual(
    second.relations.flatMap((entry) => entry.sourceRelationIds),
    first.relations.flatMap((entry) => entry.sourceRelationIds),
    "bounded traceability must follow the current raw snapshot rather than pinning old raw ids",
  );
});

test("quality reports mixed-language file-only and no-provider gaps without fabricating subsystem edges", () => {
  const graph = evidenceGraph();
  graph.nodes = [
    ...graph.nodes,
    {
      id: "code:node:python-file-only",
      kind: "file",
      name: "worker.py",
      canonicalIdentity: "file:src/python/worker.py",
      language: "python",
      location: { path: "src/python/worker.py", startLine: 1 },
    },
  ];
  const baseCapabilities = providerCapabilities();
  const mixedCapabilities: CodeMapProviderCapabilityReport = {
    ...baseCapabilities,
    languages: [
      ...baseCapabilities.languages,
      {
        language: "ruby",
        discoveredFileCount: 2,
        eligibleFileCount: null,
        indexedFileCount: 0,
        excludedFileCount: 0,
        exclusionReason: null,
        symbolCount: 0,
        fidelity: "file-only",
        providerIds: [],
        observedRelationKinds: [],
        semanticCoverage: "unavailable",
        gapReason: "file_only",
        installOptions: [],
      },
    ],
  };

  const read = createCodeSourceSubsystemRead(
    graph,
    projectCodeArchitecture(graph),
    mixedCapabilities,
  );
  assert.deepEqual(
    read.quality.languageGaps.map((entry) => [entry.language, entry.gapReason]),
    [
      ["python", "no_trusted_provider_available"],
      ["ruby", "file_only"],
    ],
  );
  assert.equal(read.nodes.some((entry) => entry.pathPrefix === "src/python"), false);
  assert.equal(read.relations.some((entry) =>
    entry.fromPathPrefix === "src/python" || entry.toPathPrefix === "src/python"), false);
});
