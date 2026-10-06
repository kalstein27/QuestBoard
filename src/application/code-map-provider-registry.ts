import {
  CODE_FIDELITY_LEVELS,
  normalizeCodeLanguage,
  type CodeFidelityLevel,
  type CodeGraphSnapshot,
  type CodeRelationKind,
} from "./code-intelligence.js";
import type { CodeMapPreflightReport } from "./code-map-preflight.js";

export const CODE_PROVIDER_HEALTH_STATES = ["ready", "missing_executable", "degraded"] as const;
export type CodeProviderHealthState = (typeof CODE_PROVIDER_HEALTH_STATES)[number];

export const CODE_MAP_HEALTH_STATES = ["healthy", "degraded"] as const;
export type CodeMapHealthState = (typeof CODE_MAP_HEALTH_STATES)[number];

export const CODE_SEMANTIC_COVERAGE_STATES = ["complete", "partial", "unavailable", "not_applicable"] as const;
export type CodeSemanticCoverageState = (typeof CODE_SEMANTIC_COVERAGE_STATES)[number];

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
  sourceType: "npm" | "composer";
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

export const CODE_PROVIDER_REQUIREMENTS = ["required", "not_needed", "unknown"] as const;
export type CodeProviderRequirement = (typeof CODE_PROVIDER_REQUIREMENTS)[number];

export const CODE_PROVIDER_REQUIREMENT_REASONS = [
  "detected_supported_language",
  "supported_language_not_detected",
  "language_inventory_unavailable",
] as const;
export type CodeProviderRequirementReason = (typeof CODE_PROVIDER_REQUIREMENT_REASONS)[number];

export interface CodeProviderProjectCapability extends CodeProviderRegistryEntry {
  requirement: CodeProviderRequirement;
  requirementReason: CodeProviderRequirementReason;
  matchingLanguages: readonly string[];
}

export interface CodeLanguageCapabilityReport {
  language: string;
  discoveredFileCount: number;
  eligibleFileCount: number | null;
  indexedFileCount: number;
  excludedFileCount: number;
  exclusionReason: "provider_project_scope" | null;
  symbolCount: number;
  fidelity: CodeFidelityLevel;
  providerIds: readonly string[];
  observedRelationKinds: readonly CodeRelationKind[];
  semanticCoverage: CodeSemanticCoverageState;
  gapReason: CodeLanguageGapReason | null;
  installOptions: readonly CodeProviderInstallOption[];
}

export interface CodeMapProviderCapabilityReport {
  providers: readonly CodeProviderProjectCapability[];
  languages: readonly CodeLanguageCapabilityReport[];
  indexed: boolean;
  health: CodeMapHealthState;
  semanticCoverage: CodeSemanticCoverageState | null;
  /** Backward-compatible alias for health === "degraded". */
  degraded: boolean;
}

export interface CodeProviderInstallRequest {
  projectId: string;
  provider: CodeProviderRegistryEntry;
  install: CodeProviderInstallOption;
  approvalRequired: true;
  executionBoundary: "external-host";
  executionAvailableInQuestBoard: false;
  indexingTriggered: false;
  nextAfterExternalInstall: {
    tool: "questboard_get_code_map_provider_capabilities";
    args: { projectId: string };
    reason: "verify_provider_availability_before_refresh";
  };
}

export class CodeProviderLifecycleError extends Error {
  constructor(
    readonly code:
      | "code_map_provider_unknown"
      | "code_map_provider_install_unavailable"
      | "code_map_provider_already_available"
      | "code_map_provider_not_needed"
      | "code_map_provider_requirement_unknown",
    message: string,
  ) {
    super(message);
    this.name = "CodeProviderLifecycleError";
  }
}

type ProviderStatusResolver = (definition: CodeProviderDefinition, rootPath?: string) => CodeProviderRuntimeStatus;

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

