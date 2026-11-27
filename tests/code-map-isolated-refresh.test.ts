import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, existsSync, symlinkSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createConfiguredCodeMapRuntime } from "../src/server/code-map-config.js";
import { isolatedCodeMapEnv, isolatedWorkerExit } from "../src/server/code-map-isolated-env.js";
import { resolveIsolatedRefreshTimeoutMs } from "../src/server/code-map-isolated-refresh.js";
import { createIsolatedCodeMapRefreshExecutor } from "../src/server/code-map-isolated-refresh.js";
import type { CodeMapManualRelationReader } from "../src/application/code-map-augmentation.js";
import type { QuestBoardRepository } from "../src/application/quest-board-repository.js";
import type { CodeMapService } from "../src/application/code-map-service.js";

const TEST_TIMEOUT_MS = 40_000;

test("G1/G5 worker environment and timeout use explicit bounded settings", () => {
  const env = isolatedCodeMapEnv({
    PATH: "/empty", QUESTBOARD_PHP_EXECUTABLE: "/tools/php",
    QUESTBOARD_SOURCEKIT_LSP_EXECUTABLE: "/tools/sourcekit-lsp",
    QUESTBOARD_SOURCEKIT_EXTRA_BUILD_CONTEXTS: '[{"sourcePrefixes":["MacHost/"],"logsPath":"MacLogs"}]',
    QUESTBOARD_SOURCEKIT_BUILD_SERVER_EXECUTABLE: "/tools/xcode-build-server",
    UNRELATED_SECRET: "must not be inherited",
  });
  assert.equal(env.QUESTBOARD_PHP_EXECUTABLE, "/tools/php");
  assert.equal(env.QUESTBOARD_SOURCEKIT_LSP_EXECUTABLE, "/tools/sourcekit-lsp");
  assert.equal(env.QUESTBOARD_SOURCEKIT_EXTRA_BUILD_CONTEXTS,
    '[{"sourcePrefixes":["MacHost/"],"logsPath":"MacLogs"}]');
  assert.equal(env.QUESTBOARD_SOURCEKIT_BUILD_SERVER_EXECUTABLE, "/tools/xcode-build-server");
  assert.equal(env.UNRELATED_SECRET, undefined);
  assert.equal(resolveIsolatedRefreshTimeoutMs({}), 240_000);
  assert.equal(resolveIsolatedRefreshTimeoutMs({ QUESTBOARD_CODE_MAP_ISOLATED_REFRESH_TIMEOUT_MS: "600000" }), 600_000);
  assert.equal(resolveIsolatedRefreshTimeoutMs({ QUESTBOARD_CODE_MAP_ISOLATED_REFRESH_TIMEOUT_MS: "600000" }, 200), 200);
  for (const raw of ["99", "900001", "1e4", "invalid"]) {
    assert.throws(() => resolveIsolatedRefreshTimeoutMs({ QUESTBOARD_CODE_MAP_ISOLATED_REFRESH_TIMEOUT_MS: raw }), /REFRESH_TIMEOUT_MS/);
  }
  const oom = isolatedWorkerExit("refresh", null, "SIGABRT", "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory");
  assert.match(oom.message, /heap out of memory/);
  assert.match(oom.message, /QUESTBOARD_CODE_MAP_ISOLATED_REFRESH_HEAP_MIB/);
  assert.match(oom.message, /SIGABRT/);
  assert.doesNotMatch(isolatedWorkerExit("refresh", 1, null, "other failure").message, /heap out of memory/);
});

test("G1/G2 actual isolated PHP refresh uses the explicit executable without PHP on PATH", { timeout: TEST_TIMEOUT_MS }, async t => {
  const autoload = process.env.QUESTBOARD_TEST_PHP_PARSER_AUTOLOAD;
  if (!autoload || process.platform === "win32") { t.skip("POSIX native SCIP fixture unavailable"); return; }
  const vendor = dirname(realpathSync.native(autoload));
  if (!existsSync(join(vendor, "bin/scip-php")) || !existsSync(join(dirname(vendor), "composer.lock"))) {
    t.skip("Native SCIP fixture unavailable"); return;
  }
  const temp = mkdtempSync(join(tmpdir(), "qb-g1-php-"));
  try {
    const root = join(temp, "project");
    const storage = join(temp, "storage");
    const emptyPath = join(temp, "empty-path");
    mkdirSync(root); mkdirSync(emptyPath); mkdirSync(join(root, "src"));
    symlinkSync(vendor, join(root, "vendor"), "dir");
    copyFileSync(join(dirname(vendor), "composer.lock"), join(root, "composer.lock"));
    writeFileSync(join(root, "composer.json"), JSON.stringify({ name: "questboard/g1-fixture", autoload: { classmap: ["src/"] } }));
    writeFileSync(join(root, "src", "Sample.php"), "<?php final class Sample { public function go(): void {} }");
    const php = execFileSync("php", ["-r", "echo PHP_BINARY;"], { encoding: "utf8" }).trim();
    const indexer = join(temp, "scip-explicit");
    // The native indexer has its own explicit launcher; the separate AST
    // extraction must get QUESTBOARD_PHP_EXECUTABLE through the worker env.
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    writeFileSync(indexer, "#!/bin/sh\nexec " + quote(php) + " " + quote(join(vendor, "bin/scip-php")) + ' "$@"\n', { mode: 0o700 });
    const env = { HOME: process.env.HOME, PATH: emptyPath, QUESTBOARD_CODE_MAP: "1",
      QUESTBOARD_CODE_MAP_PROVIDERS: "scip-php", QUESTBOARD_CODE_MAP_STORAGE_ROOT: storage,
      QUESTBOARD_SCIP_PHP_EXECUTABLE: indexer, QUESTBOARD_PHP_EXECUTABLE: php };
    const request = { projectId: "explicit-php", rootPath: realpathSync.native(root) };
    const good = await createIsolatedCodeMapRefreshExecutor(env)(request);
    assert.ok(good.nodeCount > 2);
    await assert.rejects(createIsolatedCodeMapRefreshExecutor({
      ...env, QUESTBOARD_PHP_EXECUTABLE: join(emptyPath, "missing-php"),
    })(request), /Executable spawn failed \(ENOENT\): missing-php/);
    await assert.rejects(createIsolatedCodeMapRefreshExecutor({
      ...env, QUESTBOARD_CODE_MAP_ISOLATED_REFRESH_TIMEOUT_MS: "100",
    })({ ...request, projectId: "timeout-php" }), /timed out after 100 ms/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

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
