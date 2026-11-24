import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  CodeGraphSnapshot,
  CodeIndexRequest,
  CodeIntelligenceCapabilities,
  CodeIntelligenceProvider,
} from "../../application/code-intelligence.js";
import { CodeMapSemanticIndexFailureError } from "../../application/code-intelligence.js";
import { inferCodeLanguageFromPath } from "../../application/code-map-hierarchy.js";
import { FileSystemCodeFileInventory } from "./file-inventory.js";
import { normalizeScipGraph } from "./scip-normalizer.js";
import {
  BundledScipIndexReader,
  WorkerScipGraphLoader,
  indexDirectory,
  readIndexedSourceText,
  scipArtifactSha256,
  type ScipGraphLoader,
  type ScipIndexReader,
  type ScipProcessRunner,
} from "./scip-provider.js";

export interface ScipPhpProviderOptions {
  storageRoot: string;
  indexerExecutable?: string;
  indexReader?: ScipIndexReader;
  graphLoader?: ScipGraphLoader;
  now?: () => string;
}

function projectLocalExecutable(rootPath: string): string {
  return join(rootPath, "vendor", "bin", process.platform === "win32" ? "scip-php.bat" : "scip-php");
}

/** Composer's declared first-party source roots, not every PHP-shaped repository file. */
function composerPhpSourceRoots(rootPath: string): string[] | undefined {
  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(rootPath, "composer.json"), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    manifest = parsed as Record<string, unknown>;
  } catch {
    return undefined; // Never silently narrow coverage on an unreadable manifest.
  }
  const paths: string[] = [];
  let uncertain = false;
  const collect = (value: unknown): void => {
    if (typeof value === "string") {
      const path = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
      // An unsupported path pattern must not hide an unindexed source file.
      if (/[*?\[\]{}]/.test(path) || path.startsWith("/") || /^[A-Za-z]:/.test(path)
        || path.split("/").some(part => part === ".." || (part === "." && path !== "."))) {
        uncertain = true;
        return;
      }
      if (path === "." || path === "" || (!path.startsWith("/") && !path.split("/").includes(".."))) {
        paths.push(path === "." ? "" : path);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) collect(item);
    } else if (value && typeof value === "object") {
      for (const item of Object.values(value)) collect(item);
    }
  };
  // Native scip-php also indexes Composer's explicitly declared executables.
  collect(manifest.bin);
  for (const key of ["autoload", "autoload-dev"]) {
    const section = manifest[key];
    if (!section || typeof section !== "object" || Array.isArray(section)) continue;
    for (const field of ["psr-4", "psr-0", "classmap", "files"]) {
      collect((section as Record<string, unknown>)[field]);
    }
  }
  return !uncertain && paths.length ? [...new Set(paths)] : undefined;
}

async function assertReadable(path: string, description: string): Promise<void> {
  try {
    await access(path, constants.R_OK);
  } catch {
    throw new Error(`SCIP PHP requires ${description}: ${path}`);
  }
}

async function assertExecutable(path: string): Promise<void> {
  try {
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
  } catch {
    throw new Error(`SCIP PHP executable is unavailable: ${path}`);
  }
}

export class ScipPhpProvider implements CodeIntelligenceProvider {
  readonly providerId = "scip-php";
  readonly languages = ["php"] as const;
  readonly fidelity = "semantic-call" as const;
  readonly capabilities: CodeIntelligenceCapabilities = {
    incrementalIndexing: false,
    impactAnalysis: false,
    callTrace: true,
  };

  readonly #runner: ScipProcessRunner;
  readonly #storageRoot: string;
  readonly #indexerExecutable: string | undefined;
  readonly #indexReader: ScipIndexReader;
  readonly #graphLoader: ScipGraphLoader | undefined;
  readonly #now: () => string;

