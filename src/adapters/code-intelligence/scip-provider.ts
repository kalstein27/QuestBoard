import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type {
  CodeGraphSnapshot,
  CodeIndexRequest,
  CodeIntelligenceCapabilities,
  CodeIntelligenceProvider,
} from "../../application/code-intelligence.js";
import { inferCodeLanguageFromPath } from "../../application/code-map-hierarchy.js";
import { FileSystemCodeFileInventory } from "./file-inventory.js";
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
  graphLoader?: ScipGraphLoader;
  now?: () => string;
}

export interface ScipIndexReader {
  read(indexPath: string): Promise<ScipJsonIndex>;
}

export interface ScipGraphLoadInput {
  indexPath: string;
  request: CodeIndexRequest;
  indexedAt: string;
  providerId: string;
  indexArtifactSha256?: string | undefined;
}

export interface ScipGraphLoader {
  load(input: ScipGraphLoadInput): Promise<CodeGraphSnapshot>;
}

interface BundledScipDecoder {
  Index: {
    deserializeBinary(bytes: Uint8Array): { toObject(): unknown };
  };
}

const require = createRequire(import.meta.url);

interface GoogleProtobufBinaryReader {
  readPackedInt32?: () => number[];
  readPackedEnum?: () => number[];
  readPackableInt32Into?: (values: number[]) => void;
  readPackableEnumInto?: (values: number[]) => void;
}

interface GoogleProtobufRuntime {
  BinaryReader?: { prototype?: GoogleProtobufBinaryReader };
}

function installGoogleProtobufV4Compatibility(): void {
  const runtime = require("google-protobuf") as GoogleProtobufRuntime;
  const prototype = runtime.BinaryReader?.prototype;
  if (!prototype) throw new Error("google-protobuf BinaryReader is unavailable");

  if (typeof prototype.readPackedInt32 !== "function") {
    if (typeof prototype.readPackableInt32Into !== "function") {
      throw new Error("google-protobuf runtime does not support packed int32 decoding");
    }
    prototype.readPackedInt32 = function readPackedInt32Compat(this: GoogleProtobufBinaryReader): number[] {
      const values: number[] = [];
      this.readPackableInt32Into!(values);
      return values;
    };
  }

  if (typeof prototype.readPackedEnum !== "function") {
    if (typeof prototype.readPackableEnumInto !== "function") {
      throw new Error("google-protobuf runtime does not support packed enum decoding");
    }
    prototype.readPackedEnum = function readPackedEnumCompat(this: GoogleProtobufBinaryReader): number[] {
      const values: number[] = [];
      this.readPackableEnumInto!(values);
      return values;
    };
  }
}

let bundledScipDecoderPromise: Promise<BundledScipDecoder> | undefined;

