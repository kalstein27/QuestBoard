import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { CodeFidelityLevel, CodeIntelligenceProvider } from "../application/code-intelligence.js";
import { CodeMapProviderRegistry, codeProviderExecutableLabel, type CodeProviderDefinition } from "../application/code-map-provider-registry.js";
import { CompositeCodeIntelligenceProvider } from "../application/composite-code-intelligence-provider.js";
import { CodeMapService } from "../application/code-map-service.js";
import type { CodeMapManualRelationReader } from "../application/code-map-augmentation.js";
import { FileSystemCodeFileInventory } from "../adapters/code-intelligence/file-inventory.js";
import { ScipPhpProvider } from "../adapters/code-intelligence/scip-php-provider.js";
import {
  ExecFileScipProcessRunner,
  ScipTypeScriptCodeIntelligenceProvider,
} from "../adapters/code-intelligence/scip-provider.js";
import { createHash } from "node:crypto";
import type { CodeMapPersistenceConfig } from "../application/code-map-persistence.js";
import type { QuestBoardRepository } from "../application/quest-board-repository.js";
import {
  FileSystemCodeMapPersistedSnapshotStore,
  FileSystemCodeMapSourceStateProvider,
} from "../adapters/code-intelligence/code-map-persistence.js";
import { assertCodeMapStorageRootOutsideProject } from "../adapters/code-intelligence/code-map-persistence.js";

export type QuestBoardCodeMapProvider = "scip-php" | "scip-typescript";

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
  storageRoot?: string,
): CodeIntelligenceProvider {
  return {
    ...(provider.providerId ? { providerId: provider.providerId } : {}),
    ...(metadata.languages ? { languages: metadata.languages } : {}),
    fidelity: metadata.fidelity,
    capabilities: provider.capabilities,
    indexProject: (request) => {
      if (storageRoot) assertCodeMapStorageRootOutsideProject(storageRoot, request.rootPath);
      return provider.indexProject(request);
    },
  };
}

function createCompositeService(
  providers: readonly CodeIntelligenceProvider[],
  providerRegistry?: CodeMapProviderRegistry,
  manualRelations?: CodeMapManualRelationReader,
  persistence?: CodeMapPersistenceConfig,
): CodeMapService {
  return new CodeMapService(
    new CompositeCodeIntelligenceProvider(
      providers,
      new FileSystemCodeFileInventory(),
    ),
    undefined,
    providerRegistry,
    manualRelations,
    persistence,
    new FileSystemCodeFileInventory(),
  );
}

function providerMetadata(provider: QuestBoardCodeMapProvider): { languages?: readonly string[]; fidelity: CodeFidelityLevel } {
  return provider === "scip-typescript"
    ? { languages: ["typescript", "javascript"], fidelity: "semantic-call" }
    : { languages: ["php"], fidelity: "semantic-call" };
}

export function semanticFactsProvider(
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
        const providerRuns = graph.providerRuns?.filter((run) => run.providerId === providerId);
        return {
          schemaVersion: graph.schemaVersion,
          projectId: graph.projectId,
          rootPath: graph.rootPath,
          indexedAt: graph.indexedAt,
          nodes,
          relations,
          ...(providerRuns?.length ? { providerRuns } : {}),
          ...(graph.coverage ? { coverage: graph.coverage } : {}),
        };
      },
    },
    providerMetadata(providerId),
  );
}

function parseProvider(value: string): QuestBoardCodeMapProvider {
  const normalized = value.trim().toLowerCase();
  if (normalized !== "scip-php" && normalized !== "scip-typescript") {
    throw new TypeError(`Unsupported Code Map provider: ${normalized || value}`);
  }
  return normalized;
}