  constructor(runner: ScipProcessRunner, options: ScipPhpProviderOptions) {
    if (!options.storageRoot.trim()) throw new Error("SCIP PHP storageRoot must not be empty");
    this.#runner = runner;
    this.#storageRoot = options.storageRoot;
    this.#indexerExecutable = options.indexerExecutable?.trim() || undefined;
    this.#indexReader = options.indexReader ?? new BundledScipIndexReader();
    this.#graphLoader = options.graphLoader ?? (options.indexReader ? undefined : new WorkerScipGraphLoader());
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async indexProject(request: CodeIndexRequest): Promise<CodeGraphSnapshot> {
    if (!request.rootPath.trim()) throw new Error("SCIP PHP rootPath must not be empty");
    const inventory = await new FileSystemCodeFileInventory().listFiles(request.rootPath);
    const phpFiles = inventory.filter((entry) => inferCodeLanguageFromPath(entry.path) === "php");
    if (phpFiles.length === 0) {
      return normalizeScipGraph({
        projectId: request.projectId,
        rootPath: request.rootPath,
        indexedAt: this.#now(),
        index: { documents: [], externalSymbols: [] },
        providerId: this.providerId,
      });
    }

    await assertReadable(join(request.rootPath, "composer.json"), "composer.json");
    await assertReadable(join(request.rootPath, "composer.lock"), "composer.lock");
    await assertReadable(join(request.rootPath, "vendor", "autoload.php"), "vendor/autoload.php");
    const configuredExecutable = this.#indexerExecutable;
    const executable = configuredExecutable
      ? (isAbsolute(configuredExecutable) ? configuredExecutable : resolve(request.rootPath, configuredExecutable))
      : projectLocalExecutable(request.rootPath);
    await assertExecutable(executable);

    const generatedIndexPath = join(request.rootPath, "index.scip");
    if (existsSync(generatedIndexPath)) {
      throw new Error("SCIP PHP refuses to overwrite an existing project index.scip");
    }

    const outputDirectory = indexDirectory(this.#storageRoot, request);
    const indexPath = join(outputDirectory, "index.scip");
    mkdirSync(dirname(indexPath), { recursive: true });

    try {
      await this.#runner.run(executable, [], { cwd: request.rootPath });
      if (!existsSync(generatedIndexPath)) {
        throw new Error("SCIP PHP completed without producing index.scip");
      }
      copyFileSync(generatedIndexPath, indexPath);
    } catch (error) {
      throw new CodeMapSemanticIndexFailureError(this.providerId, error);
    } finally {
      // Upstream scip-php writes index.scip into the project root. QuestBoard
      // owns only files that did not exist before this run and removes that
      // generated artifact immediately after copying it to external storage.
      rmSync(generatedIndexPath, { force: true });
    }

    try {
      const indexedAt = this.#now();
      const indexArtifactSha256 = scipArtifactSha256(indexPath);
      const discoveredPhpPaths = phpFiles.map((entry) => entry.path);
      const declaredRoots = composerPhpSourceRoots(request.rootPath);
      // A Blade view is a template, not a PHP translation unit. Native SCIP
      // documents outside declared Composer roots remain eligible downstream.
      const eligiblePhpPaths = discoveredPhpPaths.filter((path) => !path.endsWith(".blade.php")
        && (!declaredRoots || declaredRoots.some((root) =>
          root === "" || path === root || path.startsWith(root + "/"))));
      if (this.#graphLoader) {
        return await this.#graphLoader.load({
          indexPath, request, indexedAt, providerId: this.providerId, indexArtifactSha256,
          eligiblePhpPaths, discoveredPhpPaths,
        });
      }
      const index = await this.#indexReader.read(indexPath);
      return normalizeScipGraph({
        projectId: request.projectId,
        rootPath: request.rootPath,
        indexedAt,
        index,
        sourceTextByPath: readIndexedSourceText(request.rootPath, index),
        providerId: this.providerId,
        indexArtifactSha256,
        phpEligibleFilePaths: eligiblePhpPaths,
        phpDiscoveredFilePaths: discoveredPhpPaths,
      });
    } catch (error) {
      throw new CodeMapSemanticIndexFailureError(this.providerId, error);
    }
  }
}