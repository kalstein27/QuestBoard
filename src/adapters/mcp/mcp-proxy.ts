import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { QuestBoardDaemonClient } from "../daemon-client.js";

interface JsonRpcEnvelope {
  jsonrpc?: unknown;
  id?: unknown;
}

export async function runQuestBoardMcpProxyStdio(
  client: QuestBoardDaemonClient,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  sessionId = randomUUID(),
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });

  for await (const line of lines) {
    if (!line.trim()) continue;

    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      writeMessage(output, rpcError(null, -32700, "Parse error"));
      continue;
    }

    try {
      const response = await client.forwardMcp(sessionId, message);
      if (response !== null) writeMessage(output, response);
    } catch (error) {
      writeMessage(output, rpcError(
        requestIdFrom(message),
        -32001,
        error instanceof Error ? error.message : "QuestBoard daemon request failed",
      ));
    }
  }
}

function requestIdFrom(message: unknown): string | number | null {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return null;
  const id = (message as JsonRpcEnvelope).id;
  return typeof id === "string" || typeof id === "number" || id === null ? id : null;
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function writeMessage(output: Writable, response: unknown): void {
  output.write(`${JSON.stringify(response)}\n`);
}
