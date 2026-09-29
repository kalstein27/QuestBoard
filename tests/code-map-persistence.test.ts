import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CODE_GRAPH_SCHEMA_VERSION,
  CODE_MAP_PERSISTED_SNAPSHOT_FORMAT_VERSION,
  CodeMapService,
  type CodeGraphSnapshot,
  type CodeIndexRequest,
  type CodeIntelligenceProvider,
  type CodeMapPersistedSnapshotStore,
  type CodeMapSourceStateProvider,
  type PersistedCodeMapSnapshotEnvelope,
} from "../src/index.js";
import {
  FileSystemCodeMapPersistedSnapshotStore,
  FileSystemCodeMapSourceStateProvider,
} from "../src/adapters/code-intelligence/code-map-persistence.js";
import { QuestBoardService, SqliteQuestBoardRepository } from "../src/index.js";
import { createConfiguredCodeMapRuntime } from "../src/server/code-map-config.js";

class MemoryStore implements CodeMapPersistedSnapshotStore {
  value: unknown;

  load() {
    return this.value;
  }

  save(_projectId: string, snapshot: PersistedCodeMapSnapshotEnvelope) {
    this.value = structuredClone(snapshot);
  }
}

class ThrowingStore implements CodeMapPersistedSnapshotStore {
  load(): unknown {
    throw new Error("corrupt snapshot");
  }
  save(): void {}
}

class MutableSourceState implements CodeMapSourceStateProvider {
  manifest = "manifest-a";
  failManifest = false;

  rootIdentity(rootPath: string): string {
    return `root:${rootPath}`;
  }

  sourceManifestFingerprint(): string {
    if (this.failManifest) throw new Error("manifest unavailable");
    return this.manifest;
  }
}

class CountingProvider implements CodeIntelligenceProvider {
  readonly providerId = "fixture-provider";
  readonly capabilities = {
    incrementalIndexing: false,
    impactAnalysis: false,
    callTrace: false,
  } as const;
  readonly calls: CodeIndexRequest[] = [];
  readonly #snapshots: CodeGraphSnapshot[];

  constructor(snapshots: CodeGraphSnapshot[] = []) {
    this.#snapshots = [...snapshots];
  }

  async indexProject(request: CodeIndexRequest): Promise<CodeGraphSnapshot> {
    this.calls.push(request);
    const snapshot = this.#snapshots.shift();
    if (!snapshot) throw new Error("provider must not run");
    return snapshot;
  }
}

function graph(indexedAt: string, signature = "main(): void"): CodeGraphSnapshot {
  return {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId: "project-1",
    rootPath: "/workspace/project-1",
    indexedAt,
    nodes: [
      {
        id: "symbol:main",
        kind: "function",
        name: "main",
        canonicalIdentity: "src/main.ts#main",
        language: "typescript",
        location: { path: "src/main.ts", startLine: 1 },
        signature,
      },
    ],
    relations: [],
  };
}

function persistence(
  store: CodeMapPersistedSnapshotStore,
  sourceState: CodeMapSourceStateProvider,
  providerConfigFingerprint = "provider-contract-v1",
) {
  return {
    store,
    sourceState,
    providerConfigFingerprint,
    rootPathForProject: (projectId: string) => projectId === "project-1" ? "/workspace/project-1" : undefined,
    now: () => "2026-09-29T15:00:00.000Z",
  };
}

test("persisted Code Map hydrates after service recreation without invoking provider", async () => {
  const store = new MemoryStore();
  const sourceState = new MutableSourceState();
  const firstProvider = new CountingProvider([graph("2026-09-29T14:00:00.000Z")]);
  const first = new CodeMapService(firstProvider, undefined, undefined, undefined, persistence(store, sourceState));

  await first.refresh({ projectId: "project-1", rootPath: "/workspace/project-1" });
  assert.equal(firstProvider.calls.length, 1);
  assert.equal(first.snapshotLifecycleState("project-1")?.snapshotSource, "fresh-index");
  assert.equal(first.snapshotLifecycleState("project-1")?.freshness, "current");

  const restartedProvider = new CountingProvider();
  const restarted = new CodeMapService(restartedProvider, undefined, undefined, undefined, persistence(store, sourceState));
  const restored = restarted.getCached("project-1");

  assert.ok(restored);
  assert.equal(restartedProvider.calls.length, 0);
  assert.equal(restored.graph.indexedAt, "2026-09-29T14:00:00.000Z");
  assert.equal(restarted.snapshotLifecycleState("project-1")?.snapshotSource, "persisted");
  assert.equal(restarted.snapshotLifecycleState("project-1")?.freshness, "current");
  const query = restarted.query("project-1", { operation: "find_nodes", query: "main" });
  assert.equal(query.operation, "find_nodes");
  if (query.operation !== "find_nodes") throw new Error("Expected find_nodes result");
  assert.equal(query.nodes[0]?.name, "main");
});

