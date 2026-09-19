import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const STARTUP_TIMEOUT_MS = 5_000;

test("MCP entrypoint also serves the QuestBoard Web UI/API without contaminating stdout", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "questboard-mcp-runtime-"));
  const port = await findFreePort();
  const child = spawn(process.execPath, ["dist/src/adapters/mcp/main.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      QUESTBOARD_DB_PATH: join(tempRoot, "questboard.sqlite"),
      QUESTBOARD_HOST: "127.0.0.1",
      QUESTBOARD_PORT: String(port),
      QUESTBOARD_TAILNET: "0",
      QUESTBOARD_CONCURRENCY_LOG: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });

  try {
    await withTimeout(
      waitForText(child.stderr, `QuestBoard Web/API listening on http://127.0.0.1:${port} (localhost)`),
      STARTUP_TIMEOUT_MS,
      "MCP Web/API runtime did not start",
    );

    assert.equal(stdout, "", "startup diagnostics must stay off MCP stdout");

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const home = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /id="kanban-board"/);

    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    })}\n`);
    await withTimeout(waitForText(child.stdout, '"id":1'), STARTUP_TIMEOUT_MS, "MCP initialize response missing");
    assert.doesNotMatch(stdout, /QuestBoard Web\/API listening/);

    child.stdin.end();
    const exitCode = await withTimeout(waitForExit(child), STARTUP_TIMEOUT_MS, "MCP runtime did not exit after stdin closed");
    assert.equal(exitCode, 0);

    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("MCP entrypoint can explicitly expose the bundled Web/API runtime to the local network", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "questboard-mcp-lan-runtime-"));
  const port = await findFreePort();
  const child = spawn(process.execPath, ["dist/src/adapters/mcp/main.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      QUESTBOARD_DB_PATH: join(tempRoot, "questboard.sqlite"),
      QUESTBOARD_HOST: "0.0.0.0",
      QUESTBOARD_PORT: String(port),
      QUESTBOARD_TAILNET: "0",
      QUESTBOARD_CONCURRENCY_LOG: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    await withTimeout(
      waitForText(child.stderr, `QuestBoard Web/API listening on http://0.0.0.0:${port} (network)`),
      STARTUP_TIMEOUT_MS,
      "MCP network Web/API runtime did not start",
    );

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    child.stdin.end();
    const exitCode = await withTimeout(waitForExit(child), STARTUP_TIMEOUT_MS, "MCP network runtime did not exit");
    assert.equal(exitCode, 0);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await rm(tempRoot, { recursive: true, force: true });
  }
});

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
