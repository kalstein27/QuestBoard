import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { QuestBoardService } from "../../application/quest-board-service.js";
import {
  describeQuestBoardError,
  executeQuestBoardAgentTool,
  QUESTBOARD_AGENT_TOOLS,
} from "../agent-tools.js";

const SUPPORTED_PROTOCOL_VERSION = "2025-06-18";
const MUTATING_TOOLS = new Set([
  "questboard_create_project",
  "questboard_create_task",
  "questboard_update_task",
  "questboard_delete_task",
  "questboard_claim_task",
  "questboard_release_task",
  "questboard_add_activity",
  "questboard_add_artifact",
  "questboard_delete_artifact",
  "questboard_add_relation",
  "questboard_delete_relation",
  "questboard_create_investigation_node",
  "questboard_update_investigation_node",
  "questboard_delete_investigation_node",
  "questboard_add_investigation_item",
  "questboard_update_investigation_item",
  "questboard_delete_investigation_item",
  "questboard_link_task_to_investigation_item",
  "questboard_unlink_task_from_investigation_item",
  "questboard_create_task_for_investigation_item",
  "questboard_link_investigation_item_to_node",
  "questboard_unlink_investigation_item_from_node",
  "questboard_attach_existing_task_to_investigation",
  "questboard_reorder_investigation_items",
  "questboard_apply_migration_batch",
]);

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

export interface QuestBoardMcpHandler {
  handle(message: unknown): JsonRpcResponse | null;
}

export function createQuestBoardMcpHandler(
  service: QuestBoardService,
  sessionId: string = randomUUID(),
): QuestBoardMcpHandler {
  return {
    handle(message: unknown): JsonRpcResponse | null {
      let request: JsonRpcRequest;
      try {
        request = parseRequest(message);
      } catch (error) {
        return rpcError(null, -32600, error instanceof Error ? error.message : "Invalid request");
      }

      if (request.id === undefined) {
        if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") {
          return null;
        }
        return null;
      }

      try {
        switch (request.method) {
          case "initialize": {
            optionalObject(request.params);
            return rpcSuccess(request.id, {
              protocolVersion: SUPPORTED_PROTOCOL_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "questboard", version: "0.0.0" },
              instructions: "QuestBoard is a local shared work board. Claims are coordination signals, not mutation locks. Include a neutral actor on mutations; revision/idempotency coordination is handled internally.",
            });
          }
          case "ping":
            return rpcSuccess(request.id, {});
          case "tools/list":
            return rpcSuccess(request.id, { tools: QUESTBOARD_AGENT_TOOLS });
          case "tools/call": {
            const params = requireObject(request.params, "tools/call params");
            const name = requireText(params.name, "tool name");
            const rawArgs = requireObject(params.arguments ?? {}, "tool arguments");
            const args = MUTATING_TOOLS.has(name) && rawArgs.requestId === undefined
              ? { ...rawArgs, requestId: automaticMutationRequestId(sessionId, request.id, name, rawArgs) }
              : rawArgs;
            try {
              const result = executeQuestBoardAgentTool(service, name, args);
              return rpcSuccess(request.id, toolResult(result));
            } catch (error) {
              const described = describeQuestBoardError(error);
              return rpcSuccess(request.id, toolError(described));
            }
          }
          default:
            return rpcError(request.id, -32601, `Method not found: ${request.method}`);
        }
      } catch (error) {
        return rpcError(
          request.id,
          -32602,
          error instanceof Error ? error.message : "Invalid method parameters",
        );
      }
    },
  };
}

export async function runQuestBoardMcpStdio(
  service: QuestBoardService,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  const handler = createQuestBoardMcpHandler(service);
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
    const response = handler.handle(message);
    if (response) writeMessage(output, response);
  }
}

function parseRequest(message: unknown): JsonRpcRequest {
  const value = requireObject(message, "JSON-RPC request");
  if (value.jsonrpc !== "2.0") throw new TypeError("jsonrpc must equal 2.0");
  const method = requireText(value.method, "method");
  const id = value.id;
  if (id !== undefined && id !== null && typeof id !== "string" && typeof id !== "number") {
    throw new TypeError("id must be a string, number, or null");
  }
  return {
    jsonrpc: "2.0",
    method,
    ...(id !== undefined ? { id } : {}),
    ...(value.params !== undefined ? { params: value.params } : {}),
  };
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return requireObject(value, "params");
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function automaticMutationRequestId(
  sessionId: string,
  rpcId: string | number | null,
  toolName: string,
  args: Record<string, unknown>,
): string {
  const digest = createHash("sha256")
    .update(stableJson({ id: rpcId, tool: toolName, arguments: args }))
    .digest("hex")
    .slice(0, 32);
  return `mcp:${sessionId}:${digest}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function rpcSuccess(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcError {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolError(error: { code: string; message: string }): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify({ error }) }],
    structuredContent: { error },
    isError: true,
  };
}

function writeMessage(output: Writable, response: JsonRpcResponse): void {
  output.write(`${JSON.stringify(response)}\n`);
}
