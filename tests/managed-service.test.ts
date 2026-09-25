import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { QUESTBOARD_DAEMON_PROTOCOL } from "../src/server/daemon-identity.js";
import {
  resolveQuestBoardRuntimePaths,
  startManagedServiceHealthRuntime,
} from "../src/server/managed-service.js";

test("package declares a generic managed service launch and bounded health contract", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    chatgpt2codex?: {
      managedService?: {
        launch?: {
          command?: string;
          args?: string[];
          cwdRelative?: string;
          inheritEnvKeys?: string[];
        };
        health?: { url?: string; timeoutMs?: number };
      };
    };
  };
  const service = packageJson.chatgpt2codex?.managedService;
  assert.deepEqual(service?.launch, {
    command: "node",
    args: ["dist/src/server/main.js", "--tailnet", "--managed-service"],
    cwdRelative: ".",
    inheritEnvKeys: [
      "QUESTBOARD_DB_PATH",
      "QUESTBOARD_IDENTITY_PATH",
      "QUESTBOARD_PORT",
      "QUESTBOARD_CONCURRENCY_LOG",
      "QUESTBOARD_CODE_MAP",
      "QUESTBOARD_CODE_MAP_PROVIDER",
      "QUESTBOARD_CODE_MAP_STORAGE_ROOT",
      "QUESTBOARD_GITNEXUS_EXECUTABLE",
      "QUESTBOARD_SCIP_TYPESCRIPT_EXECUTABLE",
      "QUESTBOARD_SCIP_EXECUTABLE",
    ],
  });
  assert.deepEqual(service?.health, {
    url: "http://127.0.0.1:4318/health",
    timeoutMs: 15_000,
  });
});

test("managed service mode reuses the pinned canonical workspace and database across checkout cwd changes", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "questboard-managed-service-paths-"));
  const canonicalWorkspace = join(tempRoot, "canonical-workspace");
  const managedCheckout = join(tempRoot, "managed-checkout");
  const canonicalDatabase = join(canonicalWorkspace, ".questboard", "questboard.sqlite");
  const identityPath = join(tempRoot, "daemon-identity.json");
  await mkdir(join(canonicalWorkspace, ".questboard"), { recursive: true });
  await mkdir(managedCheckout, { recursive: true });
  await writeFile(identityPath, `${JSON.stringify({
    protocol: QUESTBOARD_DAEMON_PROTOCOL,
    databaseId: "database-managed-service-test",
    workspacePath: canonicalWorkspace,
    databasePath: canonicalDatabase,
  })}\n`, "utf8");

  try {
    const resolved = resolveQuestBoardRuntimePaths({
      QUESTBOARD_IDENTITY_PATH: identityPath,
      QUESTBOARD_DB_PATH: join(managedCheckout, "wrong.sqlite"),
    }, managedCheckout, true);
    assert.equal(resolved.workspacePath, canonicalWorkspace);
    assert.equal(resolved.databasePath, canonicalDatabase);
    assert.equal(resolved.pinnedIdentity?.databaseId, "database-managed-service-test");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("managed service health endpoint reports the long-lived daemon readiness predicate", async () => {
  let healthy = false;
  const runtime = await startManagedServiceHealthRuntime(() => healthy, { port: 0 });
  try {
    const starting = await fetch(`${runtime.url}/health`);
    assert.equal(starting.status, 503);
    assert.deepEqual(await starting.json(), { status: "starting" });

    healthy = true;
    const ready = await fetch(`${runtime.url}/health`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: "ok" });
  } finally {
    await runtime.close();
  }
});
