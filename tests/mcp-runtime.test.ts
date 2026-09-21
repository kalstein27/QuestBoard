import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { QUESTBOARD_DAEMON_PROTOCOL } from "../src/server/daemon-identity.js";

const STARTUP_TIMEOUT_MS = 5_000;
const actor = { id: "agent:mcp-runtime-test", provider: "test" };

test("one daemon serves Web/API while multiple MCP stdio proxies share the same state", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "questboard-daemon-runtime-"));
  const port = await findFreePort();
  const daemon = spawnQuestBoardDaemon(tempRoot, port);
  let proxyA: ChildProcessWithoutNullStreams | undefined;
  let proxyB: ChildProcessWithoutNullStreams | undefined;

  try {
    await withTimeout(
      waitForText(daemon.stdout, `QuestBoard Web/API listening on http://127.0.0.1:${port} (localhost)`),
      STARTUP_TIMEOUT_MS,
      "QuestBoard daemon did not start",
    );

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const daemonHealth = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { "x-questboard-daemon-client": "1" },
    });
    const healthBody = await daemonHealth.json() as {
      status: string;
      daemon: { protocol: string; databaseId: string; workspacePath: string; databasePath: string };
    };
    assert.equal(healthBody.status, "ok");
    assert.equal(healthBody.daemon.protocol, QUESTBOARD_DAEMON_PROTOCOL);
    assert.ok(healthBody.daemon.databaseId);
    assert.equal(healthBody.daemon.workspacePath, realpathSync.native(process.cwd()));
    assert.equal(healthBody.daemon.databasePath, realpathSync.native(join(tempRoot, "questboard.sqlite")));

    const untrustedBridgeCall = await fetch(`http://127.0.0.1:${port}/_questboard/agent-tool`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ name: "questboard_list_projects", arguments: {} }),
    });
    assert.equal(untrustedBridgeCall.status, 400, "daemon bridge must reject requests without its client header");

    proxyA = spawnQuestBoardMcpProxy(tempRoot, port);
    proxyB = spawnQuestBoardMcpProxy(tempRoot, port);
    const a = createRpcClient(proxyA);
    const b = createRpcClient(proxyB);

    const initializeA = await a.request("initialize", { protocolVersion: "2025-06-18" });
    const initializeB = await b.request("initialize", { protocolVersion: "2025-06-18" });
    assert.equal(readServerName(initializeA), "questboard");
    assert.equal(readServerName(initializeB), "questboard");

    const created = await a.request("tools/call", {
      name: "questboard_create_project",
      arguments: { name: "Shared daemon project", actor },
    });
    const projectId = readStructuredContent(created).project.id as string;

    const projects = await b.request("tools/call", {
      name: "questboard_list_projects",
      arguments: {},
    });
    const sharedProjects = readStructuredContent(projects).projects as Array<{ id: string; name: string }>;
    assert.deepEqual(sharedProjects.map((project) => project.id), [projectId]);

    const createdTask = await b.request("tools/call", {
      name: "questboard_create_task",
      arguments: { projectId, title: "Created from proxy B", status: "ready", actor },
    });
    const taskId = readStructuredContent(createdTask).task.id as string;

    const tasks = await a.request("tools/call", {
      name: "questboard_list_tasks",
      arguments: { projectId, status: "ready" },
    });
    const sharedTasks = readStructuredContent(tasks).tasks as Array<{ id: string }>;
    assert.deepEqual(sharedTasks.map((task) => task.id), [taskId]);

    const cli = spawnQuestBoardCli(tempRoot, port, ["projects"]);
    let cliStdout = "";
    cli.stdout.setEncoding("utf8");
    cli.stdout.on("data", (chunk: string) => { cliStdout += chunk; });
    const cliExit = await withTimeout(waitForExit(cli), STARTUP_TIMEOUT_MS, "QuestBoard CLI did not exit");
    assert.equal(cliExit, 0);
    const cliProjects = JSON.parse(cliStdout) as { projects: Array<{ id: string }> };
    assert.deepEqual(cliProjects.projects.map((project) => project.id), [projectId]);

    proxyA.stdin.end();
    proxyB.stdin.end();
    assert.equal(await withTimeout(waitForExit(proxyA), STARTUP_TIMEOUT_MS, "MCP proxy A did not exit"), 0);
    assert.equal(await withTimeout(waitForExit(proxyB), STARTUP_TIMEOUT_MS, "MCP proxy B did not exit"), 0);

    const healthAfterSessions = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(healthAfterSessions.status, 200, "daemon must outlive MCP stdio sessions");

    const persistedProjects = await fetch(`http://127.0.0.1:${port}/projects`);
    const persistedBody = await persistedProjects.json() as { projects: Array<{ id: string }> };
    assert.deepEqual(persistedBody.projects.map((project) => project.id), [projectId]);
  } finally {
    if (proxyA?.exitCode === null) proxyA.kill("SIGTERM");
    if (proxyB?.exitCode === null) proxyB.kill("SIGTERM");
    if (daemon.exitCode === null) daemon.kill("SIGTERM");
    await Promise.allSettled([
      proxyA ? waitForExit(proxyA) : Promise.resolve(null),
      proxyB ? waitForExit(proxyB) : Promise.resolve(null),
      waitForExit(daemon),
    ]);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("daemon can explicitly expose Web/API to the local network while MCP remains a client", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "questboard-daemon-lan-runtime-"));
  const port = await findFreePort();
  const daemon = spawn(process.execPath, ["dist/src/server/main.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      QUESTBOARD_DB_PATH: join(tempRoot, "questboard.sqlite"),
      QUESTBOARD_IDENTITY_PATH: join(tempRoot, "daemon-identity.json"),
      QUESTBOARD_HOST: "0.0.0.0",
      QUESTBOARD_PORT: String(port),
      QUESTBOARD_TAILNET: "0",
      QUESTBOARD_CONCURRENCY_LOG: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    await withTimeout(
      waitForText(daemon.stdout, `QuestBoard Web/API listening on http://0.0.0.0:${port} (network)`),
      STARTUP_TIMEOUT_MS,
      "QuestBoard network daemon did not start",
    );
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
  } finally {
    if (daemon.exitCode === null) daemon.kill("SIGTERM");
    await Promise.allSettled([waitForExit(daemon)]);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("daemon refuses a different database under an already-pinned identity profile", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "questboard-daemon-profile-"));
  const firstPort = await findFreePort();
  let secondPort = await findFreePort();
  while (secondPort === firstPort) secondPort = await findFreePort();
  const first = spawnQuestBoardDaemon(tempRoot, firstPort, "first.sqlite");
  let second: ChildProcessWithoutNullStreams | undefined;

  try {
    await withTimeout(
      waitForText(first.stdout, `QuestBoard Web/API listening on http://127.0.0.1:${firstPort} (localhost)`),
      STARTUP_TIMEOUT_MS,
      "first QuestBoard daemon did not start",
    );

    second = spawnQuestBoardDaemon(tempRoot, secondPort, "second.sqlite");
    let stderr = "";
    second.stderr.setEncoding("utf8");
    second.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const exitCode = await withTimeout(waitForExit(second), STARTUP_TIMEOUT_MS, "second QuestBoard daemon did not fail fast");
    assert.notEqual(exitCode, 0);
    assert.match(stderr, /daemon identity mismatch/);
  } finally {
    if (second?.exitCode === null) second.kill("SIGTERM");
    if (first.exitCode === null) first.kill("SIGTERM");
    await Promise.allSettled([
      second ? waitForExit(second) : Promise.resolve(null),
      waitForExit(first),
    ]);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("MCP stdio proxy fails clearly when the shared daemon is unavailable", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "questboard-daemon-unavailable-"));
  const port = await findFreePort();
  await writeFile(
    join(tempRoot, "daemon-identity.json"),
    JSON.stringify({
      protocol: QUESTBOARD_DAEMON_PROTOCOL,
      databaseId: "missing-daemon",
      workspacePath: realpathSync.native(process.cwd()),
      databasePath: join(tempRoot, "missing.sqlite"),
    }),
    "utf8",
  );
  const proxy = spawnQuestBoardMcpProxy(tempRoot, port);
  let stderr = "";
  proxy.stderr.setEncoding("utf8");
  proxy.stderr.on("data", (chunk: string) => { stderr += chunk; });

  try {
    const exitCode = await withTimeout(waitForExit(proxy), STARTUP_TIMEOUT_MS, "MCP proxy did not fail fast");
    assert.notEqual(exitCode, 0);
    assert.match(stderr, /QuestBoard daemon is unavailable/);
    assert.match(stderr, /npm run daemon/);
  } finally {
    if (proxy.exitCode === null) proxy.kill("SIGTERM");
    await rm(tempRoot, { recursive: true, force: true });
  }
});

