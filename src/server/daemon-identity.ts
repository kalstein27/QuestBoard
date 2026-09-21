import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const QUESTBOARD_DAEMON_PROTOCOL = "questboard-daemon-v2";
const LEGACY_QUESTBOARD_DAEMON_PROTOCOL = "questboard-daemon-v1";

export interface QuestBoardDaemonIdentity {
  protocol: typeof QUESTBOARD_DAEMON_PROTOCOL;
  databaseId: string;
  workspacePath: string;
  databasePath: string;
}

export function resolveQuestBoardIdentityPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.QUESTBOARD_IDENTITY_PATH?.trim();
  if (configured) return resolve(configured);
  const stateRoot = env.XDG_STATE_HOME?.trim()
    ? resolve(env.XDG_STATE_HOME)
    : join(homedir(), ".local", "state");
  return join(stateRoot, "questboard", "daemon-identity.json");
}

export function pinQuestBoardDaemonIdentity(
  identity: QuestBoardDaemonIdentity,
  identityPath = resolveQuestBoardIdentityPath(),
): QuestBoardDaemonIdentity {
  validateQuestBoardDaemonIdentity(identity, "requested daemon identity");
  mkdirSync(dirname(identityPath), { recursive: true });
  try {
    writeIdentity(identityPath, identity, "wx");
    return identity;
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }

  const existing = readIdentityObject(identityPath);
  if (isLegacyIdentity(existing)) {
    if (existing.databaseId !== identity.databaseId) {
      throw identityMismatch(
        `profile database ${existing.databaseId}`,
        `requested database ${identity.databaseId}`,
      );
    }
    writeIdentity(identityPath, identity, "w");
    return identity;
  }

  const pinned = parseCurrentIdentity(existing, identityPath);
  const mismatch = identityMismatchFields(pinned, identity);
  if (mismatch.length > 0) {
    throw identityMismatch(
      `profile ${formatIdentity(pinned)}`,
      `requested ${formatIdentity(identity)}`,
    );
  }
  return pinned;
}

export function readPinnedQuestBoardDaemonIdentity(
  identityPath = resolveQuestBoardIdentityPath(),
): QuestBoardDaemonIdentity {
  let existing: unknown;
  try {
    existing = readIdentityObject(identityPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new Error(
        "QuestBoard daemon identity is not pinned yet. Start the intended shared daemon with the current QuestBoard build before launching MCP/CLI clients.",
      );
    }
    throw error;
  }

  if (isLegacyIdentity(existing)) {
    throw new Error(
      `QuestBoard daemon identity profile still uses ${LEGACY_QUESTBOARD_DAEMON_PROTOCOL}. `
      + "Restart the intended shared daemon with the current QuestBoard build so the profile can be upgraded safely.",
    );
  }
  return parseCurrentIdentity(existing, identityPath);
}

function readIdentityObject(identityPath: string): unknown {
  try {
    return JSON.parse(readFileSync(identityPath, "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) throw error;
    throw new Error(`QuestBoard daemon identity file is invalid at ${identityPath}`);
  }
}

function parseCurrentIdentity(value: unknown, identityPath: string): QuestBoardDaemonIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`QuestBoard daemon identity file is invalid at ${identityPath}`);
  }
  const candidate = value as Record<string, unknown>;
  const identity: QuestBoardDaemonIdentity = {
    protocol: candidate.protocol as typeof QUESTBOARD_DAEMON_PROTOCOL,
    databaseId: candidate.databaseId as string,
    workspacePath: candidate.workspacePath as string,
    databasePath: candidate.databasePath as string,
  };
  try {
    validateQuestBoardDaemonIdentity(identity, `daemon identity file at ${identityPath}`);
  } catch {
    throw new Error(`QuestBoard daemon identity file is invalid at ${identityPath}`);
  }
  return identity;
}

function validateQuestBoardDaemonIdentity(identity: QuestBoardDaemonIdentity, label: string): void {
  if (
    identity.protocol !== QUESTBOARD_DAEMON_PROTOCOL
    || !identity.databaseId?.trim()
    || !identity.workspacePath?.trim()
    || !identity.databasePath?.trim()
    || !isAbsolute(identity.workspacePath)
    || !isAbsolute(identity.databasePath)
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function isLegacyIdentity(value: unknown): value is { protocol: typeof LEGACY_QUESTBOARD_DAEMON_PROTOCOL; databaseId: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.protocol === LEGACY_QUESTBOARD_DAEMON_PROTOCOL
    && typeof candidate.databaseId === "string"
    && candidate.databaseId.trim().length > 0;
}

function identityMismatchFields(
  pinned: QuestBoardDaemonIdentity,
  requested: QuestBoardDaemonIdentity,
): string[] {
  const fields: string[] = [];
  if (pinned.protocol !== requested.protocol) fields.push("protocol");
  if (pinned.databaseId !== requested.databaseId) fields.push("databaseId");
  if (pinned.workspacePath !== requested.workspacePath) fields.push("workspacePath");
  if (pinned.databasePath !== requested.databasePath) fields.push("databasePath");
  return fields;
}

function formatIdentity(identity: QuestBoardDaemonIdentity): string {
  return `database=${identity.databaseId}, workspace=${identity.workspacePath}, databasePath=${identity.databasePath}`;
}

function identityMismatch(pinned: string, requested: string): Error {
  return new Error(
    `QuestBoard daemon identity mismatch: ${pinned}; ${requested}. `
    + "Use the intended workspace/database, or set QUESTBOARD_IDENTITY_PATH to a separate profile for an intentionally separate QuestBoard instance.",
  );
}

function writeIdentity(
  identityPath: string,
  identity: QuestBoardDaemonIdentity,
  flag: "w" | "wx",
): void {
  writeFileSync(identityPath, `${JSON.stringify(identity)}\n`, { encoding: "utf8", flag, mode: 0o600 });
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}