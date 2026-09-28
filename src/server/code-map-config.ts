import { accessSync, constants, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { CodeFidelityLevel, CodeIntelligenceProvider } from "../application/code-intelligence.js";
import { CompositeCodeIntelligenceProvider } from "../application/composite-code-intelligence-provider.js";
import { CodeMapService } from "../application/code-map-service.js";
import { FileSystemCodeFileInventory } from "../adapters/code-intelligence/file-inventory.js";
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
  /** First configured provider retained for legacy diagnostics/config consumers. */
  provider: QuestBoardCodeMapProvider;
  executable: string;
  /** Present when the plural provider env is used. Provider order defines stable merge precedence. */
  providers?: readonly QuestBoardCodeMapProvider[];
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

function withProviderMetadata(
  provider: CodeIntelligenceProvider,
  metadata: { languages?: readonly string[]; fidelity: CodeFidelityLevel },
): CodeIntelligenceProvider {
  return {
    ...(provider.providerId ? { providerId: provider.providerId } : {}),
    ...(metadata.languages ? { languages: metadata.languages } : {}),
    fidelity: metadata.fidelity,
    capabilities: provider.capabilities,
    indexProject: (request) => provider.indexProject(request),
  };
}

function createCompositeService(
  providers: readonly CodeIntelligenceProvider[],
): CodeMapService {
  return new CodeMapService(
    new CompositeCodeIntelligenceProvider(
      providers,
      new FileSystemCodeFileInventory(),
    ),
  );
}

function providerMetadata(provider: QuestBoardCodeMapProvider): { languages?: readonly string[]; fidelity: CodeFidelityLevel } {
  return provider === "scip-typescript"
    ? { languages: ["typescript", "javascript"], fidelity: "semantic-call" }
    : { fidelity: "semantic-call" };
}

function semanticFactsProvider(
  service: CodeMapService,
  providerId: QuestBoardCodeMapProvider,
): CodeIntelligenceProvider {
  return withProviderMetadata(
    {
      providerId,
      capabilities: service.capabilities,
      async indexProject(request) {
        const graph = (await service.refresh(request)).graph;
        const nodes = graph.nodes.filter((node) =>
          node.provenance?.some((entry) => entry.providerId === providerId),
        );
        const nodeIds = new Set(nodes.map((node) => node.id));
        const relations = graph.relations.filter((relation) =>
          relation.provenance?.some((entry) => entry.providerId === providerId)
          && nodeIds.has(relation.from)
          && nodeIds.has(relation.to),
        );
        return {
          schemaVersion: graph.schemaVersion,
          projectId: graph.projectId,
          rootPath: graph.rootPath,
          indexedAt: graph.indexedAt,
          nodes,
          relations,
        };
      },
    },
    providerMetadata(providerId),
  );
}

function parseProvider(value: string): QuestBoardCodeMapProvider {
  const normalized = value.trim().toLowerCase();
  if (normalized !== "gitnexus" && normalized !== "scip-typescript") {
    throw new TypeError(`Unsupported Code Map provider: ${normalized || value}`);
  }
  return normalized;
}

function configuredProviderNames(env: NodeJS.ProcessEnv): { providers: QuestBoardCodeMapProvider[]; plural: boolean } {
  const pluralValue = env.QUESTBOARD_CODE_MAP_PROVIDERS?.trim();
  const rawProviders = pluralValue
    ? pluralValue.split(",").map((value) => value.trim()).filter(Boolean)
    : [env.QUESTBOARD_CODE_MAP_PROVIDER?.trim() || "scip-typescript"];
  if (rawProviders.length < 1) throw new TypeError("QUESTBOARD_CODE_MAP_PROVIDERS must include at least one provider");
  const providers = rawProviders.map(parseProvider);
  if (new Set(providers).size !== providers.length) {
    throw new TypeError("QUESTBOARD_CODE_MAP_PROVIDERS must not contain duplicate providers");
  }
  return { providers, plural: Boolean(pluralValue) };
}

function providerExecutable(
  provider: QuestBoardCodeMapProvider,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string {
  return provider === "scip-typescript"
    ? env.QUESTBOARD_SCIP_TYPESCRIPT_EXECUTABLE?.trim()
      || join(cwd, "node_modules", ".bin", process.platform === "win32" ? "scip-typescript.cmd" : "scip-typescript")
    : env.QUESTBOARD_GITNEXUS_EXECUTABLE?.trim() || "gitnexus";
}



export function withManagedServiceCodeMapDefault(
  env: NodeJS.ProcessEnv = process.env,
  managedServiceMode = false,
): NodeJS.ProcessEnv {
  if (!managedServiceMode || env.QUESTBOARD_CODE_MAP?.trim()) return env;
  return { ...env, QUESTBOARD_CODE_MAP: "1" };
}

export function resolveQuestBoardCodeMapConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): QuestBoardCodeMapConfig | null {
  const enabled = env.QUESTBOARD_CODE_MAP?.trim().toLowerCase();
  if (enabled !== "1" && enabled !== "true") return null;

  const configured = configuredProviderNames(env);
  const provider = configured.providers[0]!;
  const executable = providerExecutable(provider, env, cwd);
  const configuredStorageRoot = env.QUESTBOARD_CODE_MAP_STORAGE_ROOT?.trim();
  const dataHome = env.XDG_DATA_HOME?.trim()
    ? resolve(env.XDG_DATA_HOME.trim())
    : join(homedir(), ".local", "share");
  const storageRoot = configuredStorageRoot
    ? resolve(configuredStorageRoot)
    : join(dataHome, "questboard", "code-map");

  return {
    provider,
    executable,
    ...(configured.plural ? { providers: configured.providers } : {}),
    storageRoot,
  };
}

export function createConfiguredCodeMapService(
  env: NodeJS.ProcessEnv = process.env,
): CodeMapService | undefined {
  const config = resolveQuestBoardCodeMapConfig(env);
  if (!config) return undefined;

  mkdirSync(config.storageRoot, { recursive: true });
  const configuredProviders = config.providers ?? [config.provider];
  if (configuredProviders.length > 1) {
    const semanticProviders = configuredProviders.map((providerId) => {
      const childEnv: NodeJS.ProcessEnv = { ...env };
      delete childEnv.QUESTBOARD_CODE_MAP_PROVIDERS;
      childEnv.QUESTBOARD_CODE_MAP = "1";
      childEnv.QUESTBOARD_CODE_MAP_PROVIDER = providerId;
      const childService = createConfiguredCodeMapService(childEnv);
      if (!childService) throw new Error(`Code Map provider ${providerId} unexpectedly resolved without a service`);
      return semanticFactsProvider(childService, providerId);
    });
    return createCompositeService(semanticProviders);
  }

  if (config.provider === "scip-typescript") {
    const provider = new ScipTypeScriptCodeIntelligenceProvider(
      new ExecFileScipProcessRunner(),
      {
        storageRoot: config.storageRoot,
        indexerExecutable: config.executable,
      },
    );
    return createCompositeService([
      withProviderMetadata(provider, {
        languages: ["typescript", "javascript"],
        fidelity: "semantic-call",
      }),
    ]);
  }

  const runner = new ExecFileGitNexusCliRunner({ executable: config.executable });
  const provider = new GitNexusCodeIntelligenceProvider(runner, {
    storageRoot: config.storageRoot,
  });
  return createCompositeService([
    withProviderMetadata(provider, { fidelity: "semantic-call" }),
  ]);
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

  const configuredProviders = config.providers ?? [config.provider];
  const resolvedProviders = configuredProviders.map((provider) => {
    const requestedExecutable = providerExecutable(provider, env, process.cwd());
    return {
      provider,
      requestedExecutable,
      executable: findQuestBoardCodeMapExecutable(requestedExecutable, env),
    };
  });
  const missingExecutables = resolvedProviders
    .filter((entry) => !entry.executable)
    .map((entry) => entry.requestedExecutable);
  const activeProviders = resolvedProviders.filter(
    (entry): entry is typeof entry & { executable: string } => Boolean(entry.executable),
  );

  let service: CodeMapService;
  if (activeProviders.length === 0) {
    service = createCompositeService([]);
  } else {
    const resolvedEnv: NodeJS.ProcessEnv = {
      ...env,
      QUESTBOARD_CODE_MAP: "1",
      QUESTBOARD_CODE_MAP_STORAGE_ROOT: config.storageRoot,
    };
    if (activeProviders.length > 1) {
      resolvedEnv.QUESTBOARD_CODE_MAP_PROVIDERS = activeProviders.map((entry) => entry.provider).join(",");
      delete resolvedEnv.QUESTBOARD_CODE_MAP_PROVIDER;
    } else {
      delete resolvedEnv.QUESTBOARD_CODE_MAP_PROVIDERS;
      resolvedEnv.QUESTBOARD_CODE_MAP_PROVIDER = activeProviders[0]!.provider;
    }
    for (const entry of activeProviders) {
      if (entry.provider === "scip-typescript") {
        resolvedEnv.QUESTBOARD_SCIP_TYPESCRIPT_EXECUTABLE = entry.executable;
      } else {
        resolvedEnv.QUESTBOARD_GITNEXUS_EXECUTABLE = entry.executable;
      }
    }
    const configuredService = createConfiguredCodeMapService(resolvedEnv);
    if (!configuredService) throw new Error("Code Map runtime unexpectedly resolved without a service");
    service = configuredService;
  }

  return {
    service,
    availability: {
      enabled: true,
      available: true,
      provider: config.provider,
      ...(missingExecutables.length > 0
        ? {
            reason: "missing_executable" as const,
            message: `Some configured semantic indexing executables were not found: ${missingExecutables.join(", ")}. Code Map remains available at ${activeProviders.length > 0 ? "semantic fidelity from the remaining providers plus " : ""}file-only fidelity from repository inventory.`,
            missingExecutables,
          }
        : {}),
    },
  };
}