function spawnQuestBoardDaemon(
  tempRoot: string,
  port: number,
  databaseFile = "questboard.sqlite",
): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["dist/src/server/main.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      QUESTBOARD_DB_PATH: join(tempRoot, databaseFile),
      QUESTBOARD_IDENTITY_PATH: join(tempRoot, "daemon-identity.json"),
      QUESTBOARD_HOST: "127.0.0.1",
      QUESTBOARD_PORT: String(port),
      QUESTBOARD_TAILNET: "0",
      QUESTBOARD_CONCURRENCY_LOG: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function spawnQuestBoardMcpProxy(tempRoot: string, port: number): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["dist/src/adapters/mcp/main.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      QUESTBOARD_DAEMON_URL: `http://127.0.0.1:${port}`,
      QUESTBOARD_IDENTITY_PATH: join(tempRoot, "daemon-identity.json"),
      QUESTBOARD_CONCURRENCY_LOG: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function spawnQuestBoardCli(tempRoot: string, port: number, args: string[]): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["dist/src/adapters/cli/main.js", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      QUESTBOARD_DAEMON_URL: `http://127.0.0.1:${port}`,
      QUESTBOARD_IDENTITY_PATH: join(tempRoot, "daemon-identity.json"),
      QUESTBOARD_CONCURRENCY_LOG: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

interface RpcClient {
  request(method: string, params?: unknown): Promise<Record<string, unknown>>;
}

function createRpcClient(child: ChildProcessWithoutNullStreams): RpcClient {
  let nextId = 1;
  let buffer = "";
  const pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as { id?: unknown } & Record<string, unknown>;
      if (typeof message.id !== "number") continue;
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });
  child.once("error", (error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });
  child.once("exit", (code) => {
    if (pending.size === 0) return;
    const error = new Error(`MCP proxy exited with code ${String(code)} while requests were pending`);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });

  return {
    request(method, params) {
      const id = nextId++;
      const response = new Promise<Record<string, unknown>>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) })}\n`);
      return withTimeout(response, STARTUP_TIMEOUT_MS, `MCP request ${method} timed out`);
    },
  };
}

function readServerName(message: Record<string, unknown>): string | undefined {
  const result = message.result as { serverInfo?: { name?: string } } | undefined;
  return result?.serverInfo?.name;
}

function readStructuredContent(message: Record<string, unknown>): Record<string, any> {
  const result = message.result as { structuredContent?: Record<string, any>; isError?: boolean } | undefined;
  assert.equal(result?.isError, undefined);
  assert.ok(result?.structuredContent);
  return result.structuredContent;
}

async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate test port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function waitForText(stream: NodeJS.ReadableStream, text: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      if (!buffer.includes(text)) return;
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onEnd = (): void => {
      cleanup();
      reject(new Error(`Stream ended before matching ${JSON.stringify(text)}`));
    };
    const cleanup = (): void => {
      stream.off("data", onData);
      stream.off("error", onError);
      stream.off("end", onEnd);
    };
    stream.on("data", onData);
    stream.on("error", onError);
    stream.on("end", onEnd);
  });
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", reject);
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
