/** SourceKit-LSP semantic Swift calls. Never infer edges from matching names. */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  CODE_GRAPH_SCHEMA_VERSION,
  type CodeGraphSnapshot,
  type CodeIndexRequest,
  type CodeIntelligenceProvider,
  type CodeNode,
  type CodeRelation,
  type CodeSourceLocation,
} from "../../application/code-intelligence.js";
import { FileSystemCodeFileInventory } from "./file-inventory.js";
import type { CodeFileInventory } from "../../application/code-map-hierarchy.js";
import { swiftSourceFunctionDeclarations } from "../../application/code-map-lexical-declarations.js";

type Position = { line: number; character: number };
type Range = { start: Position; end: Position };
type DocumentSymbol = { name: string; kind: number; selectionRange: Range; children?: DocumentSymbol[] };
type HierarchyItem = { name: string; kind: number; uri: string; range: Range; selectionRange: Range; data?: unknown };
type OutgoingCall = { to: HierarchyItem; fromRanges: Range[] };
type EvidenceRejectionReason =
  | "invalid_lsp_range" | "outside_caller_span" | "column_mismatch"
  | "ambiguous_nearby_site" | "unverified_call_token" | "nested_local_function";
type RpcReply = { id: number; result?: unknown; error?: { code?: number; message?: string } };

const PROVIDER_ID = "sourcekit-lsp";
const PROVENANCE = [{ providerId: PROVIDER_ID, fidelity: "semantic-call" as const, freshness: "fresh" as const }];
// TouchPilot's ContentView.swift exceeds 512 KiB while remaining under 768 KiB.
const MAX_SWIFT_FILE_BYTES = 768 * 1024;
type SwiftSource = { lines: string[]; declarations: readonly { name: string; line: number; column: number }[] };

function swiftSource(text: string): SwiftSource {
  return { lines: text.split(/\r?\n/), declarations: swiftSourceFunctionDeclarations(text) };
}