test("source change marks hydrated snapshot stale without provider execution and explicit refresh clears it", async () => {
  const store = new MemoryStore();
  const sourceState = new MutableSourceState();
  const seed = new CodeMapService(
    new CountingProvider([graph("2026-09-29T14:00:00.000Z")]),
    undefined,
    undefined,
    undefined,
    persistence(store, sourceState),
  );
  await seed.refresh({ projectId: "project-1", rootPath: "/workspace/project-1" });

  sourceState.manifest = "manifest-b";
  const provider = new CountingProvider([graph("2026-09-29T15:00:00.000Z", "main(value: string): void")]);
  const restarted = new CodeMapService(provider, undefined, undefined, undefined, persistence(store, sourceState));

  assert.ok(restarted.getCached("project-1"));
  assert.equal(provider.calls.length, 0);
  assert.deepEqual(restarted.snapshotLifecycleState("project-1"), {
    snapshotSource: "persisted",
    freshness: "stale",
    staleReason: "source_changed",
  });
  const staleQuery = restarted.query("project-1", { operation: "find_nodes", query: "main" });
  assert.equal(staleQuery.operation, "find_nodes");
  if (staleQuery.operation !== "find_nodes") throw new Error("Expected find_nodes result");
  assert.equal(staleQuery.nodes.length, 1);
  assert.equal(provider.calls.length, 0);

  await restarted.refresh({ projectId: "project-1", rootPath: "/workspace/project-1" });
  assert.equal(provider.calls.length, 1);
  assert.deepEqual(restarted.snapshotLifecycleState("project-1"), {
    snapshotSource: "fresh-index",
    freshness: "current",
  });
  assert.equal(restarted.getCached("project-1")?.graph.nodes[0]?.signature, "main(value: string): void");
});

test("source check failure keeps persisted graph queryable with unknown freshness", async () => {
  const store = new MemoryStore();
  const sourceState = new MutableSourceState();
  const seed = new CodeMapService(
    new CountingProvider([graph("2026-09-29T14:00:00.000Z")]),
    undefined,
    undefined,
    undefined,
    persistence(store, sourceState),
  );
  await seed.refresh({ projectId: "project-1", rootPath: "/workspace/project-1" });

  sourceState.failManifest = true;
  const provider = new CountingProvider();
  const restarted = new CodeMapService(provider, undefined, undefined, undefined, persistence(store, sourceState));
  assert.ok(restarted.getCached("project-1"));
  assert.equal(provider.calls.length, 0);
  assert.deepEqual(restarted.snapshotLifecycleState("project-1"), {
    snapshotSource: "persisted",
    freshness: "unknown",
    staleReason: "source_check_failed",
  });
});

test("corrupt and incompatible persisted snapshots fail closed without invoking provider", () => {
  const sourceState = new MutableSourceState();
  const cases: Array<{ name: string; store: CodeMapPersistedSnapshotStore; expected: string }> = [
    { name: "corrupt", store: new ThrowingStore(), expected: "corrupt" },
    {
      name: "format",
      store: Object.assign(new MemoryStore(), { value: { formatVersion: 999 } }),
      expected: "format_changed",
    },
    {
      name: "provider",
      store: Object.assign(new MemoryStore(), {
        value: {
          formatVersion: CODE_MAP_PERSISTED_SNAPSHOT_FORMAT_VERSION,
          graphSchemaVersion: CODE_GRAPH_SCHEMA_VERSION,
          projectId: "project-1",
          rootIdentity: "root:/workspace/project-1",
          providerConfigFingerprint: "different-provider-contract",
          persistedAt: "2026-09-29T14:00:00.000Z",
          graph: graph("2026-09-29T14:00:00.000Z"),
        },
      }),
      expected: "provider_changed",
    },
    {
      name: "root",
      store: Object.assign(new MemoryStore(), {
        value: {
          formatVersion: CODE_MAP_PERSISTED_SNAPSHOT_FORMAT_VERSION,
          graphSchemaVersion: CODE_GRAPH_SCHEMA_VERSION,
          projectId: "project-1",
          rootIdentity: "different-root",
          providerConfigFingerprint: "provider-contract-v1",
          persistedAt: "2026-09-29T14:00:00.000Z",
          graph: graph("2026-09-29T14:00:00.000Z"),
        },
      }),
      expected: "root_changed",
    },
  ];

  for (const entry of cases) {
    const provider = new CountingProvider();
    const service = new CodeMapService(provider, undefined, undefined, undefined, persistence(entry.store, sourceState));
    assert.equal(service.getCached("project-1"), undefined, entry.name);
    assert.equal(provider.calls.length, 0, entry.name);
    assert.equal(service.hydrationDiagnostic("project-1")?.hydrationRejectReason, entry.expected, entry.name);
  }
});

