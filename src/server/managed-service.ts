import { createServer, type Server } from "node:http";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import {
  QUESTBOARD_DAEMON_PROTOCOL,
  resolveQuestBoardIdentityPath,
  type QuestBoardDaemonIdentity,
} from "./daemon-identity.js";

export const QUESTBOARD_MANAGED_HEALTH_HOST = "127.0.0.1";
export const QUESTBOARD_MANAGED_HEALTH_PORT = 4318;

export interface QuestBoardRuntimePaths {
  databasePath: string;
  workspacePath: string;
  pinnedIdentity: QuestBoardDaemonIdentity | null;
}

export interface ManagedServiceHealthRuntime {
  server: Server;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

export function resolveQuestBoardRuntimePaths(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  managedServiceMode = false,
): QuestBoardRuntimePaths {
  const pinnedIdentity = managedServiceMode ? readManagedServicePinnedIdentity(env) : null;
  if (pinnedIdentity) {
    return {
      databasePath: pinnedIdentity.databasePath,
      workspacePath: pinnedIdentity.workspacePath,
      pinnedIdentity,
    };
  }

  const configuredDatabasePath = env.QUESTBOARD_DB_PATH?.trim();
  return {
    databasePath: configuredDatabasePath
      ? resolve(cwd, configuredDatabasePath)
      : resolve(cwd, ".questboard/questboard.sqlite"),
    workspacePath: realpathSync.native(cwd),
    pinnedIdentity: null,
  };
}

export function readManagedServicePinnedIdentity(
  env: NodeJS.ProcessEnv = process.env,
): QuestBoardDaemonIdentity | null {
  const identityPath = resolveQuestBoardIdentityPath(env);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(identityPath, "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw new Error(`QuestBoard daemon identity file is invalid at ${identityPath}`);
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`QuestBoard daemon identity file is invalid at ${identityPath}`);
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.protocol === "questboard-daemon-v1") {
    throw new Error(
      "QuestBoard managed service cannot recover canonical workspace/database paths from a legacy daemon identity. "
      + "Start the current QuestBoard daemon once to upgrade the profile before enabling managed service mode.",
    );
  }

  const identity: QuestBoardDaemonIdentity = {
    protocol: candidate.protocol as typeof QUESTBOARD_DAEMON_PROTOCOL,
    databaseId: candidate.databaseId as string,
    workspacePath: candidate.workspacePath as string,
    databasePath: candidate.databasePath as string,
  };
  if (
    identity.protocol !== QUESTBOARD_DAEMON_PROTOCOL
    || !identity.databaseId?.trim()
    || !identity.workspacePath?.trim()
    || !identity.databasePath?.trim()
    || !isAbsolute(identity.workspacePath)
    || !isAbsolute(identity.databasePath)
  ) {
    throw new Error(`QuestBoard daemon identity file is invalid at ${identityPath}`);
  }
  return identity;
}

export function parseManagedServiceHealthPort(value: string | undefined): number {
  if (value === undefined) return QUESTBOARD_MANAGED_HEALTH_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError("QUESTBOARD_MANAGED_HEALTH_PORT must be an integer between 1 and 65535");
  }
  return port;
}

export async function startManagedServiceHealthRuntime(
  isHealthy: () => boolean,
  options: { host?: string; port?: number } = {},
): Promise<ManagedServiceHealthRuntime> {
  const host = options.host ?? QUESTBOARD_MANAGED_HEALTH_HOST;
  const requestedPort = options.port ?? QUESTBOARD_MANAGED_HEALTH_PORT;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new TypeError("managed service health port must be an integer between 0 and 65535");
  }

  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method !== "GET" || pathname !== "/health") {
      response.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(`${JSON.stringify({ error: "not_found" })}\n`);
      return;
    }
    const healthy = isHealthy();
    response.writeHead(healthy ? 200 : 503, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(`${JSON.stringify({ status: healthy ? "ok" : "starting" })}\n`);
  });

  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(requestedPort, host, () => {
      server.off("error", onError);
      resolveListen();
    });
  });

  const address = server.address() as AddressInfo;
  const port = address.port;
  return {
    server,
    host,
    port,
    url: `http://${host}:${port}`,
    close: async () => {
      if (!server.listening) return;
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
    },
  };
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