function semanticCoverageForLanguage(
  language: string,
  indexedFileCount: number,
  eligibleFileCount: number | null,
  symbolCount: number,
  gapReason: CodeLanguageGapReason | null,
): CodeSemanticCoverageState {
  if (language === "unknown") return "not_applicable";
  if (eligibleFileCount === 0) return "not_applicable";
  if (eligibleFileCount !== null) {
    if (indexedFileCount >= eligibleFileCount) return "complete";
    if (indexedFileCount > 0) return "partial";
    return "unavailable";
  }
  if (gapReason === "partial_coverage") return "partial";
  if (indexedFileCount > 0 || symbolCount > 0) return "complete";
  return "unavailable";
}

function summarizeSemanticCoverage(reports: readonly CodeLanguageCapabilityReport[]): CodeSemanticCoverageState {
  const applicable = reports.filter((entry) => entry.semanticCoverage !== "not_applicable");
  if (applicable.length === 0) return "not_applicable";
  if (applicable.every((entry) => entry.semanticCoverage === "complete")) return "complete";
  if (applicable.every((entry) => entry.semanticCoverage === "unavailable")) return "unavailable";
  return "partial";
}

function gapDegradesHealth(reason: CodeLanguageGapReason | null): boolean {
  return reason === "provider_missing" || reason === "provider_degraded" || reason === "partial_coverage";
}

function projectLanguages(
  graph: CodeGraphSnapshot | undefined,
  preflight: CodeMapPreflightReport | undefined,
): readonly string[] | undefined {
  if (preflight?.status === "ready") {
    return preflight.languages
      .filter((entry) => entry.discoveredFileCount > 0)
      .map((entry) => normalizeCodeLanguage(entry.language));
  }
  if (graph) {
    return [...new Set(graph.nodes
      .filter((node) => node.kind === "file")
      .map((node) => normalizeCodeLanguage(node.language))
      .filter((language) => language !== "unknown"))].sort();
  }
  return undefined;
}

function providerProjectCapability(
  provider: CodeProviderRegistryEntry,
  languages: readonly string[] | undefined,
): CodeProviderProjectCapability {
  if (!languages) {
    return {
      ...provider,
      requirement: "unknown",
      requirementReason: "language_inventory_unavailable",
      matchingLanguages: [],
    };
  }
  const supported = new Set(provider.languages.map((language) => normalizeCodeLanguage(language)));
  const matchingLanguages = languages.filter((language) => supported.has(language)).sort();
  if (matchingLanguages.length > 0) {
    return {
      ...provider,
      requirement: "required",
      requirementReason: "detected_supported_language",
      matchingLanguages,
    };
  }
  return {
    ...provider,
    requirement: "not_needed",
    requirementReason: "supported_language_not_detected",
    matchingLanguages: [],
  };
}