function configuredProviderNames(env: NodeJS.ProcessEnv): { providers: QuestBoardCodeMapProvider[]; plural: boolean } {
  const pluralValue = env.QUESTBOARD_CODE_MAP_PROVIDERS?.trim();
  const singleValue = env.QUESTBOARD_CODE_MAP_PROVIDER?.trim();
  const rawProviders = pluralValue
    ? pluralValue.split(",").map((value) => value.trim()).filter(Boolean)
    : singleValue
      ? [singleValue]
      : ["scip-typescript", "scip-php"];
  if (rawProviders.length < 1) throw new TypeError("QUESTBOARD_CODE_MAP_PROVIDERS must include at least one provider");
  const providers = rawProviders.map(parseProvider);
  if (new Set(providers).size !== providers.length) {
    throw new TypeError("QUESTBOARD_CODE_MAP_PROVIDERS must not contain duplicate providers");
  }
  return { providers, plural: Boolean(pluralValue) || !singleValue };
}

function providerExecutable(
  provider: QuestBoardCodeMapProvider,
  env: NodeJS.ProcessEnv,
  cwd: string,
  rootPath?: string,
): string {
  return provider === "scip-typescript"
    ? env.QUESTBOARD_SCIP_TYPESCRIPT_EXECUTABLE?.trim()
      || join(cwd, "node_modules", ".bin", process.platform === "win32" ? "scip-typescript.cmd" : "scip-typescript")
    : env.QUESTBOARD_SCIP_PHP_EXECUTABLE?.trim()
      || (rootPath
        ? join(rootPath, "vendor", "bin", process.platform === "win32" ? "scip-php.bat" : "scip-php")
        : "vendor/bin/scip-php");
}

const CODE_MAP_PROVIDER_DEFINITIONS: readonly CodeProviderDefinition[] = [
  {
    providerId: "scip-typescript",
    languages: ["typescript", "javascript"],
    fidelity: "semantic-call",
    version: "0.4.0",
    installOption: {
      providerId: "scip-typescript",
      sourceType: "npm",
      source: "@sourcegraph/scip-typescript",
      version: "0.4.0",
      executable: "scip-typescript",
      trust: "project-pinned",
      requiresApproval: true,
      executionBoundary: "external-host",
      permissions: ["network", "project-dependency-install"],
      reindexMode: "full",
    },
  },
  {
    providerId: "scip-php",
    languages: ["php"],
    fidelity: "semantic-call",
    version: "dev-main#71a5b117ec4c5dd2af302e363410e604e5df309e",
    installOption: {
      providerId: "scip-php",
      sourceType: "composer",
      source: "davidrjenni/scip-php",
      version: "dev-main#71a5b117ec4c5dd2af302e363410e604e5df309e",
      executable: "vendor/bin/scip-php",
      trust: "project-pinned",
      requiresApproval: true,
      executionBoundary: "external-host",
      permissions: ["network", "project-dependency-install"],
      reindexMode: "full",
    },
  },
];

function codeMapProviderContractFingerprint(config: QuestBoardCodeMapConfig): string {
  const configured = config.providers ?? [config.provider];
  const contract = configured.map((providerId) => {
    const definition = CODE_MAP_PROVIDER_DEFINITIONS.find((entry) => entry.providerId === providerId);
    if (!definition) throw new Error(`Missing Code Map provider definition for ${providerId}`);
    return {
      providerId: definition.providerId,
      languages: [...definition.languages],
      fidelity: definition.fidelity,
      version: definition.version,
    };
  });
  return createHash("sha256").update(JSON.stringify(contract)).digest("hex");
}

function configuredCodeMapPersistence(
  config: QuestBoardCodeMapConfig,
  projectReader?: CodeMapManualRelationReader,
): CodeMapPersistenceConfig {
  const candidate = projectReader as (CodeMapManualRelationReader & Partial<Pick<QuestBoardRepository, "getProject">>) | undefined;
  const getProject = candidate?.getProject;
  return {
    store: new FileSystemCodeMapPersistedSnapshotStore(config.storageRoot),
    sourceState: new FileSystemCodeMapSourceStateProvider(),
    providerConfigFingerprint: codeMapProviderContractFingerprint(config),
    validateStorageRootForProject: (rootPath: string) => assertCodeMapStorageRootOutsideProject(config.storageRoot, rootPath),
    ...(getProject
      ? { rootPathForProject: (projectId: string) => getProject.call(candidate, projectId)?.rootPath }
      : {}),
  };
}