async function bundledScipDecoder(): Promise<BundledScipDecoder> {
  bundledScipDecoderPromise ??= (async () => {
    installGoogleProtobufV4Compatibility();
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

export class BundledScipIndexReader implements ScipIndexReader {
  async read(indexPath: string): Promise<ScipJsonIndex> {
    const decoder = await bundledScipDecoder();
    const raw = decoder.Index.deserializeBinary(readFileSync(indexPath)).toObject();
    return parseScipJsonIndex(raw);
  }
}

export async function loadScipGraphInProcess(input: ScipGraphLoadInput): Promise<CodeGraphSnapshot> {
  const index = await new BundledScipIndexReader().read(input.indexPath);
  return normalizeScipGraph({
    projectId: input.request.projectId,
    rootPath: input.request.rootPath,
    indexedAt: input.indexedAt,
    index,
    sourceTextByPath: readIndexedSourceText(input.request.rootPath, index),
    providerId: input.providerId,
    indexArtifactSha256: input.indexArtifactSha256,
  });
}

/** Only the actual provider output bytes qualify as a native artifact digest. */
export function scipArtifactSha256(indexPath: string): string | undefined {
  return existsSync(indexPath) ? createHash("sha256").update(readFileSync(indexPath)).digest("hex") : undefined;
}

export class WorkerScipGraphLoader implements ScipGraphLoader {
  async load(input: ScipGraphLoadInput): Promise<CodeGraphSnapshot> {
    return await new Promise<CodeGraphSnapshot>((resolvePromise, reject) => {
      const worker = new Worker(new URL("./scip-normalizer-worker.js", import.meta.url), {
        workerData: input,
      });
      let settled = false;
      worker.once("message", (message: { ok: true; graph: CodeGraphSnapshot } | { ok: false; error: string }) => {
        settled = true;
        if (message.ok) resolvePromise(message.graph);
        else reject(new Error(message.error));
      });
      worker.once("error", (error) => {
        settled = true;
        reject(error);
      });
      worker.once("exit", (code) => {
        if (!settled) reject(new Error(`SCIP normalization worker exited before returning a result (code ${code})`));
      });
    });
  }
}

export function indexDirectory(storageRoot: string, request: CodeIndexRequest): string {
  const digest = createHash("sha256")
    .update(`${request.projectId}\0${request.rootPath}`)
    .digest("hex")
    .slice(0, 20);
  return join(storageRoot, `${request.projectId.replace(/[^A-Za-z0-9._-]/g, "_")}-${digest}`);
}

async function writeJavaScriptOverlayProject(
  outputDirectory: string,
  request: CodeIndexRequest,
): Promise<string | undefined> {
  if (!existsSync(request.rootPath)) return undefined;
  const inventory = await new FileSystemCodeFileInventory().listFiles(request.rootPath);
  const files = inventory
    .filter((entry) => inferCodeLanguageFromPath(entry.path) === "javascript")
    .map((entry) => resolve(request.rootPath, entry.path));
  if (files.length === 0) return undefined;

  const configPath = join(outputDirectory, "javascript-overlay.tsconfig.json");
  writeFileSync(
    configPath,
    `${JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        noEmit: true,
        skipLibCheck: true,
      },
      files,
    }, null, 2)}\n`,
    "utf8",
  );
  return configPath;
}


export function readIndexedSourceText(rootPath: string, index: ScipJsonIndex): ReadonlyMap<string, string> {
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
  readonly #graphLoader: ScipGraphLoader | undefined;
  readonly #now: () => string;

  constructor(runner: ScipProcessRunner, options: ScipTypeScriptProviderOptions) {
    if (!options.storageRoot.trim()) throw new Error("SCIP storageRoot must not be empty");
    this.#runner = runner;
    this.#storageRoot = options.storageRoot;
    this.#indexerExecutable = options.indexerExecutable?.trim() || "scip-typescript";
    this.#indexReader = options.indexReader ?? new BundledScipIndexReader();
    this.#graphLoader = options.graphLoader ?? (options.indexReader ? undefined : new WorkerScipGraphLoader());
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async indexProject(request: CodeIndexRequest): Promise<CodeGraphSnapshot> {
    if (!request.rootPath.trim()) throw new Error("SCIP rootPath must not be empty");
    const outputDirectory = indexDirectory(this.#storageRoot, request);
    const indexPath = join(outputDirectory, "index.scip");
    mkdirSync(dirname(indexPath), { recursive: true });
    const javascriptOverlayProject = await writeJavaScriptOverlayProject(outputDirectory, request);
    const projectArgs = javascriptOverlayProject ? [".", javascriptOverlayProject] : [];

    await this.#runner.run(
      this.#indexerExecutable,
      ["index", "--output", indexPath, ...projectArgs],
      { cwd: request.rootPath },
    );
    const indexedAt = this.#now();
    const indexArtifactSha256 = scipArtifactSha256(indexPath);
    if (this.#graphLoader) {
      return await this.#graphLoader.load({ indexPath, request, indexedAt, providerId: this.providerId, indexArtifactSha256 });
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
    });
  }
}
