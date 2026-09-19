import type { Server } from "node:http";
import { dirname, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { QuestBoardService } from "../application/quest-board-service.js";
import { createQuestBoardHttpServer } from "./http-api.js";
import { findTailscaleIpv4 } from "./network.js";

const LOCAL_HOST = "127.0.0.1";
export const DEFAULT_QUESTBOARD_PORT = 4317;

export interface QuestBoardHttpRuntimeOptions {
  port?: number;
  tailnetMode?: boolean;
  webRoot?: string;
  log?: (message: string) => void;
}

export interface QuestBoardHttpRuntime {
  server: Server;
  host: string;
  port: number;
  scope: "localhost" | "tailnet";
  url: string;
  close(): Promise<void>;
}

export async function startQuestBoardHttpRuntime(
  service: QuestBoardService,
  options: QuestBoardHttpRuntimeOptions = {},
): Promise<QuestBoardHttpRuntime> {
  const tailnetMode = options.tailnetMode ?? false;
  const host = tailnetMode ? requireTailscaleIpv4() : LOCAL_HOST;
  const requestedPort = options.port ?? parseQuestBoardPort(process.env.QUESTBOARD_PORT);
  validateListenPort(requestedPort);

  const webRoot = options.webRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../web");
  const server = createQuestBoardHttpServer(service, { webRoot });
  await listen(server, requestedPort, host);

  const address = server.address() as AddressInfo;
  const port = address.port;
  const scope = tailnetMode ? "tailnet" : "localhost";
  const url = `http://${host}:${port}`;
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
