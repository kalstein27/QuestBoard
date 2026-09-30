import { DEFAULT_QUESTBOARD_PORT, parseQuestBoardPort } from "../server/runtime.js";
import { findTailscaleIpv4 } from "../server/network.js";
import {
  QUESTBOARD_DAEMON_PROTOCOL,
  readPinnedQuestBoardDaemonIdentity,
  type QuestBoardDaemonIdentity,
} from "../server/daemon-identity.js";
import { QuestBoardRemoteToolError } from "./agent-tools.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const LONG_RUNNING_REQUEST_TIMEOUT_MS = 120_000;
const DAEMON_CLIENT_HEADER = "x-questboard-daemon-client";
const LONG_RUNNING_AGENT_TOOLS = new Set([
  "questboard_refresh_code_map",
]);

export interface QuestBoardDaemonClientOptions {
  requestTimeoutMs?: number;
  longRunningRequestTimeoutMs?: number;
}

export class QuestBoardDaemonClient {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly options: QuestBoardDaemonClientOptions = {},
  ) {
    this.baseUrl = normalizeDaemonUrl(baseUrl);
  }

  async assertHealthy(
    expectedIdentity: QuestBoardDaemonIdentity = readPinnedQuestBoardDaemonIdentity(),
  ): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/health`, {
        headers: { [DAEMON_CLIENT_HEADER]: "1" },
        signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw daemonUnavailable(this.baseUrl, error);
    }
    if (!response.ok) {
      throw new Error(`QuestBoard daemon health check failed with HTTP ${response.status} at ${this.baseUrl}`);
    }
    const payload = await response.json() as {
      status?: unknown;
      daemon?: {
        protocol?: unknown;
        databaseId?: unknown;
        workspacePath?: unknown;
        databasePath?: unknown;
      };
    };
    if (payload.status !== "ok") {
      throw new Error(`QuestBoard daemon returned an invalid health response at ${this.baseUrl}`);
    }
    if (!isDaemonIdentity(payload.daemon)) {
      throw new Error(
        `QuestBoard daemon at ${this.baseUrl} does not expose the required ${QUESTBOARD_DAEMON_PROTOCOL} identity. `
        + "Restart the intended shared daemon with the current QuestBoard build.",
      );
    }

    const received = payload.daemon;
    const mismatch = identityMismatchFields(expectedIdentity, received);
    if (mismatch.length > 0) {
      throw new Error(
        `QuestBoard daemon identity mismatch at ${this.baseUrl}: ${mismatch.join(", ")}. `
        + "Refusing to attach to a different QuestBoard workspace/database.",
      );
    }
  }

  async callAgentTool(name: string, input: unknown = {}): Promise<unknown> {
    const response = await this.postJson(
      "/_questboard/agent-tool",
      { name, arguments: input },
      this.requestTimeoutMs(name),
    );
    const payload = await response.json() as {
      result?: unknown;
      error?: { code?: unknown; message?: unknown };
    };
    if (payload.error) {
      const code = typeof payload.error.code === "string" ? payload.error.code : "internal_error";
      const message = typeof payload.error.message === "string" ? payload.error.message : "QuestBoard daemon tool call failed";
      throw new QuestBoardRemoteToolError(code, message);
    }
    return payload.result;
  }

  async forwardMcp(sessionId: string, message: unknown): Promise<unknown | null> {
    const response = await this.postJson(
      "/_questboard/mcp-proxy",
      { sessionId, message },
      this.requestTimeoutMs(mcpToolName(message)),
    );
    if (response.status === 204) return null;
    return await response.json() as unknown;
  }

  private requestTimeoutMs(toolName: string | undefined): number {
    return toolName && LONG_RUNNING_AGENT_TOOLS.has(toolName)
      ? (this.options.longRunningRequestTimeoutMs ?? LONG_RUNNING_REQUEST_TIMEOUT_MS)
      : (this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  }

  private async postJson(pathname: string, body: unknown, timeoutMs: number): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [DAEMON_CLIENT_HEADER]: "1",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new Error(
          `QuestBoard daemon request timed out after ${timeoutMs}ms at ${this.baseUrl}${pathname}; `
          + "the daemon may still be processing the operation and its terminal state is unknown",
          { cause: error },
        );
      }
      throw daemonUnavailable(this.baseUrl, error);
    }
    if (!response.ok) {
      throw new Error(`QuestBoard daemon request failed with HTTP ${response.status} at ${this.baseUrl}${pathname}`);
    }
    return response;
  }
}

function mcpToolName(message: unknown): string | undefined {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return undefined;
  const envelope = message as { method?: unknown; params?: unknown };
  if (envelope.method !== "tools/call") return undefined;
  if (envelope.params === null || typeof envelope.params !== "object" || Array.isArray(envelope.params)) return undefined;
  const name = (envelope.params as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

export function resolveQuestBoardDaemonUrl(
  env: NodeJS.ProcessEnv = process.env,
  tailscaleIpv4: string | null | undefined = findTailscaleIpv4(),
): string {
  const configured = env.QUESTBOARD_DAEMON_URL?.trim();
  if (configured) return normalizeDaemonUrl(configured);
  const port = env.QUESTBOARD_PORT === undefined
    ? DEFAULT_QUESTBOARD_PORT
    : parseQuestBoardPort(env.QUESTBOARD_PORT);
  const host = tailscaleIpv4 ?? "127.0.0.1";
  return `http://${host}:${port}`;
}

function isDaemonIdentity(value: unknown): value is QuestBoardDaemonIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.protocol === QUESTBOARD_DAEMON_PROTOCOL
    && typeof candidate.databaseId === "string"
    && candidate.databaseId.trim().length > 0
    && typeof candidate.workspacePath === "string"
    && candidate.workspacePath.trim().length > 0
    && typeof candidate.databasePath === "string"
    && candidate.databasePath.trim().length > 0;
}

function identityMismatchFields(
  expected: QuestBoardDaemonIdentity,
  received: QuestBoardDaemonIdentity,
): string[] {
  const mismatch: string[] = [];
  if (received.protocol !== expected.protocol) mismatch.push(`protocol expected ${expected.protocol}, received ${received.protocol}`);
  if (received.databaseId !== expected.databaseId) mismatch.push(`databaseId expected ${expected.databaseId}, received ${received.databaseId}`);
  if (received.workspacePath !== expected.workspacePath) mismatch.push(`workspacePath expected ${expected.workspacePath}, received ${received.workspacePath}`);
  if (received.databasePath !== expected.databasePath) mismatch.push(`databasePath expected ${expected.databasePath}, received ${received.databasePath}`);
  return mismatch;
}

function normalizeDaemonUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("QUESTBOARD_DAEMON_URL must be a valid http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("QUESTBOARD_DAEMON_URL must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("QUESTBOARD_DAEMON_URL must not include credentials, query, or fragment components");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function daemonUnavailable(baseUrl: string, cause: unknown): Error {
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  return new Error(`QuestBoard daemon is unavailable at ${baseUrl}${detail}`);
}