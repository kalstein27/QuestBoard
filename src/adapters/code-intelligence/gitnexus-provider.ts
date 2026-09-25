import type {
  CodeGraphSnapshot,
  CodeIndexRequest,
  CodeIntelligenceCapabilities,
  CodeIntelligenceProvider,
} from "../../application/code-intelligence.js";
import {
  GitNexusIndexer,
  type GitNexusCliRunOptions,
  type GitNexusCliRunner,
} from "./gitnexus-indexer.js";
import {
  normalizeGitNexusGraph,
  type GitNexusGraphRows,
  type GitNexusNodeRow,
  type GitNexusRelationRow,
} from "./gitnexus-normalizer.js";

const SYMBOL_LABELS = ["Function", "Class", "Interface", "Method", "Constructor", "Property"] as const;
const SYMBOL_LABEL_LIST = SYMBOL_LABELS.map((label) => `'${label}'`).join(", ");

export const GITNEXUS_NODE_EXPORT_QUERY = [
  "MATCH (n)",
  `WHERE labels(n)[0] IN [${SYMBOL_LABEL_LIST}]`,
  "RETURN n.uid AS uid, labels(n)[0] AS kind, n.name AS name, n.filePath AS filePath,",
  "n.startLine AS startLine, n.endLine AS endLine",
].join(" ");

export const GITNEXUS_RELATION_EXPORT_QUERY = [
  "MATCH (a)-[r:CodeRelation]->(b)",
  `WHERE labels(a)[0] IN [${SYMBOL_LABEL_LIST}] AND labels(b)[0] IN [${SYMBOL_LABEL_LIST}]`,
  "RETURN a.uid AS fromUid, b.uid AS toUid, r.type AS type,",
  "r.confidence AS confidence, r.reason AS reason",
].join(" ");

export interface GitNexusCypherResult {
  rows: readonly Record<string, string>[];
  rowCount: number;
}

function splitMarkdownRow(line: string): string[] {
  const trimmed = line.trim();
  const content = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const withoutTrailing = content.endsWith("|") ? content.slice(0, -1) : content;
  const cells: string[] = [];
  let current = "";
  let escaped = false;

  for (const character of withoutTrailing) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (escaped) current += "\\";
  cells.push(current.trim());
  return cells;
}

