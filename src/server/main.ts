import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { QuestBoardService } from "../application/quest-board-service.js";
import { createStderrConcurrencyDiagnosticSink } from "../observability/concurrency-log.js";
import { SqliteQuestBoardRepository } from "../storage/sqlite/sqlite-quest-board-repository.js";
import { createQuestBoardHttpServer } from "./http-api.js";
import { findTailscaleIpv4 } from "./network.js";

const LOCAL_HOST = "127.0.0.1";
const DEFAULT_PORT = 4317;

const configuredDatabasePath = process.env.QUESTBOARD_DB_PATH;
const databasePath = configuredDatabasePath
  ? resolve(configuredDatabasePath)
  : resolve(".questboard/questboard.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });

const repository = new SqliteQuestBoardRepository(databasePath);
const service = new QuestBoardService(repository, undefined, undefined, createStderrConcurrencyDiagnosticSink());
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../web");
const server = createQuestBoardHttpServer(service, { webRoot });
const port = parsePort(process.env.QUESTBOARD_PORT);
const tailnetMode = process.argv.includes("--tailnet") || process.env.QUESTBOARD_TAILNET === "1";
const host = tailnetMode ? requireTailscaleIpv4() : LOCAL_HOST;

server.listen(port, host, () => {
  const scope = tailnetMode ? "tailnet" : "localhost";
  console.log(`QuestBoard listening on http://${host}:${port} (${scope})`);
});

let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  server.close(() => {
    repository.close();
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError("QUESTBOARD_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function requireTailscaleIpv4(): string {
  const address = findTailscaleIpv4();
  if (!address) {
    throw new Error("No active Tailscale IPv4 address was found. Connect Tailscale before using --tailnet.");
  }
  return address;
}