import {
  CODE_FIDELITY_LEVELS,
  normalizeCodeLanguage,
  type CodeFidelityLevel,
  type CodeGraphSnapshot,
  type CodeRelationKind,
} from "./code-intelligence.js";

export const CODE_PROVIDER_HEALTH_STATES = ["ready", "missing_executable", "degraded"] as const;
export type CodeProviderHealthState = (typeof CODE_PROVIDER_HEALTH_STATES)[number];

export const CODE_LANGUAGE_GAP_REASONS = [
  "provider_missing",
  "provider_degraded",
  "file_only",
  "partial_coverage",
  "no_trusted_provider_available",
] as const;
export type CodeLanguageGapReason = (typeof CODE_LANGUAGE_GAP_REASONS)[number];

export interface CodeProviderInstallOption {
  providerId: string;
  sourceType: "npm";
  source: string;
  version: string;
  executable: string;
  trust: "project-pinned";
  requiresApproval: true;
  executionBoundary: "external-host";
  permissions: readonly string[];
  reindexMode: "full";
}

export interface CodeProviderDefinition {
  providerId: string;
  languages: readonly string[];
  fidelity: CodeFidelityLevel;
  version: string | null;
  installOption?: CodeProviderInstallOption;
}

export interface CodeProviderRuntimeStatus {
  configured: boolean;
  installed: boolean;
  available: boolean;
  executable: string | null;
  health: CodeProviderHealthState;
  diagnostics: readonly string[];
}

export interface CodeProviderRegistryEntry extends CodeProviderDefinition, CodeProviderRuntimeStatus {}

export interface CodeLanguageCapabilityReport {
  language: string;
  discoveredFileCount: number;
  indexedFileCount: number;
  symbolCount: number;
  fidelity: CodeFidelityLevel;
  providerIds: readonly string[];
  observedRelationKinds: readonly CodeRelationKind[];
  gapReason: CodeLanguageGapReason | null;
  installOptions: readonly CodeProviderInstallOption[];
}

export interface CodeMapProviderCapabilityReport {
  providers: readonly CodeProviderRegistryEntry[];
  languages: readonly CodeLanguageCapabilityReport[];
  indexed: boolean;
  degraded: boolean;
}

export interface CodeProviderInstallRequest {
  projectId: string;
  provider: CodeProviderRegistryEntry;
  install: CodeProviderInstallOption;
  approvalRequired: true;
  executionBoundary: "external-host";
  indexingTriggered: false;
}

export class CodeProviderLifecycleError extends Error {
  constructor(
    readonly code: "code_map_provider_unknown" | "code_map_provider_install_unavailable" | "code_map_provider_already_available",
    message: string,
  ) {
    super(message);
    this.name = "CodeProviderLifecycleError";
  }
}

type ProviderStatusResolver = (definition: CodeProviderDefinition) => CodeProviderRuntimeStatus;

function fidelityRank(value: CodeFidelityLevel): number {
  return CODE_FIDELITY_LEVELS.indexOf(value);
}

function maxFidelity(values: readonly CodeFidelityLevel[]): CodeFidelityLevel {
  return values.reduce<CodeFidelityLevel>(
    (best, value) => fidelityRank(value) > fidelityRank(best) ? value : best,
    "file-only",
  );
}

export function codeProviderExecutableLabel(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? normalized;
}

function publicProviderStatus(status: CodeProviderRuntimeStatus): CodeProviderRuntimeStatus {
  const executable = codeProviderExecutableLabel(status.executable);
  const diagnostics = status.executable
    ? status.diagnostics.map((entry) => entry.split(status.executable!).join(executable ?? "configured executable"))
    : [...status.diagnostics];
  return { ...status, executable, diagnostics };
}

function languageFacts(graph: CodeGraphSnapshot, language: string) {
  const files = graph.nodes.filter((node) => node.kind === "file" && normalizeCodeLanguage(node.language) === language);
  const filePaths = new Set(files.map((node) => node.location?.path).filter((path): path is string => Boolean(path)));
  const symbols = graph.nodes.filter((node) =>
    node.kind !== "file"
    && normalizeCodeLanguage(node.language) === language
    && (!node.location?.path || filePaths.has(node.location.path)),
  );
  const indexedFilePaths = new Set(symbols.map((node) => node.location?.path).filter((path): path is string => Boolean(path)));
  const nodeIds = new Set(graph.nodes
    .filter((node) => normalizeCodeLanguage(node.language) === language)
    .map((node) => node.id));
  const relationKinds = [...new Set(graph.relations
    .filter((relation) => nodeIds.has(relation.from) || nodeIds.has(relation.to))
    .map((relation) => relation.kind))].sort();
  const provenance = [...files, ...symbols].flatMap((node) => node.provenance ?? []);
  const providerIds = [...new Set(provenance
    .map((entry) => entry.providerId)
    .filter((id) => id !== "file-inventory" && !id.startsWith("questboard:file-")))].sort();
  const fidelity = maxFidelity(provenance.map((entry) => entry.fidelity ?? "file-only"));
  return { files, symbols, indexedFilePaths, relationKinds, providerIds, fidelity };
}