function isMarkdownSeparator(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

export function parseGitNexusCypherOutput(stdout: string): GitNexusCypherResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error("GitNexus cypher returned invalid JSON", { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("GitNexus cypher must return an object");
  }

  const object = parsed as Record<string, unknown>;
  const markdown = object.markdown;
  const rowCount = object.row_count;
  if (typeof markdown !== "string" || typeof rowCount !== "number" || !Number.isInteger(rowCount) || rowCount < 0) {
    throw new Error("GitNexus cypher output is missing markdown or row_count");
  }
  if (rowCount === 0) return { rows: [], rowCount };

  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    throw new Error("GitNexus cypher markdown table is incomplete");
  }
  const headers = splitMarkdownRow(lines[0]!);
  const separator = splitMarkdownRow(lines[1]!);
  if (!isMarkdownSeparator(separator) || headers.length !== separator.length) {
    throw new Error("GitNexus cypher markdown table has an invalid header");
  }

  const rows = lines.slice(2).map((line) => {
    const values = splitMarkdownRow(line);
    if (values.length !== headers.length) {
      throw new Error("GitNexus cypher markdown row width does not match the header");
    }
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
  if (rows.length !== rowCount) {
    throw new Error(`GitNexus cypher row_count mismatch: expected ${rowCount}, parsed ${rows.length}`);
  }
  return { rows, rowCount };
}

function optionalCell(row: Record<string, string>, key: string): string | undefined {
  const value = row[key]?.trim();
  if (!value || value.toLowerCase() === "null") return undefined;
  return value;
}

function requiredCell(row: Record<string, string>, key: string): string {
  const value = optionalCell(row, key);
  if (!value) throw new Error(`GitNexus graph row is missing ${key}`);
  return value;
}

function optionalNumber(row: Record<string, string>, key: string): number | undefined {
  const value = optionalCell(row, key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`GitNexus graph row has invalid ${key}: ${value}`);
  }
  return parsed;
}

function nodeRow(row: Record<string, string>): GitNexusNodeRow {
  const startLine = optionalNumber(row, "startLine");
  const endLine = optionalNumber(row, "endLine");
  const filePath = optionalCell(row, "filePath");
  return {
    uid: requiredCell(row, "uid"),
    kind: requiredCell(row, "kind"),
    name: requiredCell(row, "name"),
    ...(filePath ? { filePath } : {}),
    ...(startLine !== undefined ? { startLine } : {}),
    ...(endLine !== undefined ? { endLine } : {}),
  };
}

function relationRow(row: Record<string, string>): GitNexusRelationRow {
  const confidence = optionalNumber(row, "confidence");
  const reason = optionalCell(row, "reason");
  return {
    fromUid: requiredCell(row, "fromUid"),
    toUid: requiredCell(row, "toUid"),
    type: requiredCell(row, "type"),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(reason ? { reason } : {}),
  };
}

export interface GitNexusGraphReaderOptions {
  storageRoot: string;
  maxRows?: number;
}

export class GitNexusGraphReader {
  readonly #runner: GitNexusCliRunner;
  readonly #storageRoot: string;
  readonly #maxRows: number;

  constructor(runner: GitNexusCliRunner, options: GitNexusGraphReaderOptions) {
    if (!options.storageRoot.trim()) throw new Error("GitNexus storageRoot must not be empty");
    this.#runner = runner;
    this.#storageRoot = options.storageRoot;
    this.#maxRows = options.maxRows ?? 250_000;
    if (!Number.isInteger(this.#maxRows) || this.#maxRows < 1) {
      throw new Error("GitNexus maxRows must be a positive integer");
    }
  }

  async readGraph(rootPath: string): Promise<GitNexusGraphRows> {
    const options: GitNexusCliRunOptions = {
      cwd: rootPath,
      env: { GITNEXUS_STORAGE_ROOT: this.#storageRoot },
    };
    const nodeOutput = await this.#runner.run(
      ["cypher", GITNEXUS_NODE_EXPORT_QUERY, "--repo", rootPath, "--limit", String(this.#maxRows)],
      options,
    );
    const nodeResult = parseGitNexusCypherOutput(nodeOutput.stdout);
    if (nodeResult.rowCount >= this.#maxRows) {
      throw new Error(`GitNexus node export reached the ${this.#maxRows} row safety limit`);
    }

    const relationOutput = await this.#runner.run(
      ["cypher", GITNEXUS_RELATION_EXPORT_QUERY, "--repo", rootPath, "--limit", String(this.#maxRows)],
      options,
    );
    const relationResult = parseGitNexusCypherOutput(relationOutput.stdout);
    if (relationResult.rowCount >= this.#maxRows) {
      throw new Error(`GitNexus relation export reached the ${this.#maxRows} row safety limit`);
    }

    return {
      nodes: nodeResult.rows.map(nodeRow),
      relations: relationResult.rows.map(relationRow),
    };
  }
}

export interface GitNexusCodeIntelligenceProviderOptions extends GitNexusGraphReaderOptions {
  now?: () => string;
}

export class GitNexusCodeIntelligenceProvider implements CodeIntelligenceProvider {
  readonly providerId = "gitnexus";
  readonly capabilities: CodeIntelligenceCapabilities = {
    incrementalIndexing: true,
    impactAnalysis: false,
    callTrace: false,
  };

  readonly #indexer: GitNexusIndexer;
  readonly #reader: GitNexusGraphReader;
  readonly #now: () => string;

  constructor(runner: GitNexusCliRunner, options: GitNexusCodeIntelligenceProviderOptions) {
    this.#indexer = new GitNexusIndexer(runner, { storageRoot: options.storageRoot });
    this.#reader = new GitNexusGraphReader(runner, options);
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async indexProject(request: CodeIndexRequest): Promise<CodeGraphSnapshot> {
    await this.#indexer.ensureIndexed(request.rootPath);
    const rows = await this.#reader.readGraph(request.rootPath);
    return normalizeGitNexusGraph({
      projectId: request.projectId,
      rootPath: request.rootPath,
      indexedAt: this.#now(),
      ...rows,
    });
  }
}
