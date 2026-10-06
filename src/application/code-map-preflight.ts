import { normalizeCodeLanguage } from "./code-intelligence.js";
import {
  inferCodeLanguageFromPath,
  type CodeFileInventory,
} from "./code-map-hierarchy.js";

export const CODE_MAP_PREFLIGHT_STATUSES = ["ready", "unavailable"] as const;
export type CodeMapPreflightStatus = (typeof CODE_MAP_PREFLIGHT_STATUSES)[number];

export const CODE_MAP_PREFLIGHT_UNAVAILABLE_REASONS = [
  "root_path_unavailable",
  "inventory_unavailable",
  "inventory_failed",
] as const;
export type CodeMapPreflightUnavailableReason =
  (typeof CODE_MAP_PREFLIGHT_UNAVAILABLE_REASONS)[number];

export interface CodeMapPreflightLanguage {
  language: string;
  discoveredFileCount: number;
}

export interface CodeMapPreflightReport {
  status: CodeMapPreflightStatus;
  rootPathConfigured: boolean;
  inventoryAvailable: boolean;
  totalFileCount: number;
  recognizedFileCount: number;
  unknownFileCount: number;
  languages: readonly CodeMapPreflightLanguage[];
  unavailableReason?: CodeMapPreflightUnavailableReason;
}

function unavailablePreflight(
  reason: CodeMapPreflightUnavailableReason,
  rootPathConfigured: boolean,
  inventoryAvailable: boolean,
): CodeMapPreflightReport {
  return {
    status: "unavailable",
    rootPathConfigured,
    inventoryAvailable,
    totalFileCount: 0,
    recognizedFileCount: 0,
    unknownFileCount: 0,
    languages: [],
    unavailableReason: reason,
  };
}

/**
 * Bounded project-language inventory used before the first semantic index exists.
 *
 * This deliberately detects only file-language presence. Provider necessity,
 * health, installation, and next-action policy remain separate concerns.
 */
export async function inspectCodeMapPreflight(
  rootPath: string | undefined,
  inventory: CodeFileInventory | undefined,
): Promise<CodeMapPreflightReport> {
  const normalizedRootPath = rootPath?.trim();
  if (!normalizedRootPath) {
    return unavailablePreflight("root_path_unavailable", false, Boolean(inventory));
  }
  if (!inventory) {
    return unavailablePreflight("inventory_unavailable", true, false);
  }

  let files;
  try {
    files = await inventory.listFiles(normalizedRootPath);
  } catch {
    return unavailablePreflight("inventory_failed", true, true);
  }

  const counts = new Map<string, number>();
  let unknownFileCount = 0;
  for (const file of files) {
    const language = normalizeCodeLanguage(file.language ?? inferCodeLanguageFromPath(file.path));
    if (language === "unknown") {
      unknownFileCount += 1;
      continue;
    }
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }

  const languages = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([language, discoveredFileCount]) => ({ language, discoveredFileCount }));

  return {
    status: "ready",
    rootPathConfigured: true,
    inventoryAvailable: true,
    totalFileCount: files.length,
    recognizedFileCount: files.length - unknownFileCount,
    unknownFileCount,
    languages,
  };
}
