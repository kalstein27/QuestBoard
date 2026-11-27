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
    if (file === 'H.swift') return [symbol('caller()', 0)]; // stale SourceKit coordinates
    if (file === 'J.swift') return [symbol('target()', 0)]; // stale SourceKit coordinates
    if (file === 'K.swift') return [symbol('first()', 0)]; // partial documentSymbol list
    if (file === 'L.swift') return [symbol('maker()', 0)];
    if (file === 'M.swift') return [{ ...symbol('init()', 1), selectionRange: range(1, 2) }];
    if (file === 'N.swift') return [symbol('big()', 0)];
    if (file === 'O.swift' || file === 'P.swift') return [symbol('caller()', 0)];
    if (file === 'Q.swift' || file === 'R.swift') return [
      { ...symbol('Alpha', 0, 23), children: [
        { ...symbol('reduce(value:nextValue:)', 1, 6), selectionRange: range(1, 7) },
      ] },
      { ...symbol('Beta', 5, 23), children: [
        { ...symbol('reduce(value:nextValue:)', 6, 6), selectionRange: range(6, 7) },
      ] },
    ];
    if (file === 'S.swift') return [
      { ...symbol('Alpha', 0, 23), children: [
        { ...symbol('reduce(value:nextValue:)', 1, 6), selectionRange: range(1, 7) },
        { ...symbol('reduce(value:nextValue:)', 2, 6), selectionRange: range(2, 7) },
      ] },
    ];
    if (file === 'T.swift') return [{ ...symbol('Worker', 0, 23), children: [
      symbol('outer()', 1, 6), symbol('sibling()', 8, 6),
    ] }];
    if (file === 'U.swift') return [symbol('caller()', 0)];
    if (file === 'A.swift') return [{ ...symbol('Controller', 0, 23), children: [symbol('caller()', 1, 6)] }];
    return [symbol(file === 'B.swift' ? 'target()' : 'unknown()')];
  }
  if (method === 'textDocument/prepareCallHierarchy') {
    if (file === 'C.swift') return null;
    // The compiler index only understands its own stale line 0, while the
    // current source declares both functions on line 2.
    if (file === 'H.swift') return p.position.line === 0 ? [item('caller()', uri, 0)] : null;
    if (file === 'J.swift') return p.position.line === 0 ? [item('target()', uri, 0)] : null;
    if (file === 'K.swift') return p.position.line === 0 ? [item('first()', uri, 0)]
      : p.position.line === 1 ? [item('second()', uri, 0)] : null;
    if (file === 'L.swift') return [item('maker()', uri, 0)];
    if (file === 'M.swift') return [item('Widget.init()', uri, 1, 2)];
    if (file === 'N.swift') return [item('big()', uri, 0)];
    if (file === 'O.swift' || file === 'P.swift') return [item('caller()', uri, 0)];
    if (file === 'Q.swift' || file === 'R.swift') {
      if (p.position.line === 1) return [
        item((file === 'R.swift' ? 'Beta' : 'Alpha') + '.reduce(value:nextValue:)', uri, 6, 7),
      ];
      if (p.position.line === 6) return [
        item((file === 'R.swift' ? 'Alpha' : 'Beta') + '.reduce(value:nextValue:)', uri, 1, 7),
      ];
      return null;
    }
    if (file === 'S.swift') {
      if (p.position.line === 1) return [item('Alpha.reduce(value:nextValue:)', uri, 2, 7)];
      if (p.position.line === 2) return [item('Alpha.reduce(value:nextValue:)', uri, 1, 7)];
      return null;
    }
    if (file === 'T.swift') return p.position.line === 1
      ? [item('Worker.outer()', uri, 1, 5)]
      : p.position.line === 8 ? [item('Worker.sibling()', uri, 8, 5)] : null;
    if (file === 'U.swift') return [item('caller()', uri, 0)];
    if (file === 'A.swift') return [item('caller()', uri, 1)];
    return [item(file === 'B.swift' ? 'target()' : 'unknown()', uri)];
  }
  if (method === 'callHierarchy/outgoingCalls') {
    if (file === 'D.swift') return null;
    if (file === 'H.swift') return [{
      to: item('target()', uriFor('J.swift'), 0),
      fromRanges: [range(0, 16), range(0, 26), range(1, 16)],
    }];
    if (file === 'K.swift') return p.item.name === 'second()'
      ? [{ to: item('target()', uriFor('J.swift'), 0), fromRanges: [range(1, 16)] }] : [];
    if (file === 'L.swift') return [{
      to: item('Widget.init()', uriFor('M.swift'), 1, 2), fromRanges: [range(0, 15)],
    }];
    if (file === 'O.swift' || file === 'P.swift') return [{
      to: item('target()', uriFor('B.swift')), fromRanges: [range(0, 2)],
    }];
    if (file === 'Q.swift' || file === 'R.swift') return [{
      to: item('target()', uriFor('B.swift')),
      fromRanges: [range(p.item.name.startsWith('Alpha.') ? 7 : 2, 4)],
    }];
    if (file === 'T.swift') return p.item.name === 'Worker.outer()'
      ? [{ to: item('target()', uriFor('B.swift')),
        fromRanges: [range(6, 8), range(9, 8)] }] : [];
    if (file === 'U.swift') return [{ to: item('target()', uriFor('B.swift')),
      fromRanges: [range(0, 16), range(0, 45)] }];
    if (file !== 'A.swift') return [];
    return [
      { to: item('target()', uriFor('B.swift')), fromRanges: [range(1, 16), range(1, 26), range(1, 16)] },
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
    assert.deepEqual(graph.coverage?.languages[0]?.semanticFunctionDiagnostics, {
      attemptedCount: 4, preparedCount: 3, resolvedCount: 2,
      partiallyIndexedFileCount: 0, missingDeclarationPositionCount: 1,
      rejectedEvidenceRangeCount: 0,
      deduplicatedEvidenceRangeCount: 1, rejectedEvidenceReasons: [],
      failureReasons: [
        { reason: "outgoing_unavailable", functionCount: 1 },
        { reason: "prepare_empty", functionCount: 1 },
      ],
      failureExamples: [
        { path: "C.swift", symbol: "unknown", lspLine: 1, reason: "prepare_empty" },
        { path: "D.swift", symbol: "unknown", lspLine: 1, reason: "outgoing_unavailable" },
      ],
    });
    assert.equal(graph.relations.length, 1);
    const relation = graph.relations[0]!;
    assert.equal(relation.kind, "calls");
    assert.equal(graph.nodes.find(node => node.id === relation.from)?.name, "caller");
    assert.equal(graph.nodes.find(node => node.id === relation.to)?.name, "target");
    assert.deepEqual(relation.evidence?.map(e => [e.location.path, e.location.startLine, e.location.startColumn]),
      [["A.swift", 2, 17], ["A.swift", 2, 27]]);
    assert.equal(relation.provenance?.[0]?.providerId, "sourcekit-lsp");
    assert.deepEqual(graph.coverage?.languages[0]?.semanticFileGapReasons, [
      { reason: "call_hierarchy_unavailable", fileCount: 1 },
      { reason: "document_symbol_positions_unavailable", fileCount: 1 },
      { reason: "document_symbols_unavailable", fileCount: 1 },
      { reason: "outgoing_calls_unavailable", fileCount: 1 },
    ]);
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

test("Swift queries stale SourceKit coordinates but normalizes verified current-source declarations and calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "questboard-swift-stale-"));
  try {
    const executable = await swiftLspFixture(root);
    // The old position also contains a same-name call in unrelated current
    // source. It must not steal the caller's shifted evidence.
    await writeFile(join(root, "H.swift"), "let ghost = target()\n// old\nfunc caller() { target(); target() }\n");
    await writeFile(join(root, "J.swift"), "// old\n// old\nfunc target() {}\n");
    await writeFile(join(root, "K.swift"), "func first() {}\nfunc second() { target() }\n");
    const observations: Array<{ path: string; indexed: boolean; reason?: string }> = [];
    const provider = new SourceKitLspProvider({ executable,
      inventory: { listFiles: async () => ["H.swift", "J.swift", "K.swift"].map(path => ({ path })) },
      onFileResult: result => observations.push(result),
    });
    const graph = await provider.indexProject({ projectId: "stale-swift", rootPath: root });
    const caller = graph.nodes.find(node => node.name === "caller");
    const target = graph.nodes.find(node => node.name === "target");
    const second = graph.nodes.find(node => node.name === "second");
    assert.equal(caller?.location?.startLine, 3);
    assert.equal(target?.location?.startLine, 3);
    assert.equal(second?.location?.startLine, 2); // recovered from an incomplete documentSymbol response
    assert.equal(graph.relations.length, 2);
    assert.deepEqual(graph.relations.find(rel => rel.from === caller?.id)?.evidence
      ?.map(item => item.location.startLine), [3, 3]);
    assert.equal(graph.relations.find(rel => rel.from === second?.id)?.to, target?.id);
    assert.deepEqual(observations.map(entry => [entry.path, entry.indexed]),
      [["H.swift", true], ["J.swift", true], ["K.swift", true]]);
    assert.equal(graph.coverage?.languages[0]?.semanticFileGapReasons, undefined);
    assert.equal(graph.coverage?.languages[0]?.semanticFunctionDiagnostics?.partiallyIndexedFileCount, 0);
    assert.equal(graph.coverage?.languages[0]?.semanticFunctionDiagnostics?.rejectedEvidenceRangeCount, 0);
    assert.equal(graph.coverage?.languages[0]?.semanticFunctionDiagnostics?.deduplicatedEvidenceRangeCount, 1);
    assert.deepEqual(graph.coverage?.languages[0]?.semanticFunctionDiagnostics?.rejectedEvidenceReasons,
      []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Swift binds stale duplicate method selections to their verified qualified owners only", async () => {
  const root = await mkdtemp(join(tmpdir(), "questboard-swift-qualified-owner-"));
  try {
    const executable = await swiftLspFixture(root);
    const methods = [
      "struct Alpha {",
      "  func reduce(value: Int, nextValue: Int) {",
      "    target()",
      "  }",
      "}",
      "struct Beta {",
      "  func reduce(value: Int, nextValue: Int) {",
      "    target()",
      "  }",
      "}",
    ].join("\n") + "\n";
    await writeFile(join(root, "Q.swift"), methods);
    // This fixture deliberately returns the other owner's qualified name.
    await writeFile(join(root, "R.swift"), methods);
    await writeFile(join(root, "S.swift"), [
      "struct Alpha {",
      "  func reduce(value: Int, nextValue: Int) { target() }",
      "  func reduce(value: String, nextValue: String) { target() }",
      "}",
    ].join("\n") + "\n");
    await writeFile(join(root, "B.swift"), "func target() {}\n");
    const provider = new SourceKitLspProvider({ executable,
      inventory: { listFiles: async () => ["B.swift", "Q.swift", "R.swift", "S.swift"].map(path => ({ path })) },
    });
    const graph = await provider.indexProject({ projectId: "qualified-owner", rootPath: root });
    const qCallers = graph.nodes.filter(node => node.name === "reduce" && node.location?.path === "Q.swift");
    assert.deepEqual(qCallers.map(node => node.location!.startLine).sort((a, b) => a! - b!), [2, 7]);
    assert.equal(graph.nodes.some(node => node.name === "reduce" && node.location?.path === "R.swift"), false);
    assert.equal(graph.nodes.some(node => node.name === "reduce" && node.location?.path === "S.swift"), false,
      "same-owner overloads with identical LSP signatures must remain unresolved");
    assert.deepEqual(graph.relations.filter(rel => qCallers.some(node => node.id === rel.from))
      .flatMap(rel => rel.evidence?.map(entry => entry.location.startLine) ?? []).sort((a, b) => a! - b!),
      [3, 8]);
    assert.deepEqual(graph.coverage?.languages[0]?.semanticFileGapReasons,
      [{ reason: "call_hierarchy_unavailable", fileCount: 2 }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Swift constructor calls retain proven call sites when source spells Widget() rather than init()", async () => {
  const root = await mkdtemp(join(tmpdir(), "questboard-swift-constructor-"));
  try {
    const executable = await swiftLspFixture(root);
    await writeFile(join(root, "L.swift"), "func maker() { Widget() }\n");
    await writeFile(join(root, "M.swift"), "struct Widget {\n  init() {}\n}\n");
    const provider = new SourceKitLspProvider({ executable,
      inventory: { listFiles: async () => ["L.swift", "M.swift"].map(path => ({ path })) },
    });
    const graph = await provider.indexProject({ projectId: "constructor-swift", rootPath: root });
    const call = graph.relations.find(relation => relation.kind === "calls");
    assert.equal(graph.nodes.find(node => node.id === call?.to)?.name, "init");
    assert.deepEqual(call?.evidence?.map(item => [item.location.path, item.location.startLine]),
      [["L.swift", 1]]);
    assert.equal(graph.coverage?.degraded, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Swift file and function caps expose skipped files instead of silently claiming coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "questboard-swift-limits-"));
  try {
    const executable = await swiftLspFixture(root);
    await writeFile(join(root, "B.swift"), "func target() {}\n");
    await writeFile(join(root, "H.swift"), "// old\n// old\nfunc caller() { target() }\n");
    await writeFile(join(root, "Z.swift"), " ".repeat(768 * 1024 + 1));
    const observations: Array<{ path: string; indexed: boolean; reason?: string }> = [];
    const provider = new SourceKitLspProvider({ executable,
      inventory: { listFiles: async () => ["B.swift", "H.swift", "Z.swift"].map(path => ({ path })) },
      maxFunctions: 3, onFileResult: result => observations.push(result),
    });
    const graph = await provider.indexProject({ projectId: "limited-swift", rootPath: root });
    assert.equal(graph.coverage?.languages[0]?.semanticIndexedFileCount, 2);
    assert.deepEqual(observations.map(entry => [entry.path, entry.reason ?? null]),
      [["B.swift", null], ["H.swift", null], ["Z.swift", "file_size_or_content_limit"]]);
    assert.deepEqual(graph.coverage?.languages[0]?.semanticFileGapReasons,
      [{ reason: "file_size_or_content_limit", fileCount: 1 }]);
    const capped = new SourceKitLspProvider({ executable,
      inventory: { listFiles: async () => ["B.swift", "H.swift"].map(path => ({ path })) },
      maxFunctions: 1, onFileResult: result => observations.push(result),
    });
    const partial = await capped.indexProject({ projectId: "capped-swift", rootPath: root });
    assert.equal(partial.coverage?.degraded, true);
    assert.deepEqual(observations.slice(-2).map(entry => [entry.path, entry.reason ?? null]),
      [["B.swift", null], ["H.swift", "function_limit"]]);
    assert.deepEqual(partial.coverage?.languages[0]?.semanticFileGapReasons,
      [{ reason: "function_limit", fileCount: 1 }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Swift target-scale source is no longer skipped at the former 512 KiB limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "questboard-swift-large-"));
  try {
    const executable = await swiftLspFixture(root);
    await writeFile(join(root, "N.swift"), "func big() {}\n" + " ".repeat(532_831));
    const provider = new SourceKitLspProvider({ executable,
      inventory: { listFiles: async () => [{ path: "N.swift" }] },
    });
    const graph = await provider.indexProject({ projectId: "large-swift", rootPath: root });
    assert.equal(graph.coverage?.languages[0]?.semanticIndexedFileCount, 1);
    assert.equal(graph.coverage?.languages[0]?.semanticFileGapReasons, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Swift multiline nearby source evidence is recovered but ambiguous evidence is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "questboard-swift-nearby-"));
  try {
    const executable = await swiftLspFixture(root);
    await writeFile(join(root, "B.swift"), "func target() {}\n");
    await writeFile(join(root, "O.swift"), "func caller() {\n  target(\n    1\n  )\n}\n");
    await writeFile(join(root, "P.swift"), "func caller() {\n  target()\n  target()\n}\n");
    const provider = new SourceKitLspProvider({ executable,
      inventory: { listFiles: async () => ["B.swift", "O.swift", "P.swift"].map(path => ({ path })) },
    });
    const graph = await provider.indexProject({ projectId: "nearby-swift", rootPath: root });
    const from = graph.nodes.find(node => node.name === "caller" && node.location?.path === "O.swift");
    const relation = graph.relations.find(rel => rel.from === from?.id);
    assert.deepEqual(relation?.evidence?.map(ev => [ev.location.path, ev.location.startLine]),
      [["O.swift", 2]]);
    assert.equal(graph.relations.some(rel =>
      graph.nodes.find(node => node.id === rel.from)?.location?.path === "P.swift"), false);
    assert.deepEqual(graph.coverage?.languages[0]?.semanticFunctionDiagnostics?.rejectedEvidenceReasons,
      [{ reason: "ambiguous_nearby_site", rangeCount: 1 }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Swift local functions cannot truncate their parent caller or admit a sibling's call", async () => {
  const root = await mkdtemp(join(tmpdir(), "questboard-swift-nested-caller-span-"));
  try {
    const executable = await swiftLspFixture(root);
    await writeFile(join(root, "B.swift"), "func target() {}\n");
    await writeFile(join(root, "T.swift"), [
      "struct Worker {",
      "    private func outer() {",
      "        let gate: Bool = {",
      "            func isReady() -> Bool { return true }",
      "            return isReady()",
      "        }()",
      "        target()",
      "    }",
      "    private func sibling() {",
      "        target()",
      "    }",
      "}",
    ].join("\n") + "\n");
    const graph = await new SourceKitLspProvider({
      executable, inventory: { listFiles: async () => ["B.swift", "T.swift"].map(path => ({ path })) },
    }).indexProject({ projectId: "nested-caller-span", rootPath: root });
    const outer = graph.nodes.find(node => node.name === "outer" && node.location?.path === "T.swift");
    const relation = graph.relations.find(rel => rel.from === outer?.id && rel.kind === "calls");
    assert.ok(relation, "outgoing call after the nested function must be recovered");
    assert.deepEqual(relation.evidence?.map(e => [e.location.startLine, e.location.startColumn]),
      [[7, 9]], "the sibling function's call must not be attributed to outer");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Swift same-line calls after a caller's closing brace cannot become its evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "questboard-swift-inline-body-end-"));
  try {
    const executable = await swiftLspFixture(root);
    await writeFile(join(root, "B.swift"), "func target() {}\n");
    await writeFile(join(root, "U.swift"),
      "func caller() { target() }; func sibling() { target() }\n");
    const graph = await new SourceKitLspProvider({
      executable, inventory: { listFiles: async () => ["B.swift", "U.swift"].map(path => ({ path })) },
    }).indexProject({ projectId: "inline-body-end", rootPath: root });
    const caller = graph.nodes.find(node => node.name === "caller" && node.location?.path === "U.swift");
    const relation = graph.relations.find(rel => rel.from === caller?.id && rel.kind === "calls");
    assert.deepEqual(relation?.evidence?.map(e => e.location.startColumn), [17]);
  } finally { await rm(root, { recursive: true, force: true }); }
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
