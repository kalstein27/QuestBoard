import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_GRAPH_SCHEMA_VERSION,
  type CodeGraphSnapshot,
  type CodeNode,
  type CodeRelation,
} from "../src/application/code-intelligence.js";
import { createCodeSourceSubsystemRead } from "../src/application/code-map-subsystem-read.js";
import { projectCodeArchitecture } from "../src/application/code-map-projection.js";
import {
  boundCodeMapSubsystemOverview,
  CODE_MAP_SUBSYSTEM_RESPONSE_MAX_BYTES,
} from "../src/application/code-map-subsystem-transport.js";

test("large subsystem GET summary fits hard MCP/HTTP byte cap and marks omitted evidence", () => {
  const nodes: CodeNode[] = [];
  for (let group = 0; group < 12; group++) {
    for (let member = 0; member < 40; member++) {
      nodes.push({
        id: "code:node:" + group + ":" + member,
        kind: "method",
        name: "handleOrder" + member,
        canonicalIdentity: "scip:src/part" + group + "/Handler.php#handleOrder" + member,
        language: "php",
        location: { path: "src/part" + group + "/Handler.php", startLine: member + 1 },
      });
    }
  }
  const relations: CodeRelation[] = nodes.map((node, index) => ({
    id: "code:relation:" + index,
    from: node.id,
    to: nodes[(index + 40) % nodes.length]!.id,
    kind: "calls",
    confidence: 1,
    evidence: [{
      location: { path: node.location!.path, startLine: index % 40 + 1 },
      label: "PHP AST verified call " + "detailed evidence ".repeat(20),
    }],
  }));
  const graph: CodeGraphSnapshot = {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId: "large-php-response",
    rootPath: "/tmp/large-php-response",
    indexedAt: "2026-11-03T00:00:00Z",
    nodes,
    relations,
  };
  const full = createCodeSourceSubsystemRead(graph, projectCodeArchitecture(graph));
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify({ subsystems: value }));
  assert.ok(size(full) > CODE_MAP_SUBSYSTEM_RESPONSE_MAX_BYTES);
  const limited = boundCodeMapSubsystemOverview(full);
  assert.ok(size(limited) <= CODE_MAP_SUBSYSTEM_RESPONSE_MAX_BYTES, size(limited).toString());
  assert.equal(limited.responseTruncation?.reason, "response_byte_cap");
  assert.equal(limited.responseTruncation?.maxBytes, CODE_MAP_SUBSYSTEM_RESPONSE_MAX_BYTES);
  assert.equal(limited.truncated, true);
  assert.ok(limited.nodes.length > 0);
  assert.equal(limited.nodes[0]?.id, full.nodes[0]?.id);
  assert.ok(limited.relations.length > 0);
  assert.ok(limited.nodes.every((node) => node.notableNodes.length <= 1));
  assert.ok(limited.relations.every((relation) => relation.sourceRelationIds.length <= 1));
  assert.equal(full.nodes.some((node) => node.notableNodes.length > 1), true,
    "the original detailed graph is not modified");
});

test("small overview is returned unchanged and an invalid cap is rejected", () => {
  const graph: CodeGraphSnapshot = {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION, projectId: "simple",
    rootPath: "/tmp/simple", indexedAt: "2026-11-03T00:00:00Z", nodes: [], relations: [],
  };
  const small = createCodeSourceSubsystemRead(graph, projectCodeArchitecture(graph));
  assert.equal(boundCodeMapSubsystemOverview(small), small);
  assert.throws(() => boundCodeMapSubsystemOverview(small, 100), /byte cap/);
});
