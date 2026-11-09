/** SourceKit-LSP semantic Swift calls. Never infer edges from matching names. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

type Position = { line: number; character: number };
type Range = { start: Position; end: Position };
type DocumentSymbol = { name: string; kind: number; selectionRange: Range; children?: DocumentSymbol[] };
type HierarchyItem = { name: string; kind: number; uri: string; range: Range; selectionRange: Range; data?: unknown };
type OutgoingCall = { to: HierarchyItem; fromRanges: Range[] };
type RpcReply = { id: number; result?: unknown; error?: { code?: number; message?: string } };

const PROVIDER_ID = "sourcekit-lsp";
const PROVENANCE = [{ providerId: PROVIDER_ID, fidelity: "semantic-call" as const, freshness: "fresh" as const }];
const MAX_SWIFT_FILE_BYTES = 512 * 1024;

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

function localSwiftPath(rootPath: string, uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  let absolute: string;
  try { absolute = resolve(fileURLToPath(uri)); } catch { return null; }
  const root = resolve(rootPath);
  if (!absolute.startsWith(root + sep)) return null;
  const local = relative(root, absolute);
  return local && !isAbsolute(local) && !local.split(sep).includes("..") && local.endsWith(".swift")
    ? local.split(sep).join("/") : null;
}

function nodeForItem(rootPath: string, item: HierarchyItem): CodeNode | null {
  const path = localSwiftPath(rootPath, item.uri);
  if (!path || !item.selectionRange?.start) return null;
  // Accessors, operators and SDK declarations are not modeled as function-to-function calls.
  const name = item.name.match(/(?:^|\.)([A-Za-z_][A-Za-z_0-9]*)\s*\(/)?.[1];
  if (!name) return null;
  const start = item.selectionRange.start;
  if (!Number.isInteger(start.line) || !Number.isInteger(start.character)
      || start.line < 0 || start.character < 0) return null;
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

function methodPositions(symbols: readonly DocumentSymbol[]): Position[] {
  const positions: Position[] = [];
  const visit = (symbol: DocumentSymbol) => {
    if ((symbol.kind === 6 || symbol.kind === 12) && symbol.selectionRange?.start) {
      positions.push(symbol.selectionRange.start);
    }
    for (const child of symbol.children ?? []) visit(child);
  };
  for (const symbol of symbols) visit(symbol);
  return positions;
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
      capabilities: { textDocument: { callHierarchy: {}, publishDiagnostics: {} } },
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
  onFileResult?: (result: { path: string; indexed: boolean; reason?: string }) => void;
}

export class SourceKitLspProvider implements CodeIntelligenceProvider {
  readonly providerId = PROVIDER_ID;
  readonly languages = ["swift"] as const;
  readonly fidelity = "semantic-call" as const;
  readonly capabilities = { incrementalIndexing: false, impactAnalysis: false, callTrace: true };
  readonly #options: SourceKitLspProviderOptions;

  constructor(options: SourceKitLspProviderOptions = {}) { this.#options = options; }

  async indexProject(request: CodeIndexRequest): Promise<CodeGraphSnapshot> {
    const rootPath = resolve(request.rootPath);
    const swiftFiles = (await (this.#options.inventory ?? new FileSystemCodeFileInventory())
      .listFiles(rootPath)).filter((entry) => entry.path.endsWith(".swift"))
      .sort((a, b) => a.path.localeCompare(b.path));
    const nodes = new Map<string, CodeNode>();
    const relations = new Map<string, CodeRelation>();
    let indexedFiles = 0;
    let visitedFunctions = 0;
    let preparedFunctions = 0;
    const maxFiles = this.#options.maxFiles ?? 150;
    const maxFunctions = this.#options.maxFunctions ?? 5000;

    if (swiftFiles.length) {
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
          if (!abs.startsWith(rootPath + sep)) continue;
          let source: string;
          try {
            source = await readFile(abs, "utf8");
            if (Buffer.byteLength(source) > MAX_SWIFT_FILE_BYTES || source.includes("\0")) continue;
          } catch { continue; }
          const uri = pathToFileURL(abs).href;
          try {
          client.notify("textDocument/didOpen", {
            textDocument: { uri, languageId: "swift", version: 1, text: source },
          });
          const symbols = await client.request<DocumentSymbol[] | null>(
            "textDocument/documentSymbol", { textDocument: { uri } }, 15000);
          const positions = methodPositions(symbols ?? []);
          const count = Math.min(positions.length, maxFunctions - visitedFunctions);
          for (const position of positions.slice(0, count)) {
            visitedFunctions++;
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
            const timeoutMs = attempt === 0 ? 8000 : 30000;
            const prepared = await client.request<HierarchyItem[] | null>(
              "textDocument/prepareCallHierarchy", { textDocument: { uri }, position }, timeoutMs);
            if (!prepared?.length) break;
            for (const item of prepared) {
              const caller = nodeForItem(rootPath, item);
              if (!caller) continue;
              preparedFunctions++;
              nodes.set(caller.id, caller);
              const outgoing = await client.request<OutgoingCall[] | null>(
                "callHierarchy/outgoingCalls", { item }, timeoutMs);
              for (const call of outgoing ?? []) {
                const callee = nodeForItem(rootPath, call.to);
                if (!callee || !call.fromRanges?.length) continue;
                nodes.set(callee.id, callee);
                const key = caller.id + ":calls:" + callee.id;
                const id = identity("relation", key);
                const existing = relations.get(id);
                const evidence = call.fromRanges.slice(0, 24).map((range) => ({
                  location: {
                    path: caller.location!.path,
                    startLine: range.start.line + 1,
                    startColumn: range.start.character + 1,
                    endLine: range.end.line + 1,
                    endColumn: range.end.character + 1,
                  },
                  label: "SourceKit-LSP outgoingCall",
                }));
                const merged = [...(existing?.evidence ?? []), ...evidence];
                relations.set(id, {
                  id, from: caller.id, to: callee.id, kind: "calls", confidence: 1,
                  evidence: merged.slice(0, 24), provenance: PROVENANCE,
                });
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
                if (attempt === 1) throw error;
              }
            }
          }
          if (count === positions.length) {
            indexedFiles++;
            this.#options.onFileResult?.({ path: file.path, indexed: true });
          } else {
            this.#options.onFileResult?.({ path: file.path, indexed: false, reason: "function_limit" });
          }
          client.notify("textDocument/didClose", { textDocument: { uri } });
          consecutiveTimeouts = 0;
          } catch (error) {
            this.#options.onFileResult?.({
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
        if (visitedFunctions > 0 && preparedFunctions === 0) {
          throw new Error("SourceKit-LSP returned no call hierarchy owners; verify Xcode build index");
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
          fidelity: "semantic-call", providerIds: [PROVIDER_ID],
          degraded: indexedFiles < swiftFiles.length,
        }],
      },
    };
  }
}
