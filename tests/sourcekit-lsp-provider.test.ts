import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SourceKitLspProvider } from "../src/adapters/code-intelligence/sourcekit-lsp-provider.js";
import { createConfiguredCodeMapService, resolveQuestBoardCodeMapConfig } from "../src/server/code-map-config.js";

test("Swift SourceKit provider stays opt-in and uses the Xcode toolchain", () => {
  const env = { QUESTBOARD_CODE_MAP: "1", QUESTBOARD_CODE_MAP_PROVIDER: "sourcekit-lsp" };
  const config = resolveQuestBoardCodeMapConfig(env);
  assert.equal(config?.provider, "sourcekit-lsp");
  assert.equal(config?.executable, "/usr/bin/xcrun");
  const service = createConfiguredCodeMapService(env);
  assert.equal(service?.providerId, "sourcekit-lsp");
  assert.equal(service?.capabilities.callTrace, true);
});

test("Swift SourceKit provider does not start a language server for projects without Swift", async () => {
  const provider = new SourceKitLspProvider({
    executable: "/does/not/exist",
    inventory: { listFiles: async () => [{ path: "src/main.ts" }] },
  });
  const graph = await provider.indexProject({ projectId: "only-ts", rootPath: "/virtual/project" });
  assert.deepEqual(graph.nodes, []);
  assert.deepEqual(graph.relations, []);
  assert.equal(graph.coverage?.languages[0]?.semanticEligibleFileCount, 0);
});

