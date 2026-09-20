import { DEFAULT_QUESTBOARD_PORT, parseQuestBoardPort } from "../server/runtime.js";
import { QuestBoardRemoteToolError } from "./agent-tools.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DAEMON_CLIENT_HEADER = "x-questboard-daemon-client";

export class QuestBoardDaemonClient {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = normalizeDaemonUrl(baseUrl);
  }

  async assertHealthy(): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw daemonUnavailable(this.baseUrl, error);
    }
    if (!response.ok) {
      throw new Error(`QuestBoard daemon health check failed with HTTP ${response.status} at ${this.baseUrl}`);
    }
    const payload = await response.json() as { status?: unknown };
    if (payload.status !== "ok") {
      throw new Error(`QuestBoard daemon returned an invalid health response at ${this.baseUrl}`);
    }
  }

  async callAgentTool(name: string, input: unknown = {}): Promise<unknown> {
    const response = await this.postJson("/_questboard/agent-tool", { name, arguments: input });
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
    const response = await this.postJson("/_questboard/mcp-proxy", { sessionId, message });
    if (response.status === 204) return null;
    return await response.json() as unknown;
  }

  private async postJson(pathname: string, body: unknown): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [DAEMON_CLIENT_HEADER]: "1",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw daemonUnavailable(this.baseUrl, error);
    }
    if (!response.ok) {
      throw new Error(`QuestBoard daemon request failed with HTTP ${response.status} at ${this.baseUrl}${pathname}`);
    }
    return response;
  }
}

export function resolveQuestBoardDaemonUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.QUESTBOARD_DAEMON_URL?.trim();
  if (configured) return normalizeDaemonUrl(configured);
  const port = env.QUESTBOARD_PORT === undefined
    ? DEFAULT_QUESTBOARD_PORT
    : parseQuestBoardPort(env.QUESTBOARD_PORT);
  return `http://127.0.0.1:${port}`;
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
