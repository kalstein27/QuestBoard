import type { Server } from "node:http";
import { dirname, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { QuestBoardService } from "../application/quest-board-service.js";
import type { QuestBoardDaemonIdentity } from "./daemon-identity.js";
import { createQuestBoardHttpServer } from "./http-api.js";
import { findTailscaleIpv4 } from "./network.js";

const LOCAL_HOST = "127.0.0.1";
export const DEFAULT_QUESTBOARD_PORT = 4317;

export interface QuestBoardHttpRuntimeOptions {
  port?: number;
  host?: string;
  tailnetMode?: boolean;
  webRoot?: string;
  daemonIdentity?: QuestBoardDaemonIdentity;
  log?: (message: string) => void;
}

export interface QuestBoardHttpRuntime {
  server: Server;
  host: string;
  port: number;
  scope: "localhost" | "network" | "tailnet";
  url: string;
  close(): Promise<void>;
}

export async function startQuestBoardHttpRuntime(
  service: QuestBoardService,
  options: QuestBoardHttpRuntimeOptions = {},
): Promise<QuestBoardHttpRuntime> {
  const tailnetMode = options.tailnetMode ?? false;
  const configuredHost = options.host ?? process.env.QUESTBOARD_HOST;
  const host = tailnetMode ? requireTailscaleIpv4() : parseQuestBoardHost(configuredHost);
  const requestedPort = options.port ?? parseQuestBoardPort(process.env.QUESTBOARD_PORT);
  validateListenPort(requestedPort);

  const webRoot = options.webRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../web");
  const server = createQuestBoardHttpServer(service, {
    webRoot,
    ...(options.daemonIdentity ? { daemonIdentity: options.daemonIdentity } : {}),
  });
  await listen(server, requestedPort, host);

  const address = server.address() as AddressInfo;
  const port = address.port;
  const scope = tailnetMode ? "tailnet" : isLoopbackHost(host) ? "localhost" : "network";
  const url = `http://${formatHostForUrl(host)}:${port}`;
  options.log?.(`QuestBoard Web/API listening on ${url} (${scope})`);

  return {
    server,
    host,
    port,
    scope,
    url,
    close: () => closeServer(server),
  };
}

export function parseQuestBoardPort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_QUESTBOARD_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError("QUESTBOARD_PORT must be an integer between 1 and 65535");
  }
  return port;
}

export function parseQuestBoardHost(value: string | undefined): string {
  if (value === undefined) return LOCAL_HOST;
  const host = value.trim();
  if (!host) throw new TypeError("QUESTBOARD_HOST must not be empty");
  return host;
}

function validateListenPort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError("QuestBoard listen port must be an integer between 0 and 65535");
  }
}

function requireTailscaleIpv4(): string {
  const address = findTailscaleIpv4();
  if (!address) {
    throw new Error("No active Tailscale IPv4 address was found. Connect Tailscale before using Tailnet mode.");
  }
  return address;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

async function listen(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
