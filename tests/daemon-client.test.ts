import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { QuestBoardDaemonClient, resolveQuestBoardDaemonUrl } from "../src/adapters/daemon-client.js";
import {
  pinQuestBoardDaemonIdentity,
  QUESTBOARD_DAEMON_PROTOCOL,
  readPinnedQuestBoardDaemonIdentity,
} from "../src/server/daemon-identity.js";

test("daemon client prefers explicit QUESTBOARD_DAEMON_URL", () => {
  assert.equal(
    resolveQuestBoardDaemonUrl({ QUESTBOARD_DAEMON_URL: "http://127.0.0.1:4999/" }, "100.70.80.90"),
    "http://127.0.0.1:4999",
  );
});

test("daemon client auto-discovers the active Tailnet address", () => {
  assert.equal(
    resolveQuestBoardDaemonUrl({ QUESTBOARD_PORT: "4318" }, "100.70.80.90"),
    "http://100.70.80.90:4318",
  );
});

test("daemon client falls back to localhost when Tailnet is unavailable", () => {
  assert.equal(resolveQuestBoardDaemonUrl({}, null), "http://127.0.0.1:4317");
});

test("daemon identity pin refuses a different database for the same profile", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "questboard-daemon-identity-"));
  const identityPath = join(tempRoot, "daemon-identity.json");
  const first = daemonIdentity("database-a", "workspace-a");
  try {
    assert.deepEqual(pinQuestBoardDaemonIdentity(first, identityPath), first);
    assert.deepEqual(pinQuestBoardDaemonIdentity(first, identityPath), first);
    assert.throws(
      () => pinQuestBoardDaemonIdentity(
        daemonIdentity("database-b", "workspace-a"),
        identityPath,
      ),
      /daemon identity mismatch/,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("daemon identity pin refuses another canonical workspace for the same database id", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "questboard-daemon-workspace-identity-"));
  const identityPath = join(tempRoot, "daemon-identity.json");
  const first = daemonIdentity("database-a", "workspace-a");
  try {
    pinQuestBoardDaemonIdentity(first, identityPath);
    assert.throws(
      () => pinQuestBoardDaemonIdentity(daemonIdentity("database-a", "workspace-b"), identityPath),
      /daemon identity mismatch/,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("daemon identity pin safely upgrades a legacy v1 profile for the same database", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "questboard-daemon-legacy-identity-"));
  const identityPath = join(tempRoot, "daemon-identity.json");
  const current = daemonIdentity("database-a", "workspace-a");
  try {
    await writeFile(identityPath, `${JSON.stringify({ protocol: "questboard-daemon-v1", databaseId: "database-a" })}\n`, "utf8");
    assert.deepEqual(pinQuestBoardDaemonIdentity(current, identityPath), current);
    assert.deepEqual(readPinnedQuestBoardDaemonIdentity(identityPath), current);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("daemon client refuses a healthy QuestBoard daemon backed by a different database", async () => {
  const expected = daemonIdentity("database-a", "workspace-a");
  const received = daemonIdentity("database-b", "workspace-a");
  const fetchImpl = (async () => new Response(JSON.stringify({
    status: "ok",
    daemon: received,
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  const client = new QuestBoardDaemonClient("http://127.0.0.1:4317", fetchImpl);
  await assert.rejects(
    client.assertHealthy(expected),
    /databaseId expected database-a/,
  );
});

test("daemon client refuses the same database id from a different canonical workspace", async () => {
  const expected = daemonIdentity("database-a", "workspace-a");
  const received = daemonIdentity("database-a", "workspace-b");
  const fetchImpl = (async () => new Response(JSON.stringify({ status: "ok", daemon: received }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  const client = new QuestBoardDaemonClient("http://127.0.0.1:4317", fetchImpl);
  await assert.rejects(client.assertHealthy(expected), /workspacePath expected/);
});

test("daemon client accepts an exact protocol, database, workspace, and database-path identity", async () => {
  const expected = daemonIdentity("database-a", "workspace-a");
  const fetchImpl = (async () => new Response(JSON.stringify({ status: "ok", daemon: expected }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  const client = new QuestBoardDaemonClient("http://127.0.0.1:4317", fetchImpl);
  await client.assertHealthy(expected);
});

test("daemon client refuses legacy health responses without daemon identity", async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  const client = new QuestBoardDaemonClient("http://127.0.0.1:4317", fetchImpl);
  await assert.rejects(
    client.assertHealthy(daemonIdentity("database-a", "workspace-a")),
    /does not expose the required questboard-daemon-v2 identity/,
  );
});

function daemonIdentity(databaseId: string, workspaceName: string) {
  const workspacePath = join(tmpdir(), workspaceName);
  return {
    protocol: QUESTBOARD_DAEMON_PROTOCOL,
    databaseId,
    workspacePath,
    databasePath: join(workspacePath, ".questboard", "questboard.sqlite"),
  } as const;
}