test("filesystem snapshot and source manifest stay outside project checkout", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "questboard-code-map-persistence-"));
  const projectRoot = join(tempRoot, "project");
  const storageRoot = join(tempRoot, "external-code-map");
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  mkdirSync(join(projectRoot, ".questboard"), { recursive: true });
  writeFileSync(join(projectRoot, "src", "main.ts"), "export const value = 1;\n");
  writeFileSync(join(projectRoot, ".questboard", "questboard.sqlite"), "db-state-a\n");

  try {
    const sourceState = new FileSystemCodeMapSourceStateProvider();
    const before = sourceState.sourceManifestFingerprint(projectRoot);
    const store = new FileSystemCodeMapPersistedSnapshotStore(storageRoot);
    const envelope: PersistedCodeMapSnapshotEnvelope = {
      formatVersion: CODE_MAP_PERSISTED_SNAPSHOT_FORMAT_VERSION,
      graphSchemaVersion: CODE_GRAPH_SCHEMA_VERSION,
      projectId: "project-1",
      rootIdentity: sourceState.rootIdentity(projectRoot),
      providerConfigFingerprint: "provider-contract-v1",
      sourceManifestFingerprint: before,
      persistedAt: "2026-09-29T14:00:00.000Z",
      graph: { ...graph("2026-09-29T14:00:00.000Z"), rootPath: projectRoot },
    };
    store.save("project-1", envelope);
    assert.deepEqual(store.load("project-1"), envelope);
    assert.deepEqual(readdirSync(projectRoot).sort(), [".questboard", "src"]);

    writeFileSync(join(projectRoot, ".questboard", "questboard.sqlite"), "db-state-b-with-more-bytes\n");
    const afterRuntimeStateChange = sourceState.sourceManifestFingerprint(projectRoot);
    assert.equal(afterRuntimeStateChange, before);

    writeFileSync(join(projectRoot, "src", "main.ts"), "export const value = 12345;\n");
    const afterSourceChange = sourceState.sourceManifestFingerprint(projectRoot);
    assert.notEqual(afterSourceChange, before);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("configured runtime rejects Code Map storage inside the project checkout before writing state", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "questboard-code-map-internal-storage-"));
  const projectRoot = join(tempRoot, "project");
  const storageRoot = join(projectRoot, ".code-map-storage");
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "src", "main.ts"), "export const value = 1;\n");
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  const project = service.createProject(
    { name: "Internal storage guard", rootPath: projectRoot },
    { id: "human:owner", provider: "human" },
  );
  const env = {
    QUESTBOARD_CODE_MAP: "1",
    QUESTBOARD_CODE_MAP_STORAGE_ROOT: storageRoot,
    QUESTBOARD_SCIP_TYPESCRIPT_EXECUTABLE: "/definitely/missing/scip-typescript",
  };

  try {
    const runtime = createConfiguredCodeMapRuntime(env, repository);
    assert.ok(runtime.service);
    assert.equal(existsSync(storageRoot), false);
    await assert.rejects(
      runtime.service.refresh({ projectId: project.id, rootPath: projectRoot }),
      /storage root must be outside the project checkout/,
    );
    assert.equal(existsSync(storageRoot), false);
    assert.equal(runtime.service.getCached(project.id), undefined);
    assert.equal(
      runtime.service.hydrationDiagnostic(project.id)?.hydrationRejectReason,
      "storage_inside_project",
    );
    assert.equal(existsSync(storageRoot), false);
  } finally {
    repository.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("configured runtime hydrates persisted final graph across service recreation", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "questboard-code-map-runtime-persistence-"));
  const projectRoot = join(tempRoot, "project");
  const storageRoot = join(tempRoot, "code-map-storage");
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  writeFileSync(join(projectRoot, "src", "main.ts"), "export const value = 1;\n");
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  const project = service.createProject(
    { name: "Runtime persistence", rootPath: projectRoot },
    { id: "human:owner", provider: "human" },
  );
  const env = {
    QUESTBOARD_CODE_MAP: "1",
    QUESTBOARD_CODE_MAP_STORAGE_ROOT: storageRoot,
    QUESTBOARD_SCIP_TYPESCRIPT_EXECUTABLE: "/definitely/missing/scip-typescript",
  };

  try {
    const firstRuntime = createConfiguredCodeMapRuntime(env, repository);
    assert.ok(firstRuntime.service);
    await firstRuntime.service.refresh({ projectId: project.id, rootPath: projectRoot });
    assert.equal(firstRuntime.service.snapshotLifecycleState(project.id)?.snapshotSource, "fresh-index");

    const restartedRuntime = createConfiguredCodeMapRuntime(env, repository);
    assert.ok(restartedRuntime.service);
    const restored = restartedRuntime.service.getCached(project.id);
    assert.ok(restored);
    assert.equal(restartedRuntime.service.snapshotLifecycleState(project.id)?.snapshotSource, "persisted");
    assert.equal(restartedRuntime.service.snapshotLifecycleState(project.id)?.freshness, "current");

    writeFileSync(join(projectRoot, "src", "main.ts"), "export const value = 12345;\n");
    assert.deepEqual(restartedRuntime.service.snapshotLifecycleState(project.id), {
      snapshotSource: "persisted",
      freshness: "stale",
      staleReason: "source_changed",
    });
  } finally {
    repository.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
