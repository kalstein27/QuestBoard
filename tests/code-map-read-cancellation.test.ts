import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createConfiguredCodeMapRuntime } from "../src/server/code-map-config.js";
import { createIsolatedCodeMapReadExecutor } from "../src/server/code-map-isolated-read.js";
import { createQuestBoardHttpServer } from "../src/server/http-api.js";
import { SqliteQuestBoardRepository } from "../src/storage/sqlite/sqlite-quest-board-repository.js";
import { QuestBoardService } from "../src/application/quest-board-service.js";

const actor = { id: "agent:s7-cancel", provider: "test" };
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
async function reaped(pid: number) {
  for (let i = 0; i < 80; i++) {
    if (!alive(pid)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`P2 aborted child ${pid} was not reaped`);
}
async function fixture(fn: (ctx: {
  projectId: string; parent: NonNullable<ReturnType<typeof createConfiguredCodeMapRuntime>["service"]>;
  tasks: QuestBoardService; repository: SqliteQuestBoardRepository; env: NodeJS.ProcessEnv;
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "qb-s7-cancel-root-"));
  const storage = mkdtempSync(join(tmpdir(), "qb-s7-cancel-snapshot-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "composer.json"), '{"name":"test/s7-cancel"}\n');
  writeFileSync(join(root, "src", "Handler.php"), "<?php class Handler {}\n");
  const repository = new SqliteQuestBoardRepository();
  const tasks = new QuestBoardService(repository);
  const projectId = tasks.createProject({ name: "S7 disposable", rootPath: realpathSync.native(root) }, actor).id;
  const env: NodeJS.ProcessEnv = {
    HOME: process.env.HOME, PATH: process.env.PATH,
    QUESTBOARD_CODE_MAP: "1", QUESTBOARD_CODE_MAP_PROVIDERS: "scip-php",
    QUESTBOARD_CODE_MAP_STORAGE_ROOT: storage,
  };
  try {
    const seed = createConfiguredCodeMapRuntime(env, repository).service!;
    await seed.refresh({ projectId, rootPath: realpathSync.native(root) });
    const parent = createConfiguredCodeMapRuntime(env, repository).service!;
    parent.getCached = () => { throw new Error("Aborted parent must not hydrate original graph"); };
    await fn({ projectId, parent, tasks, repository, env });
  } finally {
    repository.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(storage, { recursive: true, force: true });
  }
}

test("S7 P2 active AbortSignal kills only its child and subsequent reads recover", { timeout: 25_000 }, async () => {
  await fixture(async x => {
    const started: number[] = [];
    x.parent.setIsolatedReadExecutor(createIsolatedCodeMapReadExecutor(x.env, {
      maxConcurrent: 1, maxQueued: 1, timeoutMs: 15_000,
      onWorkerStarted: ({ pid }) => started.push(pid),
    }));
    const abort = new AbortController();
    const read = x.parent.webBootstrapAsync(x.projectId, abort.signal);
    assert.equal(started.length, 1);
    abort.abort();
    await assert.rejects(read, (e: unknown) => (e as Error).name === "AbortError");
    await reaped(started[0]!);
    const healthy = await x.parent.webBootstrapAsync(x.projectId);
    assert.equal(healthy.indexed, true);
    assert.equal(started.length, 2);
    await reaped(started[1]!);
  });
});

test("S7 P2 queued read cancellation removes the request before any worker spawns", { timeout: 25_000 }, async () => {
  await fixture(async x => {
    const operations: string[] = [];
    x.parent.setIsolatedReadExecutor(createIsolatedCodeMapReadExecutor(x.env, {
      maxConcurrent: 1, maxQueued: 1,
      onWorkerStarted: ({ operation }) => operations.push(operation),
    }));
    const first = x.parent.webBootstrapAsync(x.projectId);
    const cancellation = new AbortController();
    const queued = x.parent.sourceTreePageAsync(x.projectId, { limit: 2 }, cancellation.signal);
    cancellation.abort();
    await assert.rejects(queued, (e: unknown) => (e as Error).name === "AbortError");
    const next = x.parent.sourceTreePageAsync(x.projectId, { limit: 2 });
    assert.equal((await first).indexed, true);
    assert.ok((await next).entries.length > 0);
    assert.deepEqual(operations, ["web_bootstrap", "source_tree"],
      "cancelled queue entry must not spawn a third child");
  });
});

test("S7 HTTP socket close aborts the P2 worker and preserves normal subsequent queries", { timeout: 30_000 }, async () => {
  await fixture(async x => {
    const started: number[] = [];
    x.parent.setIsolatedReadExecutor(createIsolatedCodeMapReadExecutor(x.env, {
      onWorkerStarted: ({ pid }) => started.push(pid),
    }));
    const server = createQuestBoardHttpServer(x.tasks, { codeMapService: x.parent });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/projects/${x.projectId}/code-map`;
      const pending = httpGet(base, response => { response.resume(); });
      pending.on("error", () => {}); // ECONNRESET expected after intentional close
      for (let i = 0; started.length === 0 && i < 100; i++)
        await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(started.length, "HTTP request must spawn a P2 child before disconnection");
      pending.destroy();
      await reaped(started[0]!);
      const normal = await fetch(base);
      assert.equal(normal.status, 200);
      assert.equal((await normal.json() as { indexed: boolean }).indexed, true);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
