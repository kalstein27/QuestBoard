import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_GRAPH_SCHEMA_VERSION,
  CodeMapService,
  type CodeFileInventory,
  type CodeGraphSnapshot,
  type CodeIndexRequest,
  type CodeIntelligenceProvider,
} from "../src/index.js";

class FakeInventory implements CodeFileInventory {
  constructor(private readonly paths: readonly string[]) {}

  async listFiles() {
    return this.paths.map((path) => ({ path }));
  }
}

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

function rawOnlyGraph(signature: string, indexedAt: string): CodeGraphSnapshot {
  return {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId: "questboard",
    rootPath: "/workspace/questboard",
    indexedAt,
    nodes: [
      {
        id: "runtime-start",
        kind: "method",
        name: "startOperation",
        canonicalIdentity: "src/runtime/background-operations.ts#startOperation",
        language: "typescript",
        location: { path: "src/runtime/background-operations.ts", startLine: 10 },
        signature,
      },
    ],
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
  assert.deepEqual(cached.changedCodeNodeIds, []);
  assert.deepEqual(cached.changedArchitectureNodeIds, []);
});

test("Code Map service treats raw graph as indexed even when compatibility projection is empty", async () => {
  const provider = new FakeProvider([
    rawOnlyGraph("startOperation(): void", "2026-09-22T13:00:00.000Z"),
  ]);
  const service = new CodeMapService(provider);

  const result = await service.refresh({
    projectId: "questboard",
    rootPath: "/workspace/questboard",
  });

  assert.equal(result.graph.nodes.length, 1);
  assert.deepEqual(result.changedCodeNodeIds, ["runtime-start"]);
  assert.deepEqual(result.projection.nodes, []);
  assert.deepEqual(result.changedArchitectureNodeIds, []);
  assert.equal(service.getCached("questboard")?.graph.nodes[0]?.name, "startOperation");
});

test("Code Map service reports raw node changes independently from compatibility macro lens", async () => {
  const provider = new FakeProvider([
    rawOnlyGraph("startOperation(): void", "2026-09-22T13:00:00.000Z"),
    rawOnlyGraph("startOperation(options: Options): void", "2026-09-22T13:05:00.000Z"),
  ]);
  const service = new CodeMapService(provider);
  const request = { projectId: "questboard", rootPath: "/workspace/questboard" };

  await service.refresh(request);
  const incremental = await service.refresh({
    ...request,
    changes: [{ path: "src/runtime/background-operations.ts", kind: "modified" }],
  });

  assert.deepEqual(incremental.changedCodeNodeIds, ["runtime-start"]);
  assert.deepEqual(incremental.changedArchitectureNodeIds, []);
});

test("Code Map service marks both endpoints changed when only an attached relation changes", async () => {
  const before = graph(["service-a", "service-b"], "2026-09-22T13:00:00.000Z");
  before.relations = [{
    id: "service-a-calls-service-b",
    from: "service-a",
    to: "service-b",
    kind: "calls",
    confidence: 1,
  }];
  const after = graph(["service-a", "service-b"], "2026-09-22T13:05:00.000Z");
  after.relations = [{
    id: "service-a-calls-service-b",
    from: "service-a",
    to: "service-b",
    kind: "depends_on",
    confidence: 1,
  }];
  const service = new CodeMapService(new FakeProvider([before, after]));
  const request = { projectId: "questboard", rootPath: "/workspace/questboard" };

  await service.refresh(request);
  const incremental = await service.refresh({
    ...request,
    changes: [{ path: "src/application/quest-board-service.ts", kind: "modified" }],
  });

  assert.deepEqual(incremental.changedCodeNodeIds, ["service-a", "service-b"]);
});

test("Code Map service merges provider-neutral file inventory and attaches top-level symbols", async () => {
  const provider = new FakeProvider([
    rawOnlyGraph("startOperation(): void", "2026-09-22T13:00:00.000Z"),
  ]);
  const service = new CodeMapService(provider, new FakeInventory([
    "src/runtime/background-operations.ts",
    "macos/Companion.swift",
    "scripts/bootstrap.sh",
    "windows/install.ps1",
  ]));

  const result = await service.refresh({
    projectId: "questboard",
    rootPath: "/workspace/questboard",
  });
  const files = result.graph.nodes.filter((node) => node.kind === "file");
  const byPath = new Map(files.map((node) => [node.location?.path, node] as const));
  const tsFile = byPath.get("src/runtime/background-operations.ts");

  assert.equal(files.length, 4);
  assert.equal(byPath.get("macos/Companion.swift")?.language, "swift");
  assert.equal(byPath.get("scripts/bootstrap.sh")?.language, "shellscript");
  assert.equal(byPath.get("windows/install.ps1")?.language, "powershell");
  assert.ok(tsFile);
  assert.ok(result.graph.relations.some((relation) =>
    relation.kind === "contains"
      && relation.from === tsFile.id
      && relation.to === "runtime-start",
  ));
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
  assert.deepEqual(incremental.changedCodeNodeIds, ["service-b"]);
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
