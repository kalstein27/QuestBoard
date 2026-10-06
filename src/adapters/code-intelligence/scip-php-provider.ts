import { constants, copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  CodeGraphSnapshot,
  CodeIndexRequest,
  CodeIntelligenceCapabilities,
  CodeIntelligenceProvider,
} from "../../application/code-intelligence.js";
import { inferCodeLanguageFromPath } from "../../application/code-map-hierarchy.js";
import { FileSystemCodeFileInventory } from "./file-inventory.js";
import { normalizeScipGraph } from "./scip-normalizer.js";
import {
  BundledScipIndexReader,
  WorkerScipGraphLoader,
  indexDirectory,
  readIndexedSourceText,
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
    callTrace: false,
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
    } finally {
      // Upstream scip-php writes index.scip into the project root. QuestBoard
      // owns only files that did not exist before this run and removes that
      // generated artifact immediately after copying it to external storage.
      rmSync(generatedIndexPath, { force: true });
    }

    const indexedAt = this.#now();
    if (this.#graphLoader) {
      return await this.#graphLoader.load({ indexPath, request, indexedAt, providerId: this.providerId });
    }
    const index = await this.#indexReader.read(indexPath);
    return normalizeScipGraph({
      projectId: request.projectId,
      rootPath: request.rootPath,
      indexedAt,
      index,
      sourceTextByPath: readIndexedSourceText(request.rootPath, index),
      providerId: this.providerId,
    });
  }
}