function preflightLanguageReports(
  preflight: CodeMapPreflightReport | undefined,
  providers: readonly CodeProviderProjectCapability[],
): CodeLanguageCapabilityReport[] {
  if (preflight?.status !== "ready") return [];

  const discovered = [
    ...preflight.languages.map((entry) => ({
      language: normalizeCodeLanguage(entry.language),
      discoveredFileCount: entry.discoveredFileCount,
    })),
    ...(preflight.unknownFileCount > 0
      ? [{ language: "unknown", discoveredFileCount: preflight.unknownFileCount }]
      : []),
  ].sort((left, right) => left.language.localeCompare(right.language));

  return discovered.map(({ language, discoveredFileCount }): CodeLanguageCapabilityReport => {
    const configuredForLanguage = providers.filter((provider) =>
      provider.configured && provider.languages.map(normalizeCodeLanguage).includes(language));
    const installOptions = providers
      .filter((provider) =>
        provider.languages.map(normalizeCodeLanguage).includes(language)
        && !provider.available
        && provider.installOption)
      .map((provider) => provider.installOption!);
    let gapReason: CodeLanguageGapReason | null = null;
    if (language === "unknown") {
      gapReason = null;
    } else if (configuredForLanguage.some((provider) => !provider.available)) {
      gapReason = "provider_missing";
    } else if (providers.some((provider) =>
      provider.languages.map(normalizeCodeLanguage).includes(language))) {
      gapReason = "file_only";
    } else {
      gapReason = "no_trusted_provider_available";
    }

    const eligibleFileCount = language === "unknown" ? 0 : null;
    return {
      language,
      discoveredFileCount,
      eligibleFileCount,
      indexedFileCount: 0,
      excludedFileCount: 0,
      exclusionReason: null,
      symbolCount: 0,
      fidelity: "file-only",
      providerIds: [],
      observedRelationKinds: [],
      semanticCoverage: semanticCoverageForLanguage(
        language,
        0,
        eligibleFileCount,
        0,
        gapReason,
      ),
      gapReason,
      installOptions,
    };
  });
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

  entries(rootPath?: string): CodeProviderRegistryEntry[] {
    return this.#definitions.map((definition) => ({ ...definition, ...publicProviderStatus(this.#statusResolver(definition, rootPath)) }));
  }

  report(
    graph?: CodeGraphSnapshot,
    rootPath?: string,
    preflight?: CodeMapPreflightReport,
  ): CodeMapProviderCapabilityReport {
    const projectLanguageInventory = projectLanguages(graph, preflight);
    const providers = this.entries(graph?.rootPath ?? rootPath)
      .map((provider) => providerProjectCapability(provider, projectLanguageInventory));
    if (!graph) {
      const reports = preflightLanguageReports(preflight, providers);
      const degraded = preflight?.status === "ready"
        ? reports.some((entry) => gapDegradesHealth(entry.gapReason))
        : providers.some((provider) => provider.configured && !provider.available);
      return {
        providers,
        languages: reports,
        indexed: false,
        health: degraded ? "degraded" : "healthy",
        semanticCoverage: null,
        degraded,
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
      const eligibleFileCount = graphCoverage?.semanticEligibleFileCount ?? null;
      const indexedFileCount = graphCoverage?.semanticIndexedFileCount ?? facts.indexedFilePaths.size;
      const excludedFileCount = graphCoverage?.semanticExcludedFileCount ?? 0;
      const fidelity = maxFidelity([
        facts.fidelity,
        graphCoverage?.fidelity ?? "file-only",
      ]);
      let gapReason: CodeLanguageGapReason | null = null;
      if (language === "unknown" || eligibleFileCount === 0) {
        gapReason = null;
      } else if (configuredForLanguage.some((provider) => !provider.available)) {
        gapReason = "provider_missing";
      } else if (graphCoverage?.degraded) {
        gapReason = "provider_degraded";
      } else if (facts.symbols.length === 0) {
        gapReason = providers.some((provider) => provider.languages.includes(language) && provider.installOption)
          ? "file_only"
          : "no_trusted_provider_available";
      } else if (indexedFileCount < (eligibleFileCount ?? facts.files.length)) {
        gapReason = "partial_coverage";
      }
      return {
        language,
        discoveredFileCount: facts.files.length,
        eligibleFileCount,
        indexedFileCount,
        excludedFileCount,
        exclusionReason: graphCoverage?.semanticExclusionReason ?? null,
        symbolCount: facts.symbols.length,
        fidelity,
        providerIds: facts.providerIds,
        observedRelationKinds: facts.relationKinds,
        semanticCoverage: semanticCoverageForLanguage(
          language,
          indexedFileCount,
          eligibleFileCount,
          facts.symbols.length,
          gapReason,
        ),
        gapReason,
        installOptions,
      };
    });

    const degraded = Boolean(graph.coverage?.degraded) || reports.some((entry) => gapDegradesHealth(entry.gapReason));

    return {
      providers,
      languages: reports,
      indexed: true,
      health: degraded ? "degraded" : "healthy",
      semanticCoverage: summarizeSemanticCoverage(reports),
      degraded,
    };
  }

  requestInstall(projectId: string, providerId: string, rootPath?: string): CodeProviderInstallRequest {
    const provider = this.entries(rootPath).find((entry) => entry.providerId === providerId);
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
      executionAvailableInQuestBoard: false,
      indexingTriggered: false,
      nextAfterExternalInstall: {
        tool: "questboard_get_code_map_provider_capabilities",
        args: { projectId },
        reason: "verify_provider_availability_before_refresh",
      },
    };
  }
}