function functionName(name: string): string | null {
  // Accessors, operators and SDK declarations are not modeled as function-to-function calls.
  return name.match(/(?:^|\.)([A-Za-z_][A-Za-z_0-9]*)\s*\(/)?.[1] ?? null;
}

function sourcePosition(source: SwiftSource, name: string, start: Position): Position | null {
  if (!Number.isInteger(start.line) || !Number.isInteger(start.character)
    || start.line < 0 || start.character < 0) return null;
  const candidates = source.declarations.filter((decl) => decl.name === name);
  const atLine = candidates.filter((decl) => decl.line === start.line + 1);
  // Prefer current-source syntax anchors. Never guess between overloads in the same file.
  const match = atLine.length === 1 ? atLine[0]
    : candidates.length === 1 ? candidates[0] : undefined;
  if (match) return { line: match.line - 1, character: match.column - 1 };
  if (candidates.length > 1) return null;
  const line = source.lines[start.line];
  // Some valid Swift declarations have attributes/modifiers unsupported by the
  // conservative lexical scanner. Accept only the exact source token at this line.
  if (line && !line.trimStart().startsWith("//") && name !== "init") {
    const token = new RegExp(`\\bfunc\\s+${name}\\b`).exec(line);
    if (token) {
      const column = token.index + token[0].lastIndexOf(name);
      if (Math.abs(column - start.character) <= 2)
        return { line: start.line, character: column };
    }
  }
  // Swift initializers are not lexical `func` declarations; require an exact source token.
  if (name === "init" && /^init[!?]?\s*\(/.test(line?.slice(start.character) ?? "")
    && /^\s*(?:(?:convenience|required|public|internal|private|fileprivate|override)\s+)*$/.test(line!.slice(0, start.character))) return start;
  return null;
}

/** Current-source body boundary, never a source of semantic call edges. */
function swiftFunctionBodyEnd(source: SwiftSource, startLine: number, startColumn: number): Position | null {
  let parameterDepth = 0;
  let sawParameters = false;
  let inBody = false;
  let braceDepth = 0;
  let commentDepth = 0;
  let quoted: { delimiter: string; hashes: string } | null = null;
  for (let row = startLine - 1; row < source.lines.length; row++) {
    const line = source.lines[row]!;
    // Conditional compilation can contain mutually exclusive brace structures.
    if (/^\s*#(?:if|elseif|else|endif)\b/.test(line)) return null;
    for (let col = row === startLine - 1 ? startColumn - 1 : 0; col < line.length; col++) {
      if (quoted) {
        const close = quoted.delimiter + quoted.hashes;
        if (line.startsWith(close, col)) { col += close.length - 1; quoted = null; }
        else if (!quoted.hashes && line[col] === "\\") col++;
        continue;
      }
      if (commentDepth > 0) {
        if (line.startsWith("/*", col)) { commentDepth++; col++; }
        else if (line.startsWith("*/", col)) { commentDepth--; col++; }
        continue;
      }
      if (line.startsWith("//", col)) break;
      if (line.startsWith("/*", col)) { commentDepth++; col++; continue; }
      const stringStart = /^(#+)?("""|")/.exec(line.slice(col));
      if (stringStart) {
        quoted = { hashes: stringStart[1] ?? "", delimiter: stringStart[2]! };
        col += stringStart[0].length - 1;
        continue;
      }
      if (!inBody) {
        if (line[col] === "(") parameterDepth++;
        else if (line[col] === ")" && parameterDepth > 0) {
          parameterDepth--;
          if (parameterDepth === 0) sawParameters = true;
        } else if (line[col] === "{" && sawParameters && parameterDepth === 0) {
          inBody = true;
          braceDepth = 1;
        } else if (line[col] === ";" || line[col] === "}") return null;
      } else if (line[col] === "{") braceDepth++;
      else if (line[col] === "}" && --braceDepth === 0)
        return { line: row + 1, character: col };
    }
  }
  return null;
}

function verifiedCallRange(
  source: SwiftSource, range: Range, callee: CodeNode,
  callerStartLine: number, callerEndLine: number, sourceLineShift: number,
  onReject?: (reason: EvidenceRejectionReason) => void,
  callerEndCharacter?: number,
  nestedFunctionBodies: readonly Range[] = [],
): Range | null {
  const start = range?.start;
  if (!start || !Number.isInteger(start.line) || !Number.isInteger(start.character)
    || start.line < 0 || start.character < 0) {
    onReject?.("invalid_lsp_range");
    return null;
  }
  // SourceKit semantic facts can point to stale lines and multiline calls.
  // Verify only the named opening token at an exact/uniquely corrected site.
  const names = [callee.name];
  if (callee.name === "init") {
    // Swift constructor calls are often `Widget()`, not the literal `init()`.
    const owner = callee.signature?.match(/(?:^|\.)([A-Za-z_][\w]*)\.init\s*\(/)?.[1];
    if (owner) names.push(owner);
  }
  const escaped = names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const invocation = new RegExp("\\b(?:" + escaped + ")\\s*(?:\\(|\\{)", "g");
  let columnMismatch = false;
  let nestedMatch = false;
  const at = (lineIndex: number): Range | null => {
    if (lineIndex < callerStartLine - 1 || lineIndex >= callerEndLine - 1
      || lineIndex >= source.lines.length) return null;
    const line = source.lines[lineIndex];
    if (!line || line.trimStart().startsWith("//")) return null;
    const allMatches = [...line.matchAll(invocation)];
    const matches = allMatches
      .filter((match) => Math.abs((match.index ?? -1000) - start.character) <= 3);
    if (allMatches.length > 0 && matches.length === 0) columnMismatch = true;
    if (matches.length !== 1) return null;
    const column = matches[0]!.index!;
    if (nestedFunctionBodies.some((body) =>
      (lineIndex > body.start.line || (lineIndex === body.start.line && column >= body.start.character))
      && (lineIndex < body.end.line || (lineIndex === body.end.line && column < body.end.character)))) {
      nestedMatch = true;
      return null;
    }
    if (callerEndCharacter !== undefined
      && lineIndex === callerEndLine - 2 && column >= callerEndCharacter) return null;
    return { start: { line: lineIndex, character: column },
      end: { line: lineIndex, character: column + matches[0]![0].length } };
  };
  const anchors = [...new Set([start.line + sourceLineShift, start.line])];
  for (const anchor of anchors) {
    const exact = at(anchor);
    if (exact) return exact;
  }
  if (nestedMatch) { onReject?.("nested_local_function"); return null; }
  // Limit drift correction to +/-8 lines. Multiple matches are ambiguous.
  const candidates = new Map<number, Range>();
  for (const anchor of anchors) {
    for (let offset = 1; offset <= 8; offset++) {
      for (const line of [anchor - offset, anchor + offset]) {
        const candidate = at(line);
        if (candidate) candidates.set(line, candidate);
      }
    }
  }
  if (nestedMatch) { onReject?.("nested_local_function"); return null; }
  if (candidates.size === 1) return candidates.values().next().value!;
  if (candidates.size > 1) onReject?.("ambiguous_nearby_site");
  else if (columnMismatch) onReject?.("column_mismatch");
  else if (anchors.every(anchor =>
    anchor < callerStartLine - 9 || anchor >= callerEndLine + 7))
    onReject?.("outside_caller_span");
  else onReject?.("unverified_call_token");
  return null;
}

function semanticIndexFailure(cause: unknown): Error & { code: string } {
  const error = new Error("SourceKit-LSP semantic indexing failed; preserving last-good snapshot", {
    cause,
  }) as Error & { code: string };
  error.code = "code_map_semantic_index_failed";
  return error;
}

function identity(kind: "node" | "relation", value: string): string {
  return "code:" + kind + ":" + createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function localSwiftPath(rootPath: string, uri: string, sourceRootAlias?: string): string | null {
  if (!uri.startsWith("file://")) return null;
  let absolute: string;
  try { absolute = resolve(fileURLToPath(uri)); } catch { return null; }
  // SourceKit can use the physical original URI for callees discovered in its
  // compiler index, even when the queried workspace uses temporary symlinks.
  const root = [rootPath, sourceRootAlias].filter((entry): entry is string => Boolean(entry))
    .map(entry => resolve(entry))
    .find(entry => absolute.startsWith(entry + sep));
  if (!root) return null;
  const local = relative(root, absolute);
  return local && !isAbsolute(local) && !local.split(sep).includes("..") && local.endsWith(".swift")
    ? local.split(sep).join("/") : null;
}

async function nodeForItem(
  rootPath: string, item: HierarchyItem,
  loadSource: (path: string) => Promise<SwiftSource | null>,
  sourceRootAlias?: string,
): Promise<CodeNode | null> {
  const path = localSwiftPath(rootPath, item.uri, sourceRootAlias);
  if (!path || !item.selectionRange?.start) return null;
  const name = functionName(item.name);
  if (!name) return null;
  const source = await loadSource(path);
  if (!source) return null;
  const start = sourcePosition(source, name, item.selectionRange.start);
  // Stale/ambiguous LSP coordinates are not trusted semantic declarations.
  if (!start) return null;
  const location: CodeSourceLocation = {
    path, startLine: start.line + 1, startColumn: start.character + 1,
  };
  // Match existing conservative Swift declaration identities and preserve manual edges.
  const canonicalIdentity = ["syntax-declaration", path, "function", name,
    location.startLine, location.startColumn].join(":");
  return {
    id: identity("node", canonicalIdentity),
    kind: "function",
    name,
    canonicalIdentity,
    language: "swift",
    location,
    signature: item.name,
    provenance: PROVENANCE,
  };
}

function methodPositions(symbols: readonly DocumentSymbol[], source: SwiftSource): {
  positions: {
    name: string; position: Position; currentPosition?: Position;
    signature?: string; ownerPath?: string; ambiguousSignature?: boolean;
  }[];
  missingPositions: number;
} {
  const positions: {
    name: string; position: Position; currentPosition?: Position;
    signature?: string; ownerPath?: string; ambiguousSignature?: boolean;
  }[] = [];
  let missingPositions = 0;
  const currentPositions = new Set<string>();
  const visit = (symbol: DocumentSymbol, owners: readonly string[] = []) => {
    if (symbol.kind === 6 || symbol.kind === 12) {
      const name = functionName(symbol.name);
      const current = name && symbol.selectionRange?.start
        ? sourcePosition(source, name, symbol.selectionRange.start) : null;
      if (current && name) {
        // Query SourceKit at its own documentSymbol coordinates. The current
        // source anchor is for identity/evidence only, not for LSP requests.
        positions.push({
          name, position: symbol.selectionRange.start, currentPosition: current,
          signature: symbol.name, ...(owners.length ? { ownerPath: owners.join(".") } : {}),
        });
        currentPositions.add(`${current.line}:${current.character}`);
      }
      else missingPositions++;
    }
    // Only declarations of enclosing Swift types identify a method owner.
    const isType = [5, 10, 11, 23].includes(symbol.kind);
    const typeName = isType ? symbol.name.match(/^[A-Za-z_][A-Za-z_0-9]*/)?.[0] : undefined;
    const childrenOwners = typeName ? [...owners, typeName] : owners;
    for (const child of symbol.children ?? []) visit(child, childrenOwners);
  };
  for (const symbol of symbols) visit(symbol);
  const signatureCounts = new Map<string, number>();
  for (const method of positions) {
    if (!method.ownerPath || !method.signature) continue;
    const key = method.ownerPath + ":" + method.signature;
    signatureCounts.set(key, (signatureCounts.get(key) ?? 0) + 1);
  }
  for (const method of positions) {
    if (!method.ownerPath || !method.signature) continue;
    method.ambiguousSignature =
      (signatureCounts.get(method.ownerPath + ":" + method.signature) ?? 0) > 1;
  }
  if (symbols.length > 0 && missingPositions === 0) {
    // Probe current lexical function tokens not exposed by a partial documentSymbol
    // response. Only SourceKit prepare/outgoing confirmation can create call facts.
    for (const decl of source.declarations) {
      const position = { line: decl.line - 1, character: decl.column - 1 };
      const key = `${position.line}:${position.character}`;
      if (currentPositions.has(key)) continue;
      // Extra probes are still SourceKit requests, never inferred call edges.
      positions.push({ name: decl.name, position });
      currentPositions.add(key);
    }
    positions.sort((a, b) => a.position.line - b.position.line
      || a.position.character - b.position.character);
  }
  return { positions, missingPositions };
}

function matchesQualifiedOwner(
  item: HierarchyItem,
  method: { signature?: string; ownerPath?: string },
): boolean {
  if (!method.signature || !method.ownerPath) return false;
  const suffix = "." + method.signature;
  if (!item.name.endsWith(suffix)) return false;
  const actualOwner = item.name.slice(0, -suffix.length);
  // SourceKit can qualify with a module name. The declared type chain must
  // still match, not merely the common method name.
  return actualOwner === method.ownerPath || actualOwner.endsWith("." + method.ownerPath);
}

class LspSession {
  readonly #child: ChildProcessWithoutNullStreams;
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  readonly #pending = new Map<number, {
    resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout;
  }>();
  #failed: Error | undefined;

  constructor(rootPath: string, executable: string) {
    const throughXcrun = executable.endsWith("/xcrun") || executable === "xcrun";
    this.#child = spawn(executable,
      throughXcrun ? ["sourcekit-lsp", "--default-workspace-type", "buildServer"]
        : ["--default-workspace-type", "buildServer"],
      { cwd: rootPath, stdio: ["pipe", "pipe", "pipe"] });
    this.#child.stdout.on("data", (chunk: Buffer) => this.#receive(chunk));
    this.#child.stderr.resume(); // SourceKit writes substantial diagnostics to stderr.
    this.#child.stdin.on("error", (error: Error) => this.#fail(error));
    this.#child.on("error", (error: Error) => this.#fail(error));
    this.#child.on("exit", (code) => this.#fail(new Error("SourceKit-LSP exited: " + code)));
  }

  #fail(error: Error): void {
    if (this.#failed) return;
    this.#failed = error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #receive(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.length > 16 * 1024 * 1024) {
      this.#fail(new Error("SourceKit-LSP frame exceeded 16 MiB")); return;
    }
    for (;;) {
      const boundary = this.#buffer.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const match = /Content-Length:\s*(\d+)/i.exec(this.#buffer.subarray(0, boundary).toString("utf8"));
      if (!match) { this.#fail(new Error("Malformed SourceKit-LSP frame")); return; }
      const size = Number(match[1]);
      if (!Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024) {
        this.#fail(new Error("Invalid SourceKit-LSP frame length")); return;
      }
      if (this.#buffer.length < boundary + 4 + size) return;
      const bytes = this.#buffer.subarray(boundary + 4, boundary + 4 + size);
      this.#buffer = this.#buffer.subarray(boundary + 4 + size);
      let reply: RpcReply;
      try { reply = JSON.parse(bytes.toString("utf8")) as RpcReply; }
      catch { this.#fail(new Error("Invalid SourceKit-LSP response")); return; }
      const pending = this.#pending.get(reply.id);
      if (!pending) continue; // Server notifications are not calls or index evidence.
      this.#pending.delete(reply.id);
      clearTimeout(pending.timer);
      if (reply.error) pending.reject(new Error("SourceKit-LSP: " + reply.error.message));
      else pending.resolve(reply.result);
    }
  }

  #send(message: object): void {
    if (this.#failed) throw this.#failed;
    const content = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
    this.#child.stdin.write("Content-Length: " + content.length + "\r\n\r\n");
    this.#child.stdin.write(content);
  }

  request<T>(method: string, params: object, timeoutMs = 20000): Promise<T> {
    if (this.#failed) return Promise.reject(this.#failed);
    return new Promise<T>((resolve, reject) => {
      const id = this.#nextId++;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("SourceKit-LSP timed out: " + method));
      }, timeoutMs);
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try { this.#send({ id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params: object): void { this.#send({ method, params }); }

  async initialize(rootPath: string): Promise<void> {
    await this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(rootPath).href,
      workspaceFolders: [{ uri: pathToFileURL(rootPath).href, name: "QuestBoard Swift" }],
      capabilities: { textDocument: {
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        callHierarchy: {}, publishDiagnostics: {},
      } },
      clientInfo: { name: "questboard-sourcekit", version: "1" },
    }, 30000);
    this.notify("initialized", {});
  }

  close(): void {
    this.#child.kill();
    this.#fail(new Error("SourceKit-LSP session closed"));
  }
}

export interface SourceKitLspProviderOptions {
  executable?: string;
  inventory?: CodeFileInventory;
  maxFiles?: number;
  maxFunctions?: number;
  /** Additional Xcode build contexts, isolated from the source repository. */
  supplementalBuilds?: readonly {
    sourcePrefixes: readonly string[];
    /** An existing .xcactivitylog file or a directory containing such logs. */
    logsPath: string;
  }[];
  /** Trusted host executable, never a command read from the indexed repository. */
  buildServerExecutable?: string;
  /** Only used for verified source symlinks in an isolated build context. */
  sourceRootAlias?: string;
  onFileResult?: (result: {
    path: string; indexed: boolean; reason?: string;
    discoveredFunctions?: number; preparedFunctions?: number; resolvedFunctions?: number;
  }) => void;
}

export class SourceKitLspProvider implements CodeIntelligenceProvider {
  readonly providerId = PROVIDER_ID;
  readonly languages = ["swift"] as const;
  readonly fidelity = "semantic-call" as const;
  readonly capabilities = { incrementalIndexing: false, impactAnalysis: false, callTrace: true };
  readonly #options: SourceKitLspProviderOptions;

  constructor(options: SourceKitLspProviderOptions = {}) { this.#options = options; }

  async #indexWithSupplementalBuilds(request: CodeIndexRequest): Promise<CodeGraphSnapshot> {
    const root = await realpath(resolve(request.rootPath));
    const files = (await (this.#options.inventory ?? new FileSystemCodeFileInventory())
      .listFiles(root)).filter(file => file.path.endsWith(".swift"))
      .sort((a, b) => a.path.localeCompare(b.path));
    const contexts = this.#options.supplementalBuilds ?? [];
    const groups = contexts.map(() => [] as typeof files);
    const primary: typeof files = [];
    for (const context of contexts) {
      if (!context.sourcePrefixes.length || context.sourcePrefixes.some(prefix =>
        !prefix.endsWith("/") || prefix.startsWith("/") || prefix.includes("\\")
        || prefix.split("/").includes(".."))) {
        throw semanticIndexFailure(new Error("Invalid supplemental Swift source prefix"));
      }
    }
    for (const file of files) {
      const matching = contexts.flatMap((context, i) =>
        context.sourcePrefixes.some(prefix => file.path.startsWith(prefix)) ? [i] : []);
      if (matching.length > 1) throw semanticIndexFailure(new Error(
        "Overlapping supplemental Swift build contexts for " + file.path));
      if (matching.length) groups[matching[0]!]!.push(file);
      else primary.push(file);
    }
    if (files.length > (this.#options.maxFiles ?? 150))
      throw semanticIndexFailure(new Error("Supplemental Swift contexts exceed the file budget"));
    const childOptions: SourceKitLspProviderOptions = { ...this.#options };
    delete childOptions.supplementalBuilds;
    const graphs: CodeGraphSnapshot[] = [];
    if (primary.length) {
      graphs.push(await new SourceKitLspProvider({
        ...childOptions, inventory: { listFiles: async () => primary },
      }).indexProject(request));
    }
    for (let i = 0; i < contexts.length; i++) {
      const assigned = groups[i]!;
      if (!assigned.length) continue;
      const workspace = await mkdtemp(join(tmpdir(), "questboard-swift-context-"));
      try {
        // The Xcode build server is scheme-scoped. Never replace the primary
        // project's buildServer.json or compiler-index cache.
        const originalBsp = JSON.parse(await readFile(join(root, "buildServer.json"), "utf8")) as {
          build_root?: string; indexStorePath?: string;
        };
        const indexStorePath = originalBsp.build_root
          ? join(originalBsp.build_root, "Index.noindex", "DataStore")
          : originalBsp.indexStorePath;
        if (!indexStorePath || !isAbsolute(indexStorePath))
          throw new Error("Supplemental Swift context requires an absolute Xcode index store");
        await writeFile(join(workspace, "buildServer.json"), JSON.stringify({
          name: "xcode build server", version: "1.3.0", bspVersion: "2.2.0",
          languages: ["swift"], argv: [this.#options.buildServerExecutable ?? "xcode-build-server"],
          kind: "manual", indexStorePath,
        }));
        const allTopLevel = new Set(files.map(file => file.path.split("/")[0]!));
        for (const part of allTopLevel) {
          if (!part || part === "." || part === "..") throw new Error("Invalid Swift source path");
          await symlink(join(root, part), join(workspace, part));
        }
        // Parsing is read-only with respect to the source project. A disposable
        // compiler database is generated inside the isolated LSP workspace.
        const logRoot = isAbsolute(contexts[i]!.logsPath)
          ? resolve(contexts[i]!.logsPath) : resolve(root, contexts[i]!.logsPath);
        const logFiles = (await stat(logRoot)).isDirectory()
          ? (await readdir(logRoot)).filter(name => name.endsWith(".xcactivitylog"))
            .map(name => join(logRoot, name))
          : [logRoot];
        const byNewest = await Promise.all(logFiles.map(async path => ({
          path, time: (await stat(path)).mtimeMs,
        })));
        byNewest.sort((a, b) => b.time - a.time);
        let found = false;
        for (const { path } of byNewest.slice(0, 8)) {
          try {
            await promisify(execFile)(this.#options.buildServerExecutable ?? "xcode-build-server",
              ["parse", "-l", path, "-o", join(workspace, ".compile")],
              { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
            const entries = JSON.parse(await readFile(join(workspace, ".compile"), "utf8")) as unknown;
            if (Array.isArray(entries) && entries.length > 0) { found = true; break; }
          } catch { /* Try an earlier completed Xcode build log. */ }
        }
        if (!found) throw new Error("No usable supplemental Swift compiler commands");
        for (const file of assigned) {
          const original = await realpath(join(root, file.path));
          const alias = await realpath(join(workspace, file.path));
          if (original !== alias) throw new Error("Supplemental Swift source is not an exact alias");
        }
        const used = graphs.reduce((sum, graph) =>
          sum + (graph.coverage?.languages.find(l => l.language === "swift")
            ?.semanticFunctionDiagnostics?.attemptedCount ?? 0), 0);
        const remaining = (this.#options.maxFunctions ?? 5000) - used;
        if (remaining <= 0) throw new Error("Supplemental Swift contexts exceed the function budget");
        graphs.push(await new SourceKitLspProvider({
          ...childOptions, maxFunctions: remaining,
          sourceRootAlias: root,
          inventory: { listFiles: async () => assigned },
        }).indexProject({ ...request, rootPath: workspace }));
      } catch (error) {
        throw semanticIndexFailure(error);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    }
    const nodes = new Map<string, CodeNode>();
    const relations = new Map<string, CodeRelation>();
    for (const graph of graphs) {
      for (const node of graph.nodes) nodes.set(node.id, nodes.get(node.id) ?? node);
      for (const relation of graph.relations) {
        const prior = relations.get(relation.id);
        if (!prior) { relations.set(relation.id, relation); continue; }
        relations.set(relation.id, {
          ...prior,
          evidence: [...new Map([...(prior.evidence ?? []), ...(relation.evidence ?? [])]
            .map(evidence => [JSON.stringify(evidence.location), evidence])).values()].slice(0, 24),
        });
      }
    }
    const swift = graphs.map(graph => graph.coverage?.languages.find(l => l.language === "swift"));
    const count = (key: "attemptedCount" | "preparedCount" | "resolvedCount"
      | "partiallyIndexedFileCount" | "missingDeclarationPositionCount"
      | "rejectedEvidenceRangeCount" | "deduplicatedEvidenceRangeCount") =>
      swift.reduce((sum, lang) => sum + (lang?.semanticFunctionDiagnostics?.[key] ?? 0), 0);
    const reasons = new Map<string, number>();
    const failures = new Map<string, number>();
    const gaps = new Map<string, number>();
    for (const lang of swift) {
      for (const item of lang?.semanticFunctionDiagnostics?.rejectedEvidenceReasons ?? [])
        reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + item.rangeCount);
      for (const item of lang?.semanticFunctionDiagnostics?.failureReasons ?? [])
        failures.set(item.reason, (failures.get(item.reason) ?? 0) + item.functionCount);
      for (const item of lang?.semanticFileGapReasons ?? [])
        gaps.set(item.reason, (gaps.get(item.reason) ?? 0) + item.fileCount);
    }
    const indexed = swift.reduce((sum, lang) => sum + (lang?.semanticIndexedFileCount ?? 0), 0);
    const degraded = indexed < files.length;
    return {
      schemaVersion: CODE_GRAPH_SCHEMA_VERSION, projectId: request.projectId,
      rootPath: request.rootPath, indexedAt: new Date().toISOString(),
      nodes: [...nodes.values()], relations: [...relations.values()],
      coverage: {
        degraded,
        providers: [{
          providerId: PROVIDER_ID, status: "fresh", fidelity: "semantic-call",
          languages: ["swift"], nodeCount: nodes.size, relationCount: relations.size,
        }],
        languages: [{
          language: "swift", fileCount: files.length,
          semanticEligibleFileCount: files.length, semanticIndexedFileCount: indexed,
          semanticFunctionDiagnostics: {
            attemptedCount: count("attemptedCount"), preparedCount: count("preparedCount"),
            resolvedCount: count("resolvedCount"),
            partiallyIndexedFileCount: count("partiallyIndexedFileCount"),
            missingDeclarationPositionCount: count("missingDeclarationPositionCount"),
            rejectedEvidenceRangeCount: count("rejectedEvidenceRangeCount"),
            deduplicatedEvidenceRangeCount: count("deduplicatedEvidenceRangeCount"),
            rejectedEvidenceReasons: [...reasons].sort(([a], [b]) => a.localeCompare(b))
              .map(([reason, rangeCount]) => ({ reason, rangeCount })),
            failureReasons: [...failures].sort(([a], [b]) => a.localeCompare(b))
              .map(([reason, functionCount]) => ({ reason, functionCount })),
            failureExamples: swift.flatMap(lang =>
              lang?.semanticFunctionDiagnostics?.failureExamples ?? []).slice(0, 16),
          },
          ...(gaps.size ? { semanticFileGapReasons: [...gaps]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([reason, fileCount]) => ({ reason, fileCount })) } : {}),
          fidelity: "semantic-call", providerIds: [PROVIDER_ID], degraded,
        }],
      },
    };
  }

  async indexProject(request: CodeIndexRequest): Promise<CodeGraphSnapshot> {
    if (this.#options.supplementalBuilds?.length)
      return this.#indexWithSupplementalBuilds(request);
    let rootPath = resolve(request.rootPath);
    const swiftFiles = (await (this.#options.inventory ?? new FileSystemCodeFileInventory())
      .listFiles(rootPath)).filter((entry) => entry.path.endsWith(".swift"))
      .sort((a, b) => a.path.localeCompare(b.path));
    const nodes = new Map<string, CodeNode>();
    const relations = new Map<string, CodeRelation>();
    let indexedFiles = 0;
    let visitedFunctions = 0;
    let preparedFunctions = 0;
    let resolvedFunctions = 0;
    let partiallyIndexedFiles = 0;
    let missingDeclarationPositions = 0;
    let rejectedEvidenceRanges = 0;
    let deduplicatedEvidenceRanges = 0;
    const rejectedEvidenceReasons = new Map<EvidenceRejectionReason, number>();
    const functionFailures = new Map<string, number>();
    const failureExamples: { path: string; symbol: string; lspLine: number; reason: string }[] = [];
    const recordFunctionFailure = (path: string, symbol: string, lspLine: number, reason: string) => {
      functionFailures.set(reason, (functionFailures.get(reason) ?? 0) + 1);
      if (failureExamples.length < 16
        && failureExamples.filter((example) => example.reason === reason).length < 4)
        failureExamples.push({ path, symbol, lspLine, reason });
    };
    const maxFiles = this.#options.maxFiles ?? 150;
    const maxFunctions = this.#options.maxFunctions ?? 5000;
    const sourceCache = new Map<string, Promise<SwiftSource | null>>();
    const reported = new Set<string>();
    const gapCounts = new Map<string, number>();
    const boundedReasons = new Set([
      "invalid_project_path", "file_size_or_content_limit", "file_read_unavailable",
      "document_symbols_unavailable", "document_symbol_positions_unavailable", "function_limit",
      "call_hierarchy_unavailable", "outgoing_calls_unavailable", "source_evidence_mismatch", "file_limit",
    ]);
    const observe = (result: Parameters<NonNullable<SourceKitLspProviderOptions["onFileResult"]>>[0]) => {
      reported.add(result.path);
      if (!result.indexed) {
        const reason = result.reason && boundedReasons.has(result.reason) ? result.reason : "sourcekit_error";
        gapCounts.set(reason, (gapCounts.get(reason) ?? 0) + 1);
      }
      this.#options.onFileResult?.(result);
    };

    if (swiftFiles.length) {
      // SourceKit and child-process cwd may return the physical workspace path
      // even when the registered root uses a macOS /var or symlink alias.
      try { rootPath = await realpath(rootPath); }
      catch (error) { throw semanticIndexFailure(error); }
      const loadSource = (path: string): Promise<SwiftSource | null> => {
        const cached = sourceCache.get(path);
        if (cached) return cached;
        const abs = resolve(rootPath, path);
        if (!abs.startsWith(rootPath + sep)) return Promise.resolve(null);
        const value = readFile(abs, "utf8")
          .then((text) => text.includes("\0") ? null : swiftSource(text))
          .catch(() => null);
        sourceCache.set(path, value);
        return value;
      };
      if (!existsSync(join(rootPath, "buildServer.json"))) {
        throw semanticIndexFailure(
          new Error("Swift semantic indexing requires a project-local Xcode BSP buildServer.json"),
        );
      }
      const executable = this.#options.executable ?? "/usr/bin/xcrun";
      let client = new LspSession(rootPath, executable);
      let consecutiveTimeouts = 0;
      try {
        await client.initialize(rootPath);
        for (const file of swiftFiles.slice(0, maxFiles)) {
          if (visitedFunctions >= maxFunctions) break;
          const abs = resolve(rootPath, file.path);
          if (!abs.startsWith(rootPath + sep)) {
            observe({ path: file.path, indexed: false, reason: "invalid_project_path" });
            continue;
          }
          let source: string;
          try {
            source = await readFile(abs, "utf8");
            if (Buffer.byteLength(source) > MAX_SWIFT_FILE_BYTES || source.includes("\0")) {
              observe({ path: file.path, indexed: false, reason: "file_size_or_content_limit" });
              continue;
            }
          } catch {
            observe({ path: file.path, indexed: false, reason: "file_read_unavailable" });
            continue;
          }
          const currentSource = swiftSource(source);
          sourceCache.set(file.path, Promise.resolve(currentSource));
          const uri = pathToFileURL(abs).href;
          try {
          client.notify("textDocument/didOpen", {
            textDocument: { uri, languageId: "swift", version: 1, text: source },
          });
          const symbols = await client.request<DocumentSymbol[] | null>(
            "textDocument/documentSymbol", { textDocument: { uri } }, 15000);
          const { positions, missingPositions } = methodPositions(symbols ?? [], currentSource);
          missingDeclarationPositions += missingPositions;
          const count = Math.min(positions.length, maxFunctions - visitedFunctions);
          let filePrepared = 0;
          let fileResolved = 0;
          let rejectedEvidence = 0;
          const methods = positions.slice(0, count);
          for (let index = 0; index < methods.length; index++) {
            const method = methods[index]!;
            const { name: queriedName, position } = method;
            if (index < count) visitedFunctions++;
            let functionFailure: string | null = "prepare_empty";
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
            const timeoutMs = attempt === 0 ? 8000 : 30000;
            const prepared = await client.request<HierarchyItem[] | null>(
              "textDocument/prepareCallHierarchy", { textDocument: { uri }, position }, timeoutMs);
            if (!prepared?.length) break;
            functionFailure = "owner_rejected";
            let ownerFound = false;
            let outgoingResolved = true;
            for (const item of prepared) {
              const exactOwner = matchesQualifiedOwner(item, method);
              const qualifiedButDifferentOwner = method.ownerPath
                && item.name.slice(0, item.name.indexOf("(")).includes(".")
                && !exactOwner;
              if (qualifiedButDifferentOwner) continue;
              // A stale SourceKit selection can overlap another same-named
              // method. Bind it to the *current documentSymbol query* only when
              // the full declared owner and signature both agree.
              const correctedItem = exactOwner && method.currentPosition && !method.ambiguousSignature
                ? { ...item, selectionRange: { ...item.selectionRange, start: method.currentPosition } }
                : item;
              const caller = await nodeForItem(rootPath, correctedItem, loadSource, this.#options.sourceRootAlias);
              const lspSelection = item.selectionRange.start;
              const sameLspPosition = lspSelection.line === position.line
                && lspSelection.character === position.character;
              const sameCurrentPosition = caller?.location?.startLine === position.line + 1
                && caller.location.startColumn === position.character + 1;
              if (!caller || caller.name !== queriedName || caller.location?.path !== file.path
                || (!sameLspPosition && !sameCurrentPosition)) continue;
              ownerFound = true;
              nodes.set(caller.id, caller);
              const outgoing = await client.request<OutgoingCall[] | null>(
                "callHierarchy/outgoingCalls", { item }, timeoutMs);
              if (!Array.isArray(outgoing)) outgoingResolved = false;
              const callerSource = await loadSource(caller.location!.path);
              if (!callerSource) continue;
              const callerStartLine = caller.location!.startLine!;
              const fallbackEndLine = callerSource.declarations.find((decl) =>
                decl.line > callerStartLine && decl.column <= caller.location!.startColumn!)?.line
                ?? callerSource.lines.length + 1;
              const bodyEnd = swiftFunctionBodyEnd(callerSource, callerStartLine,
                caller.location!.startColumn!);
              const callerEndLine = bodyEnd ? bodyEnd.line + 1 : fallbackEndLine;
              // SourceKit can include calls lexically owned by a nested local
              // function in the enclosing function's outgoingCall ranges.
              const nestedFunctionBodies: Range[] = bodyEnd
                ? callerSource.declarations.flatMap((decl) => {
                  if (decl.line <= callerStartLine || decl.line >= bodyEnd.line) return [];
                  const end = swiftFunctionBodyEnd(callerSource, decl.line, decl.column);
                  if (!end || end.line > bodyEnd.line) return [];
                  return [{ start: { line: decl.line - 1, character: decl.column - 1 },
                    end: { line: end.line - 1, character: end.character } }];
                }) : [];
              const sourceLineShift = callerStartLine - 1 - lspSelection.line;
              for (const call of outgoing ?? []) {
                const callee = await nodeForItem(rootPath, call.to, loadSource, this.#options.sourceRootAlias);
                if (!callee || !call.fromRanges?.length) continue;
                const suppliedRanges = call.fromRanges.slice(0, 24);
                const matchedPositions = new Set<string>();
                const evidence = suppliedRanges
                  .map((range) => {
                    const verified = verifiedCallRange(callerSource, range, callee,
                      callerStartLine, callerEndLine, sourceLineShift, (reason) => {
                        rejectedEvidence++;
                        rejectedEvidenceReasons.set(reason, (rejectedEvidenceReasons.get(reason) ?? 0) + 1);
                      }, bodyEnd?.character, nestedFunctionBodies);
                    if (!verified) return null;
                    const key = verified.start.line + ":" + verified.start.character;
                    if (matchedPositions.has(key)) {
                      deduplicatedEvidenceRanges++;
                      return null;
                    }
                    matchedPositions.add(key);
                    return verified;
                  })
                  .filter((range): range is Range => range !== null)
                  .map((range) => ({
                    location: {
                      path: caller.location!.path,
                      startLine: range.start.line + 1,
                      startColumn: range.start.character + 1,
                      endLine: range.end.line + 1,
                      endColumn: range.end.character + 1,
                    },
                    label: "SourceKit-LSP outgoingCall",
                  }));
                if (!evidence.length) continue;
                nodes.set(callee.id, callee);
                const key = caller.id + ":calls:" + callee.id;
                const id = identity("relation", key);
                const existing = relations.get(id);
                const merged = [...new Map([...(existing?.evidence ?? []), ...evidence]
                  .map((entry) => [JSON.stringify(entry.location), entry])).values()];
                relations.set(id, {
                  id, from: caller.id, to: callee.id, kind: "calls", confidence: 1,
                  evidence: merged.slice(0, 24), provenance: PROVENANCE,
                });
              }
            }
            if (ownerFound) {
              preparedFunctions++;
              filePrepared++;
              functionFailure = outgoingResolved ? null : "outgoing_unavailable";
              if (outgoingResolved) {
                fileResolved++;
                resolvedFunctions++;
              }
            }
            break;
              } catch (error) {
                if (!(error instanceof Error) || !error.message.includes("timed out:")) throw error;
                client.close();
                client = new LspSession(rootPath, executable);
                await client.initialize(rootPath);
                client.notify("textDocument/didOpen", {
                  textDocument: { uri, languageId: "swift", version: 1, text: source },
                });
                if (attempt === 1) {
                  recordFunctionFailure(file.path, queriedName, position.line + 1, "request_timeout");
                  throw error;
                }
              }
            }
            // A later same-file query can make SourceKit's initially empty owner available.
            // Revisit only original empty replies once; keep all owner/evidence guards unchanged.
            if (functionFailure === "prepare_empty" && index < count && count > 1) methods.push(method);
            else if (functionFailure) recordFunctionFailure(file.path, queriedName, position.line + 1, functionFailure);
          }
          const reason = symbols == null ? "document_symbols_unavailable"
            : missingPositions > 0 ? "document_symbol_positions_unavailable"
            : count !== positions.length ? "function_limit"
            : filePrepared !== count ? "call_hierarchy_unavailable"
            : fileResolved !== count ? "outgoing_calls_unavailable"
            : rejectedEvidence > 0 ? "source_evidence_mismatch"
            : undefined;
          if (!reason) indexedFiles++;
          else if (fileResolved > 0) partiallyIndexedFiles++;
          rejectedEvidenceRanges += rejectedEvidence;
          observe({
            path: file.path, indexed: !reason, ...(reason ? { reason } : {}),
            discoveredFunctions: positions.length + missingPositions,
            preparedFunctions: filePrepared, resolvedFunctions: fileResolved,
          });
          client.notify("textDocument/didClose", { textDocument: { uri } });
          consecutiveTimeouts = 0;
          } catch (error) {
            observe({
              path: file.path, indexed: false,
              reason: error instanceof Error ? error.message : "unknown_error",
            });
            if (!(error instanceof Error) || !error.message.includes("timed out:")) {
              throw new Error("SourceKit-LSP failed for " + file.path, { cause: error });
            }
            // A nonresponsive file cannot stall the rest. Mark it unindexed,
            // restart the session, and expose partial coverage if necessary.
            client.close();
            if (++consecutiveTimeouts >= 3) break;
            client = new LspSession(rootPath, executable);
            await client.initialize(rootPath);
          }
        }
        for (const [index, file] of swiftFiles.entries()) {
          if (!reported.has(file.path)) observe({ path: file.path, indexed: false,
            reason: index >= maxFiles ? "file_limit" : "function_limit" });
        }
        if ((visitedFunctions > 0 && preparedFunctions === 0)
          || (indexedFiles === 0 && preparedFunctions === 0)) {
          throw new Error("SourceKit-LSP returned no call hierarchy owners; verify Xcode build index");
        }
        if (visitedFunctions > 0 && resolvedFunctions === 0) {
          throw new Error("SourceKit-LSP returned no resolved outgoing call hierarchies; verify Xcode build index");
        }
      } catch (error) {
        // Once semantic indexing has begun, keep the last durable snapshot
        // rather than publishing a successful file-only replacement.
        throw semanticIndexFailure(error);
      } finally {
        client.close();
      }
    }

    return {
      schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
      projectId: request.projectId,
      rootPath: request.rootPath,
      indexedAt: new Date().toISOString(),
      nodes: [...nodes.values()],
      relations: [...relations.values()],
      coverage: {
        degraded: indexedFiles < swiftFiles.length,
        providers: [{
          providerId: PROVIDER_ID, status: "fresh", fidelity: "semantic-call",
          languages: ["swift"], nodeCount: nodes.size, relationCount: relations.size,
        }],
        languages: [{
          language: "swift", fileCount: swiftFiles.length,
          semanticEligibleFileCount: swiftFiles.length,
          semanticIndexedFileCount: indexedFiles,
          semanticFunctionDiagnostics: {
            attemptedCount: visitedFunctions,
            preparedCount: preparedFunctions,
            resolvedCount: resolvedFunctions,
            partiallyIndexedFileCount: partiallyIndexedFiles,
            missingDeclarationPositionCount: missingDeclarationPositions,
            rejectedEvidenceRangeCount: rejectedEvidenceRanges,
            deduplicatedEvidenceRangeCount: deduplicatedEvidenceRanges,
            rejectedEvidenceReasons: [...rejectedEvidenceReasons]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([reason, rangeCount]) => ({ reason, rangeCount })),
            failureReasons: [...functionFailures].sort(([a], [b]) => a.localeCompare(b))
              .map(([reason, functionCount]) => ({ reason, functionCount })),
            failureExamples,
          },
          ...(gapCounts.size ? { semanticFileGapReasons: [...gapCounts]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([reason, fileCount]) => ({ reason, fileCount })) } : {}),
          fidelity: "semantic-call", providerIds: [PROVIDER_ID],
          degraded: indexedFiles < swiftFiles.length,
        }],
      },
    };
  }
}
