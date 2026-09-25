import { accessSync, constants, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { CodeMapService } from "../application/code-map-service.js";
import {
  GitNexusCodeIntelligenceProvider,
} from "../adapters/code-intelligence/gitnexus-provider.js";
import { ExecFileGitNexusCliRunner } from "../adapters/code-intelligence/gitnexus-indexer.js";
import {
  ExecFileScipProcessRunner,
  ScipTypeScriptCodeIntelligenceProvider,
} from "../adapters/code-intelligence/scip-provider.js";

export type QuestBoardCodeMapProvider = "gitnexus" | "scip-typescript";

export interface QuestBoardCodeMapConfig {
  provider: QuestBoardCodeMapProvider;
  executable: string;
  scipExecutable: string;
  storageRoot: string;
}

export type QuestBoardCodeMapUnavailableReason = "disabled" | "missing_executable";

export interface QuestBoardCodeMapAvailability {
  enabled: boolean;
  available: boolean;
  provider?: QuestBoardCodeMapProvider;
  reason?: QuestBoardCodeMapUnavailableReason;
  message?: string;
  missingExecutables?: readonly string[];
}

export interface QuestBoardCodeMapRuntime {
  service?: CodeMapService;
  availability: QuestBoardCodeMapAvailability;
}

export function resolveQuestBoardCodeMapConfig(
  env: NodeJS.ProcessEnv = process.env,
): QuestBoardCodeMapConfig | null {
  const enabled = env.QUESTBOARD_CODE_MAP?.trim().toLowerCase();
  if (enabled !== "1" && enabled !== "true") return null;

  const requestedProvider = env.QUESTBOARD_CODE_MAP_PROVIDER?.trim().toLowerCase() || "scip-typescript";
  if (requestedProvider !== "gitnexus" && requestedProvider !== "scip-typescript") {
    throw new TypeError(`Unsupported Code Map provider: ${requestedProvider}`);
  }
  const provider: QuestBoardCodeMapProvider = requestedProvider;
  const executable = provider === "scip-typescript"
    ? env.QUESTBOARD_SCIP_TYPESCRIPT_EXECUTABLE?.trim() || "scip-typescript"
    : env.QUESTBOARD_GITNEXUS_EXECUTABLE?.trim() || "gitnexus";
  const scipExecutable = env.QUESTBOARD_SCIP_EXECUTABLE?.trim() || "scip";
  const configuredStorageRoot = env.QUESTBOARD_CODE_MAP_STORAGE_ROOT?.trim();
  const dataHome = env.XDG_DATA_HOME?.trim()
    ? resolve(env.XDG_DATA_HOME.trim())
    : join(homedir(), ".local", "share");
  const storageRoot = configuredStorageRoot
    ? resolve(configuredStorageRoot)
    : join(dataHome, "questboard", "code-map");

  return { provider, executable, scipExecutable, storageRoot };
}

export function createConfiguredCodeMapService(
  env: NodeJS.ProcessEnv = process.env,
): CodeMapService | undefined {
  const config = resolveQuestBoardCodeMapConfig(env);
  if (!config) return undefined;

  mkdirSync(config.storageRoot, { recursive: true });
  if (config.provider === "scip-typescript") {
    const provider = new ScipTypeScriptCodeIntelligenceProvider(
      new ExecFileScipProcessRunner(),
      {
        storageRoot: config.storageRoot,
        indexerExecutable: config.executable,
        scipExecutable: config.scipExecutable,
      },
    );
    return new CodeMapService(provider);
  }

  const runner = new ExecFileGitNexusCliRunner({ executable: config.executable });
  const provider = new GitNexusCodeIntelligenceProvider(runner, {
    storageRoot: config.storageRoot,
  });
  return new CodeMapService(provider);
}

function executableCandidates(executable: string, env: NodeJS.ProcessEnv): string[] {
  if (isAbsolute(executable) || executable.includes("/") || executable.includes("\\")) {
    return [resolve(executable)];
  }
  const pathValue = env.PATH?.trim();
  if (!pathValue) return [];
  const extensions = process.platform === "win32"
    ? (env.PATHEXT?.trim() || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  return pathValue
    .split(delimiter)
    .filter(Boolean)
    .flatMap((directory) => extensions.map((extension) => join(directory, `${executable}${extension}`)));
}

export function findQuestBoardCodeMapExecutable(
  executable: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const candidate of executableCandidates(executable, env)) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH; missing tools make only Code Map unavailable.
    }
  }
  return undefined;
}

export function createConfiguredCodeMapRuntime(
  env: NodeJS.ProcessEnv = process.env,
): QuestBoardCodeMapRuntime {
  const config = resolveQuestBoardCodeMapConfig(env);
  if (!config) {
    return {
      availability: {
        enabled: false,
        available: false,
        reason: "disabled",
        message: "Code Map is not enabled for this QuestBoard runtime.",
      },
    };
  }

  const executable = findQuestBoardCodeMapExecutable(config.executable, env);
  const scipExecutable = config.provider === "scip-typescript"
    ? findQuestBoardCodeMapExecutable(config.scipExecutable, env)
    : undefined;
  const missingExecutables = [
    ...(!executable ? [config.executable] : []),
    ...(config.provider === "scip-typescript" && !scipExecutable ? [config.scipExecutable] : []),
  ];

  if (missingExecutables.length > 0) {
    const setup = config.provider === "scip-typescript"
      ? "Install scip-typescript and scip, add them to PATH, or set QUESTBOARD_SCIP_TYPESCRIPT_EXECUTABLE and QUESTBOARD_SCIP_EXECUTABLE."
      : "Install GitNexus, add it to PATH, or set QUESTBOARD_GITNEXUS_EXECUTABLE.";
    return {
      availability: {
        enabled: true,
        available: false,
        provider: config.provider,
        reason: "missing_executable",
        message: `${config.provider} Code Map is configured but required executable(s) were not found: ${missingExecutables.join(", ")}. ${setup}`,
        missingExecutables,
      },
    };
  }

  const resolvedEnv: NodeJS.ProcessEnv = {
    ...env,
    QUESTBOARD_CODE_MAP_PROVIDER: config.provider,
    ...(config.provider === "scip-typescript"
      ? {
          QUESTBOARD_SCIP_TYPESCRIPT_EXECUTABLE: executable,
          QUESTBOARD_SCIP_EXECUTABLE: scipExecutable,
        }
      : { QUESTBOARD_GITNEXUS_EXECUTABLE: executable }),
  };
  const service = createConfiguredCodeMapService(resolvedEnv);
  if (!service) throw new Error("Code Map runtime unexpectedly resolved without a service");
  return {
    service,
    availability: {
      enabled: true,
      available: true,
      provider: config.provider,
    },
  };
}