test("Swift SourceKit provider fails closed when a Swift project has no BSP configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "questboard-swift-bsp-"));
  try {
    const provider = new SourceKitLspProvider({
      executable: "/does/not/exist",
      inventory: { listFiles: async () => [{ path: "Sources/Test.swift" }] },
    });
    await assert.rejects(
      provider.indexProject({ projectId: "unconfigured", rootPath: root }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, "code_map_semantic_index_failed");
        assert.match(String(error.cause), /buildServer\.json/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Exercise the actual stdio LSP protocol and provider, without requiring Xcode in CI.
async function swiftLspFixture(root: string): Promise<string> {
  const executable = join(root, "mock-sourcekit");
  await writeFile(join(root, "buildServer.json"), "{}");
  await writeFile(executable, `#!${process.execPath}\n` + String.raw`
const { pathToFileURL, fileURLToPath } = require('node:url');
const { basename, join } = require('node:path');
const point = (line, character) => ({ line, character });
const range = (line, character) => ({ start: point(line, character), end: point(line, character + 6) });
const item = (name, uri, line = 0, column = 5) => ({ name, uri, kind: 12, range: range(line, column), selectionRange: range(line, column) });
const symbol = (name, line = 0, kind = 12) => ({ name, kind, range: range(line, 5), selectionRange: range(line, 5) });
const uriFor = name => pathToFileURL(join(process.cwd(), name)).href;
function answer(method, p) {
  if (method === 'initialize') {
    if (!p.capabilities.textDocument.documentSymbol?.hierarchicalDocumentSymbolSupport) throw new Error('hierarchical symbols required');
    return { capabilities: { callHierarchyProvider: true, documentSymbolProvider: true } };
  }
  const uri = p.textDocument?.uri ?? p.item?.uri;
  const file = basename(fileURLToPath(uri));
  if (method === 'textDocument/documentSymbol') {
    if (file === 'E.swift') return null;
    if (file === 'F.swift') return [];
    if (file === 'G.swift') return [{ name: 'flat()', kind: 12, location: { uri, range: range(0, 5) } }];
    if (file === 'A.swift') return [{ ...symbol('Controller', 0, 23), children: [symbol('caller()', 1, 6)] }];
    return [symbol(file === 'B.swift' ? 'target()' : 'unknown()')];
  }
  if (method === 'textDocument/prepareCallHierarchy') {
    if (file === 'C.swift') return null;
    if (file === 'A.swift') return [item('caller()', uri, 1)];
    return [item(file === 'B.swift' ? 'target()' : 'unknown()', uri)];
  }
  if (method === 'callHierarchy/outgoingCalls') {
    if (file === 'D.swift') return null;
    if (file !== 'A.swift') return [];
    return [
      { to: item('target()', uriFor('B.swift')), fromRanges: [range(1, 16), range(1, 26)] },
      { to: item('unknown()', uriFor('C.swift')), fromRanges: [] },
      { to: item('external()', 'file:///outside/External.swift'), fromRanges: [range(1, 40)] },
    ];
  }
  throw new Error('unexpected method ' + method);
}
let buffer = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const header = buffer.indexOf('\r\n\r\n');
    if (header < 0) return;
    const size = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, header).toString())[1]);
    if (buffer.length < header + 4 + size) return;
    const message = JSON.parse(buffer.subarray(header + 4, header + 4 + size).toString());
    buffer = buffer.subarray(header + 4 + size);
    if (message.id == null) continue;
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: answer(message.method, message.params) }));
    process.stdout.write('Content-Length: ' + body.length + '\r\n\r\n');
    process.stdout.write(body);
  }
});
`, { mode: 0o700 });
  return executable;
}

test("Swift hierarchical symbols preserve exact calls and report unresolved functions as partial coverage", async () => {
  const parent = await mkdtemp(join(tmpdir(), "questboard-swift-calls-"));
  const root = join(parent, "project");
  const alias = join(parent, "alias");
  try {
    await mkdir(root);
    await symlink(root, alias, "dir");
    const executable = await swiftLspFixture(root);
    const files = ["A.swift", "B.swift", "C.swift", "D.swift", "E.swift", "F.swift", "G.swift"];
    for (const path of files) await writeFile(join(root, path), path === "A.swift"
      ? "struct Controller {\nfunc caller() { target(); target() }\n}\n"
      : path === "B.swift" ? "func target() {}\n" : path === "F.swift" ? "// empty\n" : "func unknown() {}\n");
    const observations: unknown[] = [];
    const provider = new SourceKitLspProvider({ executable,
      inventory: { listFiles: async () => files.map(path => ({ path })) },
      onFileResult: result => observations.push(result),
    });
    const graph = await provider.indexProject({ projectId: "swift-calls", rootPath: alias });
    assert.equal(graph.rootPath, alias);
    assert.equal(graph.coverage?.degraded, true);
    assert.equal(graph.coverage?.languages[0]?.semanticEligibleFileCount, 7);
    assert.equal(graph.coverage?.languages[0]?.semanticIndexedFileCount, 3);
    assert.equal(graph.relations.length, 1);
    const relation = graph.relations[0]!;
    assert.equal(relation.kind, "calls");
    assert.equal(graph.nodes.find(node => node.id === relation.from)?.name, "caller");
    assert.equal(graph.nodes.find(node => node.id === relation.to)?.name, "target");
    assert.deepEqual(relation.evidence?.map(e => [e.location.path, e.location.startLine, e.location.startColumn]),
      [["A.swift", 2, 17], ["A.swift", 2, 27]]);
    assert.equal(relation.provenance?.[0]?.providerId, "sourcekit-lsp");
    assert.deepEqual(observations, [
      { path: "A.swift", indexed: true, discoveredFunctions: 1, preparedFunctions: 1, resolvedFunctions: 1 },
      { path: "B.swift", indexed: true, discoveredFunctions: 1, preparedFunctions: 1, resolvedFunctions: 1 },
      { path: "C.swift", indexed: false, reason: "call_hierarchy_unavailable", discoveredFunctions: 1, preparedFunctions: 0, resolvedFunctions: 0 },
      { path: "D.swift", indexed: false, reason: "outgoing_calls_unavailable", discoveredFunctions: 1, preparedFunctions: 1, resolvedFunctions: 0 },
      { path: "E.swift", indexed: false, reason: "document_symbols_unavailable", discoveredFunctions: 0, preparedFunctions: 0, resolvedFunctions: 0 },
      { path: "F.swift", indexed: true, discoveredFunctions: 0, preparedFunctions: 0, resolvedFunctions: 0 },
      { path: "G.swift", indexed: false, reason: "document_symbol_positions_unavailable", discoveredFunctions: 1, preparedFunctions: 0, resolvedFunctions: 0 },
    ]);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("Swift unresolved outgoing calls cannot replace the last-good graph with empty semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "questboard-swift-unresolved-"));
  try {
    const executable = await swiftLspFixture(root);
    await writeFile(join(root, "D.swift"), "func unknown() {}\n");
    const provider = new SourceKitLspProvider({ executable, inventory: { listFiles: async () => [{ path: "D.swift" }] } });
    await assert.rejects(provider.indexProject({ projectId: "swift-unresolved", rootPath: root }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, "code_map_semantic_index_failed");
        assert.match(String(error.cause), /no resolved outgoing call hierarchies/);
        return true;
      });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("configured Swift Code Map preserves last-good instead of persisting a file-only graph", async () => {
  const root = await mkdtemp(join(tmpdir(), "questboard-swift-guard-"));
  try {
    await writeFile(join(root, "Test.swift"), "func hello() {}\n");
    const service = createConfiguredCodeMapService({
      QUESTBOARD_CODE_MAP: "1",
      QUESTBOARD_CODE_MAP_PROVIDER: "sourcekit-lsp",
    });
    assert.ok(service);
    await assert.rejects(
      service.refresh({ projectId: "guarded-swift", rootPath: root }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, "code_map_semantic_index_failed");
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
