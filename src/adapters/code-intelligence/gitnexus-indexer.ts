import { execFile } from "node:child_process";

export interface GitNexusCliRunOptions {
  cwd: string;
  env?: Readonly<Record<string, string>>;
}

export interface GitNexusCliRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitNexusCliRunner {
  run(args: readonly string[], options: GitNexusCliRunOptions): Promise<GitNexusCliRunResult>;
}

export interface ExecFileGitNexusCliRunnerOptions {
  executable?: string;
  prefixArgs?: readonly string[];
  maxBufferBytes?: number;
}

export class ExecFileGitNexusCliRunner implements GitNexusCliRunner {
  readonly #executable: string;
  readonly #prefixArgs: readonly string[];
  readonly #maxBufferBytes: number;

  constructor(options: ExecFileGitNexusCliRunnerOptions = {}) {
    this.#executable = options.executable ?? "gitnexus";
    this.#prefixArgs = options.prefixArgs ?? [];
    this.#maxBufferBytes = options.maxBufferBytes ?? 64 * 1024 * 1024;
  }

  async run(args: readonly string[], options: GitNexusCliRunOptions): Promise<GitNexusCliRunResult> {
    return await new Promise<GitNexusCliRunResult>((resolve, reject) => {
      execFile(
        this.#executable,
        [...this.#prefixArgs, ...args],
        {
          cwd: options.cwd,
          env: { ...process.env, ...options.env },
          maxBuffer: this.#maxBufferBytes,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const result: GitNexusCliRunResult = {
            stdout: String(stdout),
            stderr: String(stderr),
            exitCode: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          };
          if (error) {
            reject(new GitNexusCliError(this.#executable, args, result, error));
            return;
          }
          resolve(result);
        },
      );
    });
  }
}

export class GitNexusCliError extends Error {
  readonly executable: string;
  readonly args: readonly string[];
  readonly result: GitNexusCliRunResult;

  constructor(
    executable: string,
    args: readonly string[],
    result: GitNexusCliRunResult,
    cause?: unknown,
  ) {
    super(`GitNexus command failed (${result.exitCode}): ${executable} ${args.join(" ")}`, { cause });
    this.name = "GitNexusCliError";
    this.executable = executable;
    this.args = [...args];
    this.result = result;
  }
}

export interface GitNexusIndexStatus {
  status: string;
  commit?: string;
  runnerIdentityStatus?: string;
  incompleteReasons: readonly string[];
}

export interface GitNexusIndexerOptions {
  storageRoot: string;
}

export interface GitNexusIndexResult {
  status: GitNexusIndexStatus;
  analyzeStderr: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

export function parseGitNexusStatusJson(stdout: string): GitNexusIndexStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error("GitNexus status --json returned invalid JSON", { cause: error });
  }

  const root = asRecord(parsed);
  if (!root) {
    throw new Error("GitNexus status --json must return an object");
  }
  const index = asRecord(root.index) ?? {};
  const status = optionalString(root.status);
  if (!status) {
    throw new Error("GitNexus status --json is missing status");
  }

  const commit = optionalString(index.commit) ?? optionalString(root.lastCommit);
  const runnerIdentityStatus = optionalString(index.runnerIdentityStatus);
  const incompleteReasons = stringArray(index.incompleteReasons ?? index.incomplete_reasons);

  return {
    status,
    ...(commit ? { commit } : {}),
    ...(runnerIdentityStatus ? { runnerIdentityStatus } : {}),
    incompleteReasons,
  };
}

export function assertFreshGitNexusStatus(status: GitNexusIndexStatus): void {
  if (status.status !== "up-to-date") {
    throw new Error(`GitNexus index is not current: ${status.status}`);
  }
  if (status.incompleteReasons.length > 0) {
    throw new Error(`GitNexus index is incomplete: ${status.incompleteReasons.join(", ")}`);
  }
  if (status.runnerIdentityStatus !== "current") {
    throw new Error(
      `GitNexus runner identity is not current: ${status.runnerIdentityStatus ?? "missing"}`,
    );
  }
}

/**
 * Owns the GitNexus index lifecycle without leaking GitNexus into the application port.
 *
 * The adapter always uses --index-only so GitNexus cannot inject AGENTS.md,
 * CLAUDE.md, or skill files into the target repository. Index files are directed
 * to an external storage root rather than the repository's .gitnexus directory.
 */
export class GitNexusIndexer {
  readonly #runner: GitNexusCliRunner;
  readonly #storageRoot: string;

  constructor(runner: GitNexusCliRunner, options: GitNexusIndexerOptions) {
    if (!options.storageRoot.trim()) {
      throw new Error("GitNexus storageRoot must not be empty");
    }
    this.#runner = runner;
    this.#storageRoot = options.storageRoot;
  }

  async ensureIndexed(rootPath: string): Promise<GitNexusIndexResult> {
    if (!rootPath.trim()) {
      throw new Error("GitNexus rootPath must not be empty");
    }

    const env = { GITNEXUS_STORAGE_ROOT: this.#storageRoot } as const;
    const analyze = await this.#runner.run(["analyze", rootPath, "--index-only"], {
      cwd: rootPath,
      env,
    });
    const statusResult = await this.#runner.run(["status", "--repo", rootPath, "--json"], {
      cwd: rootPath,
      env,
    });
    const status = parseGitNexusStatusJson(statusResult.stdout);
    assertFreshGitNexusStatus(status);

    return { status, analyzeStderr: analyze.stderr };
  }
}
