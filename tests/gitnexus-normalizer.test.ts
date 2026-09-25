import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGitNexusGraph } from "../src/adapters/code-intelligence/gitnexus-normalizer.js";

const baseInput = {
  projectId: "questboard",
  rootPath: "/workspace/questboard",
  indexedAt: "2026-09-22T13:00:00.000Z",
} as const;

test("normalizes GitNexus node ids and edge kinds into vendor-neutral graph", () => {
  const graph = normalizeGitNexusGraph({
    ...baseInput,
    nodes: [
      {
        uid: "gitnexus-native-service-uid",
        kind: "Class",
        name: "QuestBoardService",
        qualifiedName: "QuestBoardService",
        filePath: "src/application/quest-board-service.ts",
        startLine: 150,
        language: "typescript",
      },
      {
        uid: "gitnexus-native-repository-uid",
        kind: "Interface",
        name: "QuestBoardRepository",
        qualifiedName: "QuestBoardRepository",
        filePath: "src/application/quest-board-repository.ts",
        startLine: 34,
        language: "typescript",
      },
    ],
    relations: [
      {
        fromUid: "gitnexus-native-service-uid",
        toUid: "gitnexus-native-repository-uid",
        type: "IMPLEMENTS",
        confidence: 0.91,
      },
    ],
  });

  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.relations.length, 1);
  assert.equal(graph.nodes[0]?.kind, "class");
  assert.equal(graph.nodes[1]?.kind, "interface");
  assert.equal(graph.relations[0]?.kind, "implements");
  assert.equal(graph.relations[0]?.confidence, 0.91);
  assert.match(graph.nodes[0]?.id ?? "", /^code:node:/);
  assert.equal(JSON.stringify(graph).includes("gitnexus-native-service-uid"), false);
  assert.equal(JSON.stringify(graph).includes("gitnexus-native-repository-uid"), false);
});

test("uses stable normalized ids when backend native ids change", () => {
  const makeGraph = (uid: string) =>
    normalizeGitNexusGraph({
      ...baseInput,
      nodes: [
        {
          uid,
          kind: "Method",
          name: "createTask",
          qualifiedName: "QuestBoardService.createTask",
          filePath: "src/application/quest-board-service.ts",
          startLine: 250,
        },
      ],
      relations: [],
    });

  assert.equal(makeGraph("native-a").nodes[0]?.id, makeGraph("native-b").nodes[0]?.id);
});

test("maps access direction and method override semantics", () => {
  const graph = normalizeGitNexusGraph({
    ...baseInput,
    nodes: [
      { uid: "a", kind: "Method", name: "save", filePath: "src/a.ts", startLine: 1 },
      { uid: "b", kind: "Property", name: "task", filePath: "src/b.ts", startLine: 2 },
      { uid: "c", kind: "Method", name: "base", filePath: "src/c.ts", startLine: 3 },
    ],
    relations: [
      { fromUid: "a", toUid: "b", type: "ACCESSES", reason: "write", confidence: 2 },
      { fromUid: "a", toUid: "c", type: "METHOD_OVERRIDES", confidence: -1 },
    ],
  });

  assert.deepEqual(graph.relations.map((relation) => relation.kind), ["writes", "overrides"]);
  assert.deepEqual(graph.relations.map((relation) => relation.confidence), [1, 0]);
});

test("fails closed when a GitNexus relation references a node missing from the exported rows", () => {
  assert.throws(
    () =>
      normalizeGitNexusGraph({
        ...baseInput,
        nodes: [{ uid: "known", kind: "Function", name: "known", filePath: "src/a.ts", startLine: 1 }],
        relations: [{ fromUid: "known", toUid: "missing", type: "CALLS" }],
      }),
    /unknown node/,
  );
});