export function createQuestBoardCodeMapProviderRegistry(
  config: QuestBoardCodeMapConfig,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): CodeMapProviderRegistry {
  const configured = new Set(config.providers ?? [config.provider]);
  return new CodeMapProviderRegistry(CODE_MAP_PROVIDER_DEFINITIONS, (definition, rootPath) => {
    const provider = definition.providerId as QuestBoardCodeMapProvider;
    const requestedExecutable = providerExecutable(provider, env, cwd, rootPath);
    const executable = findQuestBoardCodeMapExecutable(requestedExecutable, env);
    return {
      configured: configured.has(provider),
      installed: Boolean(executable),
      available: Boolean(executable),
      executable: executable ?? requestedExecutable,
      health: executable ? "ready" : "missing_executable",
      diagnostics: executable ? [] : [`Executable not found: ${requestedExecutable}`],
    };
  });
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
  providerRegistryOverride?: CodeMapProviderRegistry,
  manualRelations?: CodeMapManualRelationReader,
  persistence?: CodeMapPersistenceConfig,
): CodeMapService | undefined {
  const config = resolveQuestBoardCodeMapConfig(env);
  if (!config) return undefined;
  const providerRegistry = providerRegistryOverride ?? createQuestBoardCodeMapProviderRegistry(config, env);

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
    return createCompositeService(semanticProviders, providerRegistry, manualRelations, persistence);
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
      }, config.storageRoot),
    ], providerRegistry, manualRelations, persistence);
  }

  const provider = new ScipPhpProvider(new ExecFileScipProcessRunner(), {
    storageRoot: config.storageRoot,
    ...(env.QUESTBOARD_SCIP_PHP_EXECUTABLE?.trim()
      ? { indexerExecutable: env.QUESTBOARD_SCIP_PHP_EXECUTABLE.trim() }
      : {}),
  });
  return createCompositeService([
    withProviderMetadata(provider, { languages: ["php"], fidelity: "semantic-call" }, config.storageRoot),
  ], providerRegistry, manualRelations, persistence);
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
  manualRelations?: CodeMapManualRelationReader,
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

  const persistence = configuredCodeMapPersistence(config, manualRelations);

  const configuredProviders = config.providers ?? [config.provider];
  const providerRegistry = createQuestBoardCodeMapProviderRegistry(config, env);
  const resolvedProviders = configuredProviders.map((provider) => {
    const requestedExecutable = providerExecutable(provider, env, process.cwd());
    const executable = findQuestBoardCodeMapExecutable(requestedExecutable, env);
    const projectLocal = provider === "scip-php" && !env.QUESTBOARD_SCIP_PHP_EXECUTABLE?.trim();
    return { provider, requestedExecutable, executable, projectLocal };
  });
  const missingExecutables = resolvedProviders
    .filter((entry) => !entry.executable && !entry.projectLocal)
    .map((entry) => codeProviderExecutableLabel(entry.requestedExecutable) ?? "configured executable");
  const activeProviders = resolvedProviders.filter((entry) => Boolean(entry.executable) || entry.projectLocal);

  let service: CodeMapService;
  if (activeProviders.length === 0) {
    service = createCompositeService([], providerRegistry, manualRelations, persistence);
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
      if (entry.provider === "scip-typescript" && entry.executable) {
        resolvedEnv.QUESTBOARD_SCIP_TYPESCRIPT_EXECUTABLE = entry.executable;
      } else if (entry.provider === "scip-php") {
        resolvedEnv.QUESTBOARD_SCIP_PHP_EXECUTABLE = entry.executable ?? entry.requestedExecutable;
      }
    }
    const configuredService = createConfiguredCodeMapService(resolvedEnv, providerRegistry, manualRelations, persistence);
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