export class CodeMapProviderRegistry {
  readonly #definitions: readonly CodeProviderDefinition[];
  readonly #statusResolver: ProviderStatusResolver;

  constructor(definitions: readonly CodeProviderDefinition[], statusResolver: ProviderStatusResolver) {
    const ids = definitions.map((entry) => entry.providerId);
    if (new Set(ids).size !== ids.length) throw new TypeError("Code provider registry ids must be unique");
    this.#definitions = definitions.map((entry) => ({ ...entry, languages: [...entry.languages] }));
    this.#statusResolver = statusResolver;
  }

  entries(): CodeProviderRegistryEntry[] {
    return this.#definitions.map((definition) => ({ ...definition, ...publicProviderStatus(this.#statusResolver(definition)) }));
  }

  report(graph?: CodeGraphSnapshot): CodeMapProviderCapabilityReport {
    const providers = this.entries();
    if (!graph) {
      return {
        providers,
        languages: [],
        indexed: false,
        degraded: providers.some((provider) => provider.configured && !provider.available),
      };
    }

    const languages = [...new Set(graph.nodes
      .filter((node) => node.kind === "file")
      .map((node) => normalizeCodeLanguage(node.language)))].sort();
    const reports = languages.map((language): CodeLanguageCapabilityReport => {
      const facts = languageFacts(graph, language);
      const configuredForLanguage = providers.filter((provider) =>
        provider.configured && provider.languages.includes(language));
      const installOptions = providers
        .filter((provider) => provider.languages.includes(language) && !provider.available && provider.installOption)
        .map((provider) => provider.installOption!);
      const graphCoverage = graph.coverage?.languages.find((entry) => entry.language === language);
      const fidelity = maxFidelity([
        facts.fidelity,
        graphCoverage?.fidelity ?? "file-only",
      ]);
      let gapReason: CodeLanguageGapReason | null = null;
      if (configuredForLanguage.some((provider) => !provider.available)) {
        gapReason = "provider_missing";
      } else if (graphCoverage?.degraded) {
        gapReason = "provider_degraded";
      } else if (facts.symbols.length === 0) {
        gapReason = providers.some((provider) => provider.languages.includes(language) && provider.installOption)
          ? "file_only"
          : "no_trusted_provider_available";
      } else if (facts.indexedFilePaths.size < facts.files.length) {
        gapReason = "partial_coverage";
      }
      return {
        language,
        discoveredFileCount: facts.files.length,
        indexedFileCount: facts.indexedFilePaths.size,
        symbolCount: facts.symbols.length,
        fidelity,
        providerIds: facts.providerIds,
        observedRelationKinds: facts.relationKinds,
        gapReason,
        installOptions,
      };
    });

    return {
      providers,
      languages: reports,
      indexed: true,
      degraded: Boolean(graph.coverage?.degraded) || reports.some((entry) => entry.gapReason !== null),
    };
  }

  requestInstall(projectId: string, providerId: string): CodeProviderInstallRequest {
    const provider = this.entries().find((entry) => entry.providerId === providerId);
    if (!provider) {
      throw new CodeProviderLifecycleError("code_map_provider_unknown", `Unknown Code Map provider: ${providerId}`);
    }
    if (provider.available) {
      throw new CodeProviderLifecycleError(
        "code_map_provider_already_available",
        `Code Map provider ${providerId} is already available`,
      );
    }
    if (!provider.installOption) {
      throw new CodeProviderLifecycleError(
        "code_map_provider_install_unavailable",
        `Code Map provider ${providerId} has no trusted install option`,
      );
    }
    return {
      projectId,
      provider,
      install: provider.installOption,
      approvalRequired: true,
      executionBoundary: "external-host",
      indexingTriggered: false,
    };
  }
}
