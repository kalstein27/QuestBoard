import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_GRAPH_SCHEMA_VERSION,
  deriveCodeSourceSubsystems,
  type CodeGraphSnapshot,
  type CodeNode,
  type CodeRelation,
} from "../src/index.js";

function sourceNode(
  id: string,
  name: string,
  path: string,
  startLine: number,
  canonicalIdentity = `scip:${path}#${name}`,
  kind: CodeNode["kind"] = "function",
): CodeNode {
  return {
    id,
    kind,
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
  line: number,
  path = "src/server/tools.ts",
): CodeRelation {
  return {
    id,
    from,
    to,
    kind: "calls",
    confidence: 1,
    evidence: [{
      location: { path, startLine: line, startColumn: 4, endLine: line, endColumn: 20 },
      label: "SCIP-resolved direct call",
    }],
    provenance: [{
      providerId: "scip-typescript",
      fidelity: "semantic-call",
      freshness: "fresh",
    }],
  };
}

function phase6EvidenceGraph(): CodeGraphSnapshot {
  const nodes: CodeNode[] = [
    sourceNode(
      "handler-managed",
      "managed_mcp_update",
      "src/server/tools.ts",
      11304,
      "source-registration:src/server/tools.ts:registerTool:managed_mcp_update:11304",
    ),
    sourceNode(
      "handler-operation",
      "operation_status",
      "src/server/tools.ts",
      13504,
      "source-registration:src/server/tools.ts:registerTool:operation_status:13504",
    ),
    sourceNode("with-error-mapping", "withErrorMapping", "src/server/tools.ts", 4200),
    sourceNode("register-tools", "registerTools", "src/server/tools.ts", 4545),
    sourceNode("http-server", "createHttpServer", "src/server/http.ts", 354),
    sourceNode("managed-update", "updateManagedMcp", "src/mcp/managed-mcp.ts", 811),
    sourceNode("durable-manager", "durableOperationManager", "src/exec/durable-operations.ts", 746),
    sourceNode("runtime-record", "record", "src/runtime/connection-diagnostics.ts", 155),
    sourceNode("runtime-apply", "RuntimeApply", "src/runtime/runtime-apply.ts", 70, undefined, "class"),
    sourceNode("operation-port", "OperationPort", "src/exec/operation-port.ts", 12, undefined, "interface"),
    sourceNode("cli-main", "main", "src/cli.ts", 20),
    sourceNode("tool-context", "ToolContext", "src/types.ts", 40, undefined, "type"),
    sourceNode("similar-name-only", "updateManagedMcp", "src/fake/updateManagedMcp.ts", 7),
    {
      id: "external-promise",
      kind: "class",
      name: "Promise",
      canonicalIdentity: "scip-external:typescript:Promise",
      language: "typescript",
    },
    {
      id: "external-nodejs-timeout",
      kind: "class",
      name: "Timeout",
      canonicalIdentity: "scip-external:typescript:NodeJS.Timeout",
      language: "typescript",
    },
  ];
  const relations: CodeRelation[] = [
    call("handler-managed-with-error", "handler-managed", "with-error-mapping", 11319),
    call("handler-operation-with-error", "handler-operation", "with-error-mapping", 13518),
    call("outer-register-managed-update", "register-tools", "managed-update", 11327),
    call("outer-register-durable", "register-tools", "durable-manager", 13526),
    call("http-runtime-record", "http-server", "runtime-record", 421, "src/server/http.ts"),
    call("cli-http-server", "cli-main", "http-server", 88, "src/cli.ts"),
    call("cli-types", "cli-main", "tool-context", 91, "src/cli.ts"),
    call("http-external-promise", "http-server", "external-promise", 500, "src/server/http.ts"),
    call("register-external-nodejs", "register-tools", "external-nodejs-timeout", 501),
    {
      id: "broad-name-only-dependency",
      from: "register-tools",
      to: "similar-name-only",
      kind: "depends_on",
      confidence: 1,
    },
    {
      id: "runtime-implements-operation-port",
      from: "runtime-apply",
      to: "operation-port",
      kind: "implements",
      confidence: 1,
      evidence: [{
        location: { path: "src/runtime/runtime-apply.ts", startLine: 70 },
        label: "semantic implements",
      }],
    },
    {
      id: "http-instantiates-runtime",
      from: "http-server",
      to: "runtime-apply",
      kind: "instantiates",
      confidence: 1,
      evidence: [{
        location: { path: "src/server/http.ts", startLine: 430 },
        label: "semantic instantiation",
      }],
    },
  ];
  return {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId: "phase6-evidence",
    rootPath: "/workspace/ChatGPT2Codex",
    indexedAt: "2026-10-07T07:29:17.346Z",
    nodes,
    relations,
  };
}

test("derives subsystem edges only from project-local directed semantic relations", () => {
  const graph = phase6EvidenceGraph();
  const derived = deriveCodeSourceSubsystems(graph);

  assert.equal(derived.nodes.some((node) => node.pathPrefix === "src/adapters"), false);
  assert.equal(derived.nodes.some((node) => node.pathPrefix === "src"), false);

  const cli = derived.nodes.find((node) => node.pathPrefix === "src/cli.ts");
  const types = derived.nodes.find((node) => node.pathPrefix === "src/types.ts");
  assert.equal(cli?.classification, "root_source_file");
  assert.equal(types?.classification, "root_source_file");
  assert.ok(cli?.selectionReasons.includes("unclassified_root_file"));

  const serverToMcp = derived.relations.find((relation) =>
    relation.fromPathPrefix === "src/server"
    && relation.toPathPrefix === "src/mcp"
    && relation.kind === "calls");
  assert.ok(serverToMcp);
  assert.equal(serverToMcp.sourceRelationCount, 1);
  assert.deepEqual(serverToMcp.sourceRelationIds, ["outer-register-managed-update"]);
  assert.deepEqual(
    serverToMcp.evidenceSample.map((entry) => [entry.fromNodeId, entry.toNodeId]),
    [["register-tools", "managed-update"]],
  );

  assert.equal(
    derived.relations.some((relation) => relation.kind === ("depends_on" as never)),
    false,
  );
  assert.equal(
    derived.relations.some((relation) =>
      relation.sourceRelationIds.includes("broad-name-only-dependency")),
    false,
  );
  assert.equal(
    derived.relations.some((relation) =>
      relation.sourceRelationIds.includes("http-external-promise")),
    false,
  );
  assert.equal(
    derived.relations.some((relation) =>
      relation.sourceRelationIds.includes("register-external-nodejs")),
    false,
  );

  const structural = derived.relations.find((relation) =>
    relation.fromPathPrefix === "src/runtime"
    && relation.toPathPrefix === "src/exec"
    && relation.kind === "implements");
  assert.ok(structural);
  assert.deepEqual(structural.sourceRelationIds, ["runtime-implements-operation-port"]);
});

test("preserves Phase 6 registration ownership without synthesizing handler transitive edges", () => {
  const derived = deriveCodeSourceSubsystems(phase6EvidenceGraph());
  const server = derived.nodes.find((node) => node.pathPrefix === "src/server");
  assert.ok(server);

  const managedHandler = server.notableNodes.find((node) => node.nodeId === "handler-managed");
  const operationHandler = server.notableNodes.find((node) => node.nodeId === "handler-operation");
  assert.ok(managedHandler);
  assert.ok(operationHandler);
  assert.ok(managedHandler.roles.includes("registration_handler"));
  assert.ok(operationHandler.roles.includes("registration_handler"));
  assert.deepEqual(managedHandler.directSourceRelationIds, ["handler-managed-with-error"]);
  assert.deepEqual(operationHandler.directSourceRelationIds, ["handler-operation-with-error"]);

  assert.equal(
    managedHandler.directSourceRelationIds.includes("outer-register-managed-update"),
    false,
  );
  assert.equal(
    operationHandler.directSourceRelationIds.includes("outer-register-durable"),
    false,
  );

  const serverToMcp = derived.relations.find((relation) =>
    relation.fromPathPrefix === "src/server"
    && relation.toPathPrefix === "src/mcp"
    && relation.kind === "calls");
  assert.ok(serverToMcp);
  assert.equal(
    serverToMcp.evidenceSample.some((entry) => entry.fromNodeId === "handler-managed"),
    false,
    "raw outer registerTools ownership must not be rewritten onto the registration handler",
  );
});

test("ranks bridge and entrypoint anchors deterministically instead of lexical raw ids", () => {
  const first = deriveCodeSourceSubsystems(phase6EvidenceGraph());
  const reversedGraph = phase6EvidenceGraph();
  reversedGraph.nodes = [...reversedGraph.nodes].reverse();
  reversedGraph.relations = [...reversedGraph.relations].reverse();
  const second = deriveCodeSourceSubsystems(reversedGraph);

  assert.deepEqual(second, first);

  const server = first.nodes.find((node) => node.pathPrefix === "src/server");
  assert.ok(server);
  assert.equal(server.representativeNodeIds[0], "http-server");
  assert.ok(server.notableNodes.some((node) => node.nodeId === "register-tools"));
  assert.ok(server.notableNodes.some((node) => node.nodeId === "handler-managed"));
  assert.equal(
    server.representativeNodeIds[0] === [...server.representativeNodeIds].sort()[0],
    false,
    "representative selection must not be lexical raw-id first",
  );
});

test("separates total edge count from bounded evidence samples and reports evidence truncation", () => {
  const nodes: CodeNode[] = [];
  const relations: CodeRelation[] = [];
  for (let index = 0; index < 20; index += 1) {
    nodes.push(sourceNode(`caller-${index}`, `caller${index}`, `src/a/a-${index}.ts`, 1));
    nodes.push(sourceNode(`callee-${index}`, `callee${index}`, `src/b/b-${index}.ts`, 1));
    relations.push(call(
      `edge-${String(index).padStart(2, "0")}`,
      `caller-${index}`,
      `callee-${index}`,
      index + 1,
      `src/a/a-${index}.ts`,
    ));
  }
  const graph: CodeGraphSnapshot = {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId: "evidence-cap",
    rootPath: "/workspace/evidence-cap",
    indexedAt: "2026-10-07T08:00:00.000Z",
    nodes,
    relations,
  };

  const derived = deriveCodeSourceSubsystems(graph);
  const aggregate = derived.relations.find((relation) =>
    relation.fromPathPrefix === "src/a"
    && relation.toPathPrefix === "src/b"
    && relation.kind === "calls");
  assert.ok(aggregate);
  assert.equal(aggregate.sourceRelationCount, 20);
  assert.equal(aggregate.sourceRelationIds.length, 16);
  assert.equal(aggregate.evidenceSample.length, 16);
  assert.equal(aggregate.evidenceTruncated, true);
  assert.equal(aggregate.evidenceTruncationReason, "evidence_sample_cap");
  assert.deepEqual(
    aggregate.sourceRelationIds,
    aggregate.evidenceSample.map((entry) => entry.relationId),
  );
});

test("reports deterministic subsystem and aggregate-relation caps separately", () => {
  const subsystemNodes = Array.from({ length: 13 }, (_, index) =>
    sourceNode(
      `subsystem-${index}`,
      `node${index}`,
      `src/g${String(index).padStart(2, "0")}/entry.ts`,
      1,
    ));
  const subsystemGraph: CodeGraphSnapshot = {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId: "subsystem-cap",
    rootPath: "/workspace/subsystem-cap",
    indexedAt: "2026-10-07T08:10:00.000Z",
    nodes: subsystemNodes,
    relations: [],
  };
  const subsystemDerived = deriveCodeSourceSubsystems(subsystemGraph);
  assert.equal(subsystemDerived.nodes.length, 12);
  assert.deepEqual(subsystemDerived.truncation.subsystems, {
    candidateCount: 13,
    returnedCount: 12,
    truncated: true,
    reason: "subsystem_cap",
  });

  const relationNodes = Array.from({ length: 8 }, (_, index) =>
    sourceNode(
      `relation-node-${index}`,
      `node${index}`,
      `src/r${index}/entry.ts`,
      1,
    ));
  const relationEdges: CodeRelation[] = [];
  for (let from = 0; from < relationNodes.length; from += 1) {
    for (let to = 0; to < relationNodes.length; to += 1) {
      if (from === to) continue;
      relationEdges.push(call(
        `r-${from}-${to}`,
        `relation-node-${from}`,
        `relation-node-${to}`,
        relationEdges.length + 1,
        `src/r${from}/entry.ts`,
      ));
    }
  }
  const relationGraph: CodeGraphSnapshot = {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId: "relation-cap",
    rootPath: "/workspace/relation-cap",
    indexedAt: "2026-10-07T08:20:00.000Z",
    nodes: relationNodes,
    relations: relationEdges,
  };
  const relationDerived = deriveCodeSourceSubsystems(relationGraph);
  assert.equal(relationDerived.relations.length, 24);
  assert.deepEqual(relationDerived.truncation.relations, {
    candidateCount: 56,
    returnedCount: 24,
    truncated: true,
    reason: "relation_cap",
  });
  assert.equal(relationDerived.truncated, true);
});

test("fails soft for a boundaryless mixed-language file-only project without inventing structure", () => {
  const graph: CodeGraphSnapshot = {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId: "boundaryless-mixed",
    rootPath: "/workspace/boundaryless-mixed",
    indexedAt: "2026-10-07T08:30:00.000Z",
    nodes: [
      sourceNode("single-entry", "main", "src/index.ts", 1),
      {
        id: "python-file-only",
        kind: "file",
        name: "worker.py",
        canonicalIdentity: "file:src/python/worker.py",
        language: "python",
        location: { path: "src/python/worker.py", startLine: 1 },
      },
      {
        id: "ruby-file-only",
        kind: "file",
        name: "worker.rb",
        canonicalIdentity: "file:src/ruby/worker.rb",
        language: "ruby",
        location: { path: "src/ruby/worker.rb", startLine: 1 },
      },
    ],
    relations: [
      {
        id: "path-only-broad-dependency",
        from: "single-entry",
        to: "python-file-only",
        kind: "depends_on",
        confidence: 1,
      },
    ],
  };

  const derived = deriveCodeSourceSubsystems(graph);
  assert.deepEqual(
    derived.nodes.map((entry) => [entry.pathPrefix, entry.classification]),
    [["src/index.ts", "root_source_file"]],
  );
  assert.equal(derived.relations.length, 0);
  assert.equal(derived.truncated, false);
  assert.deepEqual(derived.truncation, {
    subsystems: { candidateCount: 1, returnedCount: 1, truncated: false },
    relations: { candidateCount: 0, returnedCount: 0, truncated: false },
  });
});
