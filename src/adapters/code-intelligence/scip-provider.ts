import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  CodeGraphSnapshot,
  CodeIndexRequest,
  CodeIntelligenceCapabilities,
  CodeIntelligenceProvider,
} from "../../application/code-intelligence.js";
import { normalizeScipGraph, parseScipJsonIndex, type ScipJsonIndex } from "./scip-normalizer.js";

export interface ScipProcessRunOptions {
  cwd: string;
}

export interface ScipProcessRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ScipProcessRunner {
  run(executable: string, args: readonly string[], options: ScipProcessRunOptions): Promise<ScipProcessRunResult>;
}

export interface ExecFileScipProcessRunnerOptions {
  maxBufferBytes?: number;
}

export class ExecFileScipProcessRunner implements ScipProcessRunner {
  readonly #maxBufferBytes: number;

  constructor(options: ExecFileScipProcessRunnerOptions = {}) {
    this.#maxBufferBytes = options.maxBufferBytes ?? 128 * 1024 * 1024;
  }

  async run(executable: string, args: readonly string[], options: ScipProcessRunOptions): Promise<ScipProcessRunResult> {
    return await new Promise<ScipProcessRunResult>((resolve, reject) => {
      execFile(
        executable,
        [...args],
        {
          cwd: options.cwd,
          env: process.env,
          maxBuffer: this.#maxBufferBytes,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const result: ScipProcessRunResult = {
            stdout: String(stdout),
            stderr: String(stderr),
            exitCode: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          };
          if (error) {
            reject(new ScipProcessError(executable, args, result, error));
            return;
          }
          resolve(result);
        },
      );
    });
  }
}

export class ScipProcessError extends Error {
  readonly executable: string;
  readonly args: readonly string[];
  readonly result: ScipProcessRunResult;

  constructor(executable: string, args: readonly string[], result: ScipProcessRunResult, cause?: unknown) {
    super(`SCIP command failed (${result.exitCode}): ${executable} ${args.join(" ")}`, { cause });
    this.name = "ScipProcessError";
    this.executable = executable;
    this.args = [...args];
    this.result = result;
  }
}

export interface ScipTypeScriptProviderOptions {
  storageRoot: string;
  indexerExecutable?: string;
  indexReader?: ScipIndexReader;
  now?: () => string;
}

export interface ScipIndexReader {
  read(indexPath: string): Promise<ScipJsonIndex>;
}

interface BundledScipDecoder {
  Index: {
    deserializeBinary(bytes: Uint8Array): { toObject(): unknown };
  };
}

const require = createRequire(import.meta.url);
let bundledScipDecoderPromise: Promise<BundledScipDecoder> | undefined;

async function bundledScipDecoder(): Promise<BundledScipDecoder> {
  bundledScipDecoderPromise ??= (async () => {
    const decoderPath = require.resolve("@sourcegraph/scip-typescript/dist/src/scip.js");
    const module = await import(pathToFileURL(decoderPath).href) as {
      scip?: BundledScipDecoder;
      default?: { scip?: BundledScipDecoder };
    };
    const decoder = module.scip ?? module.default?.scip;
    if (!decoder?.Index?.deserializeBinary) {
      throw new Error("Bundled scip-typescript decoder is unavailable");
    }
    return decoder;
  })();
  return await bundledScipDecoderPromise;
}

class BundledScipIndexReader implements ScipIndexReader {
  async read(indexPath: string): Promise<ScipJsonIndex> {
    const decoder = await bundledScipDecoder();
    const raw = decoder.Index.deserializeBinary(readFileSync(indexPath)).toObject();
    return parseScipJsonIndex(raw);
  }
}

function indexDirectory(storageRoot: string, request: CodeIndexRequest): string {
  const digest = createHash("sha256")
    .update(`${request.projectId}\0${request.rootPath}`)
    .digest("hex")
    .slice(0, 20);
  return join(storageRoot, `${request.projectId.replace(/[^A-Za-z0-9._-]/g, "_")}-${digest}`);
}

function readIndexedSourceText(rootPath: string, index: ScipJsonIndex): ReadonlyMap<string, string> {
  const root = resolve(rootPath);
  const sources = new Map<string, string>();
  for (const document of index.documents) {
    const sourcePath = resolve(root, document.relativePath);
    const relativeToRoot = relative(root, sourcePath);
    if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${sep}`) || isAbsolute(relativeToRoot)) continue;
    try {
      sources.set(document.relativePath, readFileSync(sourcePath, "utf8"));
    } catch {
      // Source enrichment is supplemental. SCIP graph normalization remains usable when a file disappears mid-index.
    }
  }
  return sources;
}

export class ScipTypeScriptCodeIntelligenceProvider implements CodeIntelligenceProvider {
  readonly providerId = "scip-typescript";
  readonly capabilities: CodeIntelligenceCapabilities = {
    incrementalIndexing: false,
    impactAnalysis: false,
    callTrace: false,
  };

  readonly #runner: ScipProcessRunner;
  readonly #storageRoot: string;
  readonly #indexerExecutable: string;
  readonly #indexReader: ScipIndexReader;
  readonly #now: () => string;

  constructor(runner: ScipProcessRunner, options: ScipTypeScriptProviderOptions) {
    if (!options.storageRoot.trim()) throw new Error("SCIP storageRoot must not be empty");
    this.#runner = runner;
    this.#storageRoot = options.storageRoot;
    this.#indexerExecutable = options.indexerExecutable?.trim() || "scip-typescript";
    this.#indexReader = options.indexReader ?? new BundledScipIndexReader();
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async indexProject(request: CodeIndexRequest): Promise<CodeGraphSnapshot> {
    if (!request.rootPath.trim()) throw new Error("SCIP rootPath must not be empty");
    const outputDirectory = indexDirectory(this.#storageRoot, request);
    const indexPath = join(outputDirectory, "index.scip");
    mkdirSync(dirname(indexPath), { recursive: true });

    await this.#runner.run(
      this.#indexerExecutable,
      ["index", "--output", indexPath],
      { cwd: request.rootPath },
    );
    const index = await this.#indexReader.read(indexPath);
    return normalizeScipGraph({
      projectId: request.projectId,
      rootPath: request.rootPath,
      indexedAt: this.#now(),
      index,
      sourceTextByPath: readIndexedSourceText(request.rootPath, index),
    });
  }
}
