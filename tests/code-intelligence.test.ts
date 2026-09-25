import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_GRAPH_SCHEMA_VERSION,
  CODE_NODE_KINDS,
  CODE_RELATION_KINDS,
  assertValidCodeGraphSnapshot,
  validateCodeGraphSnapshot,
  type CodeGraphSnapshot,
} from "../src/index.js";

function validSnapshot(): CodeGraphSnapshot {
  return {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId: "project-1",
    rootPath: "/workspace/project-1",
    indexedAt: "2026-09-22T12:00:00.000Z",
    nodes: [
      {
        id: "node:service",
        kind: "class",
        name: "QuestBoardService",
        canonicalIdentity: "src/application/quest-board-service.ts#QuestBoardService",
        language: "typescript",
        location: { path: "src/application/quest-board-service.ts", startLine: 1, endLine: 10 },
      },
      {
        id: "node:repository",
        kind: "interface",
        name: "QuestBoardRepository",
        canonicalIdentity: "src/application/quest-board-repository.ts#QuestBoardRepository",
        language: "typescript",
      },
    ],
    relations: [
      {
        id: "relation:service-repository",
        from: "node:service",
        to: "node:repository",
        kind: "depends_on",
        confidence: 1,
        evidence: [
          {
            location: { path: "src/application/quest-board-service.ts", startLine: 35 },
            label: "constructor dependency",
          },
        ],
      },
    ],
  };
}

test("code intelligence contract stays vendor-neutral and accepts a normalized graph", () => {
  const snapshot = validSnapshot();

  assert.equal(validateCodeGraphSnapshot(snapshot).length, 0);
  assert.doesNotThrow(() => assertValidCodeGraphSnapshot(snapshot));
  assert.ok(CODE_NODE_KINDS.includes("interface"));
  assert.ok(CODE_RELATION_KINDS.includes("calls"));
  assert.equal(JSON.stringify(snapshot).toLowerCase().includes("gitnexus"), false);
});

test("code graph validation rejects duplicate ids, dangling relations, and invalid confidence", () => {
  const snapshot = validSnapshot();
  const invalid: CodeGraphSnapshot = {
    ...snapshot,
    nodes: [snapshot.nodes[0]!, snapshot.nodes[0]!],
    relations: [
      snapshot.relations[0]!,
      {
        id: snapshot.relations[0]!.id,
        from: "node:missing",
        to: "node:repository",
        kind: "calls",
        confidence: 1.5,
      },
    ],
  };

  const codes = validateCodeGraphSnapshot(invalid).map((issue) => issue.code);
  assert.ok(codes.includes("duplicate_node_id"));
  assert.ok(codes.includes("duplicate_relation_id"));
  assert.ok(codes.includes("dangling_relation"));
  assert.ok(codes.includes("invalid_confidence"));
  assert.throws(() => assertValidCodeGraphSnapshot(invalid), /Invalid code graph snapshot/);
});
