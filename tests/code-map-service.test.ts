import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_GRAPH_SCHEMA_VERSION,
  CodeMapService,
  type CodeGraphSnapshot,
  type CodeIndexRequest,
  type CodeIntelligenceProvider,
} from "../src/index.js";

class FakeProvider implements CodeIntelligenceProvider {
  readonly capabilities = {
    incrementalIndexing: true,
    impactAnalysis: false,
    callTrace: false,
  } as const;
  readonly calls: CodeIndexRequest[] = [];
  readonly #snapshots: CodeGraphSnapshot[];

  constructor(snapshots: CodeGraphSnapshot[]) {
    this.#snapshots = [...snapshots];
  }

  async indexProject(request: CodeIndexRequest): Promise<CodeGraphSnapshot> {
    this.calls.push(request);
    const snapshot = this.#snapshots.shift();
    if (!snapshot) throw new Error("Unexpected provider call");
    return snapshot;
  }
}

function graph(memberIds: string[], indexedAt: string): CodeGraphSnapshot {
  return {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId: "questboard",
    rootPath: "/workspace/questboard",
    indexedAt,
    nodes: memberIds.map((id, index) => ({
      id,
      kind: "method" as const,
      name: index === 0 ? "createTask" : `helper${index}`,
      canonicalIdentity: `src/application/quest-board-service.ts#method:${index}`,
      location: { path: "src/application/quest-board-service.ts", startLine: index + 1 },
    })),
    relations: [],
  };
}

test("Code Map service caches explicit no-change refreshes without invoking provider", async () => {
  const provider = new FakeProvider([graph(["service-a"], "2026-09-22T13:00:00.000Z")]);
  const service = new CodeMapService(provider);
  const request = { projectId: "questboard", rootPath: "/workspace/questboard" };

  const first = await service.refresh(request);
  const cached = await service.refresh({ ...request, changes: [] });

  assert.equal(first.mode, "full");
  assert.equal(cached.mode, "cache-hit");
  assert.equal(provider.calls.length, 1);
  assert.deepEqual(cached.changedArchitectureNodeIds, []);
});

test("Code Map service forwards changed-file hints and reports impacted macro nodes", async () => {
  const provider = new FakeProvider([
    graph(["service-a"], "2026-09-22T13:00:00.000Z"),
    graph(["service-a", "service-b"], "2026-09-22T13:05:00.000Z"),
  ]);
  const service = new CodeMapService(provider);
  const request = { projectId: "questboard", rootPath: "/workspace/questboard" };

  const first = await service.refresh(request);
  const incremental = await service.refresh({
    ...request,
    changes: [{ path: "src/application/quest-board-service.ts", kind: "modified" }],
  });

  assert.equal(incremental.mode, "incremental");
  assert.equal(provider.calls.length, 2);
  assert.deepEqual(provider.calls[1]?.changes, [
    { path: "src/application/quest-board-service.ts", kind: "modified" },
  ]);
  assert.deepEqual(incremental.changedArchitectureNodeIds, [first.projection.nodes[0]?.id]);
});

test("Code Map service keeps Task overlays attached to stable macro ids after refresh", async () => {
  const provider = new FakeProvider([
    graph(["service-a"], "2026-09-22T13:00:00.000Z"),
    graph(["service-renamed-native-id"], "2026-09-22T13:05:00.000Z"),
  ]);
  const service = new CodeMapService(provider);
  const request = { projectId: "questboard", rootPath: "/workspace/questboard" };

  const first = await service.refresh(request);
  const applicationNodeId = first.projection.nodes[0]!.id;
  await service.refresh({
    ...request,
    changes: [{ path: "src/application/quest-board-service.ts", kind: "modified" }],
  });
  const overlay = service.overlayTasks("questboard", [
    { taskId: "task-1", codeNodeId: applicationNodeId, kind: "affects" },
  ]);

  assert.equal(overlay.orphanedLinks.length, 0);
  assert.equal(overlay.nodes[0]?.taskLinks[0]?.taskId, "task-1");
});

test("Code Map service rejects provider project/root mismatches", async () => {
  const wrong = graph(["service"], "2026-09-22T13:00:00.000Z");
  wrong.projectId = "other";
  const service = new CodeMapService(new FakeProvider([wrong]));

  await assert.rejects(
    () => service.refresh({ projectId: "questboard", rootPath: "/workspace/questboard" }),
    /returned project other/,
  );
});
