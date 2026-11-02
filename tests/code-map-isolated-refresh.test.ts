import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createConfiguredCodeMapRuntime } from "../src/server/code-map-config.js";
import { createIsolatedCodeMapRefreshExecutor } from "../src/server/code-map-isolated-refresh.js";
import type { CodeMapManualRelationReader } from "../src/application/code-map-augmentation.js";
import type { QuestBoardRepository } from "../src/application/quest-board-repository.js";
import type { CodeMapService } from "../src/application/code-map-service.js";

const TEST_TIMEOUT_MS = 40_000;

async function terminal(service: CodeMapService, projectId: string) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const receipt = service.refreshJob(projectId);
    if (receipt?.state !== "running") return receipt;
    await sleep(25);
  }
  throw new Error("Isolated refresh did not reach a terminal state");
}

test("isolated Code Map refresh publishes a pinned file-only snapshot without graph IPC", { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = mkdtempSync(join(tmpdir(), "qb-isolated-php-root-"));
  const storage = mkdtempSync(join(tmpdir(), "qb-isolated-php-storage-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "composer.json"), '{"name":"example/isolated"}\n');
    writeFileSync(join(root, "src", "Handler.php"), "<?php final class Handler {}\n");
    const projectId = "isolated-php-fixture";
    const canonicalRoot = realpathSync.native(root);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      QUESTBOARD_CODE_MAP: "1",
      QUESTBOARD_CODE_MAP_PROVIDERS: "scip-php",
      QUESTBOARD_CODE_MAP_STORAGE_ROOT: storage,
    };
    const projectReader = {
      listCodeMapManualRelations: () => [],
      getProject: (id: string) => id === projectId ? { id, rootPath: canonicalRoot } : undefined,
    } as unknown as CodeMapManualRelationReader & Pick<QuestBoardRepository, "getProject">;
    const service = createConfiguredCodeMapRuntime(env, projectReader).service!;
    let childMaxRssMiB: number | undefined;
    service.setIsolatedRefreshExecutor(createIsolatedCodeMapRefreshExecutor(env, {
      timeoutMs: 20_000,
      onProcessMetrics: (metrics) => { childMaxRssMiB = metrics.childMaxRssMiB; },
    }));
    const first = service.startRefresh({ projectId, rootPath: canonicalRoot });
    const repeated = service.startRefresh({ projectId, rootPath: canonicalRoot });
    assert.equal(repeated.jobId, first.jobId, "repeat while running reuses the exact job");
    const done = await terminal(service, projectId);
    assert.equal(done?.state, "succeeded", JSON.stringify(done?.error));
    assert.ok(done?.indexedAt);
    assert.ok(childMaxRssMiB && childMaxRssMiB > 0, "child process RSS metric is present");
    const snapshot = service.getCached(projectId);
    assert.ok(snapshot);
    assert.ok(snapshot.graph.nodes.some((node) =>
      node.kind === "file" && node.location?.path === "src/Handler.php"));
    assert.equal(snapshot.graph.relations.length, 0, "no installed SCIP: no invented calls");
    assert.ok(service.snapshotIdentity(projectId)?.snapshotId);
    assert.equal(service.refreshJob(projectId)?.nodeCount, snapshot.graph.nodes.length);
    const restored = createConfiguredCodeMapRuntime(env, projectReader).service!;
    assert.equal(restored.snapshotIdentity(projectId)?.snapshotId,
      service.snapshotIdentity(projectId)?.snapshotId, "persisted snapshot is reusable after process exit");
    assert.equal(restored.getCached(projectId)?.graph.nodes.length, snapshot.graph.nodes.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(storage, { recursive: true, force: true });
  }
});

test("failed isolated refresh does not overwrite unrelated last-good snapshots", { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = mkdtempSync(join(tmpdir(), "qb-isolated-last-good-"));
  const storage = mkdtempSync(join(tmpdir(), "qb-isolated-last-good-cache-"));
  try {
    writeFileSync(join(root, "composer.json"), '{"name":"example/preserved"}\n');
    writeFileSync(join(root, "Main.php"), "<?php class Main {}\n");
    const projectId = "isolated-last-good";
    const canonicalRoot = realpathSync.native(root);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      QUESTBOARD_CODE_MAP: "1",
      QUESTBOARD_CODE_MAP_PROVIDERS: "scip-php",
      QUESTBOARD_CODE_MAP_STORAGE_ROOT: storage,
    };
    const projectReader = {
      listCodeMapManualRelations: () => [],
      getProject: (id: string) => id === projectId ? { id, rootPath: canonicalRoot } : undefined,
    } as unknown as CodeMapManualRelationReader & Pick<QuestBoardRepository, "getProject">;
    const service = createConfiguredCodeMapRuntime(env, projectReader).service!;
    service.setIsolatedRefreshExecutor(createIsolatedCodeMapRefreshExecutor(env, { timeoutMs: 20_000 }));
    service.startRefresh({ projectId, rootPath: canonicalRoot });
    assert.equal((await terminal(service, projectId))?.state, "succeeded");
    const beforeId = service.snapshotIdentity(projectId)?.snapshotId
      ?? (service.getCached(projectId), service.snapshotIdentity(projectId)?.snapshotId);
    assert.ok(beforeId);
    const wrongProject = "nonexistent-isolated-project";
    // Existing path that is a file, not a directory: passes the parent's
    // storage-root guard but fails inside the isolated index subprocess.
    service.startRefresh({ projectId: wrongProject, rootPath: join(root, "Main.php") });
    const failed = await terminal(service, wrongProject);
    assert.equal(failed?.state, "failed");
    assert.equal(service.getCached(projectId)?.graph.projectId, projectId);
    assert.equal(service.snapshotIdentity(projectId)?.snapshotId, beforeId);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(storage, { recursive: true, force: true });
  }
});

test("isolated Code Map executes a real TypeScript SCIP indexer in the child", { timeout: TEST_TIMEOUT_MS }, async () => {
  const root = mkdtempSync(join(tmpdir(), "qb-isolated-real-ts-"));
  const storage = mkdtempSync(join(tmpdir(), "qb-isolated-real-ts-cache-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", strict: true },
      include: ["src/**/*.ts"],
    }));
    writeFileSync(join(root, "src", "handler.ts"),
      "export function helper(): number { return 42; }\nexport function handler(): number { return helper(); }\n");
    const canonicalRoot = realpathSync.native(root);
    const projectId = "isolated-ts-semantic";
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      QUESTBOARD_CODE_MAP: "1",
      QUESTBOARD_CODE_MAP_PROVIDERS: "scip-typescript",
      QUESTBOARD_CODE_MAP_STORAGE_ROOT: storage,
      QUESTBOARD_SCIP_TYPESCRIPT_EXECUTABLE: join(process.cwd(), "node_modules", ".bin", "scip-typescript"),
    };
    const projectReader = {
      listCodeMapManualRelations: () => [],
      getProject: (id: string) => id === projectId ? { id, rootPath: canonicalRoot } : undefined,
    } as unknown as CodeMapManualRelationReader & Pick<QuestBoardRepository, "getProject">;
    const service = createConfiguredCodeMapRuntime(env, projectReader).service!;
    service.setIsolatedRefreshExecutor(createIsolatedCodeMapRefreshExecutor(env, { timeoutMs: 25_000 }));
    service.startRefresh({ projectId, rootPath: canonicalRoot });
    const done = await terminal(service, projectId);
    assert.equal(done?.state, "succeeded", JSON.stringify(done?.error));
    assert.ok((done?.nodeCount ?? 0) > 2);
    const restored = service.getCached(projectId);
    assert.ok(restored);
    assert.ok(restored.graph.nodes.some((node) => node.name === "handler"));
    assert.ok(restored.graph.relations.some((edge) => edge.kind === "calls"));
    assert.ok(restored.graph.providerRuns?.some((run) => run.providerId === "scip-typescript"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(storage, { recursive: true, force: true });
  }
});
