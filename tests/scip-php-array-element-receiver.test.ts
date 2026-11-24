import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPhpLexicalScopes } from "../src/adapters/code-intelligence/php-lexical-scopes.js";
import { BundledScipIndexReader } from "../src/adapters/code-intelligence/scip-provider.js";
import { normalizeScipGraph } from "../src/adapters/code-intelligence/scip-normalizer.js";
import { queryCodeGraph } from "../src/application/code-map-query.js";

const source = [
  "<?php", "namespace Fixture;",
  "final class TeamRecord { public function increaseWin(): void {} public function setRank(int $n): void {} }",
  "final class OtherRecord { public function increaseWin(): void {} public function setRank(int $n): void {} }",
  "final class SeasonService {",
  "  /** @param array<int, TeamRecord> $records */",
  "  public function close(array $records, int $teamId): void {",
  "    $records[$teamId]->increaseWin();",
  "    $records[$teamId]->setRank(1);",
  "  }",
  "  /** @param list<TeamRecord> $records */",
  "  public function listCalls(array $records): void { $records[0]->increaseWin(); }",
  "  /** @param TeamRecord[][] $records */",
  "  public function nested(array $records, int $id): void {",
  "    $records[$id][0]->setRank(2);",
  "    $records[$id]->increaseWin();",
  "  }",
  "  /** @param array<int, TeamRecord|OtherRecord> $records */",
  "  public function union(array $records): void { $records[0]->increaseWin(); }",
  "  /** @param array<int, TeamRecord|null> $records */",
  "  public function nullable(array $records): void { $records[0]->increaseWin(); }",
  "  /** @param TeamRecord[]|null $records */",
  "  public function nullableArray(array $records): void { $records[0]->increaseWin(); }",
  "  /** @param array<int, TeamRecord> $records */",
  "  public function dynamicIndex(array $records): void { $records[$this->chooseIndex()]->increaseWin(); }",
  "  public function chooseIndex(): int { return 0; }",
  "  /** @param array<int, TeamRecord> $records */",
  "  public function replaced(array $records): void {",
  "    $records[0] = new OtherRecord();",
  "    $records[0]->increaseWin();",
  "  }",
  "  /** @param array<int, TeamRecord> $records */",
  "  public function afterBranch(array $records, bool $flag): void {",
  "    if ($flag) { $records[0] = new OtherRecord(); }",
  "    $records[0]->increaseWin();",
  "  }",
  "  /** @param array<int, TeamRecord> $records */",
  "  public function byRef(array $records): void {",
  "    foreach ($records as &$record) { $record = new OtherRecord(); }",
  "    $records[0]->increaseWin();",
  "  }",
  "  /** @param array<int, TeamRecord> $ghost */",
  "  public function phantom(): void { $ghost[0]->increaseWin(); }",
  "  /** @param array<int, TeamRecord> $records */",
  "  public function nativeMismatch(int $records): void { $records[0]->increaseWin(); }",
  "  /** @param array<int, TeamRecord> $records */",
  "  public function missingTarget(array $records): void { $records[0]->unknownCall(); }",
  "  /** @param array<int, TeamRecord> $records */",
  "  public function nestedClosure(array $records): void {",
  "    $callback = function () use ($records): void { $records[0]->increaseWin(); };",
  "  }",
  "  public function direct(TeamRecord $record): void { $record->setRank(3); }",
  "  /** @param TeamRecord[] $records */",
  "  public function unshifted(array $records): void {",
  "    array_unshift($records, new OtherRecord());",
  "    $records[0]->increaseWin();",
  "  }",
  "  /** @param TeamRecord[] $records */",
  "  public function pushed(array $records): void {",
  "    array_push($records, new OtherRecord());",
  "    $records[0]->increaseWin();",
  "  }",
  "  /** @param TeamRecord[] $records */",
  "  public function spliced(array $records): void {",
  "    array_splice($records, 0, 1, [new OtherRecord()]);",
  "    $records[0]->increaseWin();",
  "  }",
  "  /** @param TeamRecord[] $records */",
  "  public function walked(array $records): void {",
  "    array_walk($records, function (&$item): void { $item = new OtherRecord(); });",
  "    $records[0]->increaseWin();",
  "  }",
  "  /** @param TeamRecord[] $records */",
  "  public function mutatorBranch(array $records, bool $flag): void {",
  "    if ($flag) { array_unshift($records, new OtherRecord()); }",
  "    $records[0]->increaseWin();",
  "  }",
  "}",
].join("\n");

test("07/08 B3: AST accepts only a single documented array element class at the correct depth", async (t) => {
  const autoload = process.env.QUESTBOARD_TEST_PHP_PARSER_AUTOLOAD;
  if (!autoload) { t.skip("Trusted PHP Parser 5 autoload unavailable"); return; }
  const root = mkdtempSync(join(tmpdir(), "questboard-b3-array-element-"));
  try {
    mkdirSync(join(root, "src")); mkdirSync(join(root, "vendor"));
    writeFileSync(join(root, "vendor/autoload.php"), "<?php require " + JSON.stringify(autoload) + ";");
    writeFileSync(join(root, "src/SeasonService.php"), source);
    const scopes = (await extractPhpLexicalScopes(root, ["src/SeasonService.php"]))
      .get("src/SeasonService.php")!;
    const method = (name: string) => scopes.find(scope => scope.type === "method" && scope.name === name)!;
    const positive: Array<[string, string[]]> = [
      ["close", ["increaseWin", "setRank"]],
      ["listCalls", ["increaseWin"]],
      ["nested", ["setRank"]],
      ["direct", ["setRank"]],
    ];
    for (const [name, expected] of positive) {
      const calls = (method(name).calls ?? []).map(call => call.name).sort();
      assert.deepEqual(calls, expected.sort(), name);
      assert.ok((method(name).calls ?? []).every(call => call.className === "Fixture\\TeamRecord"), name);
    }
    for (const name of ["union", "nullable", "nullableArray", "replaced", "afterBranch",
      "byRef", "phantom", "nativeMismatch", "nestedClosure",
      "unshifted", "pushed", "spliced", "walked", "mutatorBranch"]) {
      assert.equal((method(name).calls ?? []).length, 0, name + " must remain unresolved or unowned");
    }
    assert.equal(method("missingTarget").calls?.[0]?.name, "unknownCall",
      "AST may identify the receiver, but only SCIP may verify its method target");
    assert.deepEqual((method("dynamicIndex").calls ?? []).map(call => call.name), ["chooseIndex"],
      "an arbitrary index expression cannot establish an array-element receiver");
    assert.equal((method("nested").unresolvedCalls ?? []).filter(call => call.name === "increaseWin").length, 1,
      "one index into a two-dimensional array must remain an array");
    assert.equal(scopes.filter(scope => scope.type === "anonymous"
      && scope.calls?.some(call => call.name === "increaseWin")).length, 0,
    "parent array annotations cannot leak into an untyped nested closure");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The real scip-php artifact is generated only in an isolated fixture;
// production Code Map and its index are never mutated by this test.
const nativeRoot = process.env.QUESTBOARD_TEST_NATIVE_SCIP_PHP_B3_ROOT;
if (nativeRoot) test("07/08 B3: native target, exact caller evidence and mismatched SCIP fail-closed", async () => {
  const root = realpathSync.native(nativeRoot);
  const index = await new BundledScipIndexReader().read(join(root, "index.scip"));
  const paths = index.documents.map(doc => doc.relativePath);
  const scopes = await extractPhpLexicalScopes(root, paths);
  const sourceTextByPath = new Map(paths.map(path => [path, readFileSync(join(root, path), "utf8")]));
  const build = () => normalizeScipGraph({
    projectId: "b3-native", rootPath: root, indexedAt: "2026-11-17T00:00:00Z",
    providerId: "scip-php", index, phpLexicalScopes: scopes, sourceTextByPath,
  });
  const graph = build();
  const node = (className: string, name: string) => graph.nodes.find(item =>
    item.name === name && item.canonicalIdentity.includes(className + "#" + name + "()"))!;
  const win = node("TeamRecord", "increaseWin"), rank = node("TeamRecord", "setRank");
  const foreign = node("OtherRecord", "increaseWin");
  const close = graph.nodes.find(item => item.name === "close")!;
  assert.ok(win && rank && foreign && close);
  const call = (result: typeof graph, from: string, to: string) => result.relations.filter(edge =>
    edge.kind === "calls" && edge.from === from && edge.to === to);
  const expected = [
    ["close", win, 6], ["close", rank, 7], ["listCalls", win, 10],
    ["nested", rank, 13], ["direct", rank, 41],
  ] as const;
  const fileLines = sourceTextByPath.get("src/SeasonService.php")!.split("\n");
  for (const [ownerName, target, indexLine] of expected) {
    const owner = graph.nodes.find(item => item.name === ownerName)!;
    const matched = call(graph, owner.id, target.id);
    assert.equal(matched.length, 1, ownerName + " -> " + target.name);
    assert.equal(matched[0]!.evidence?.length, 1);
    assert.equal(matched[0]!.evidence?.[0]?.location.startLine, indexLine);
    assert.equal(matched[0]!.evidence?.[0]?.receiverClass, "Fixture\\TeamRecord");
  }
  assert.equal(call(graph, close.id, foreign.id).length, 0, "same-named external-class method is not a target");
  for (const excluded of ["union", "nullable", "dynamicIndex", "replaced", "afterBranch",
    "unknownTarget", "nestedClosure"]) {
    const owner = graph.nodes.find(item => item.name === excluded)!;
    assert.equal(call(graph, owner.id, win.id).length, 0, excluded);
  }
  const callers = queryCodeGraph(graph, "scip-php", {
    operation: "relations", semantic: "callers", nodeId: win.id,
  });
  assert.equal(callers.operation, "relations");
  assert.ok(callers.entries.some(entry => entry.relation.from === close.id));
  assert.equal(graph.relations.filter(edge => edge.kind === "calls"
    && graph.nodes.find(item => item.id === edge.to)?.name === "unknownCall").length, 0,
    "AST-only method names must not produce native method targets");
  // If the SCIP method-owner definition cannot be aligned with the AST name,
  // neither call may be assigned to an unrelated enclosing scope.
  const unalignedScopes = new Map(scopes);
  unalignedScopes.set("src/SeasonService.php", scopes.get("src/SeasonService.php")!.map(scope =>
    scope.type === "method" && scope.name === "close"
      ? { ...scope, nameRange: [0, 0, 0, 5] as const } : scope));
  const unaligned = normalizeScipGraph({
    projectId: "b3-misaligned-owner", rootPath: root, indexedAt: "2026-11-17T00:00:00Z",
    providerId: "scip-php", index, phpLexicalScopes: unalignedScopes, sourceTextByPath,
  });
  assert.equal(unaligned.relations.filter(edge => edge.kind === "calls"
    && unaligned.nodes.find(item => item.id === edge.from)?.name === "close").length, 0,
    "misaligned caller token cannot create method calls");
  const doc = index.documents.find(item => item.relativePath === "src/SeasonService.php")!;
  const targetSite = scopes.get("src/SeasonService.php")!.find(item =>
    item.type === "method" && item.name === "close")!.calls!
    .find(item => item.name === "increaseWin")!.nameRange;
  const otherSymbol = index.documents.flatMap(item => item.occurrences).find(item =>
    (item.symbolRoles & 1) !== 0 && item.symbol.includes("OtherRecord#increaseWin()."))!.symbol;
  assert.ok(otherSymbol);
  doc.occurrences.push({ symbol: otherSymbol, symbolRoles: 0,
    range: { startLine: targetSite[0], startCharacter: targetSite[1],
      endLine: targetSite[2], endCharacter: targetSite[3] } });
  const conflicting = build();
  assert.equal(call(conflicting, close.id, win.id).length, 0,
    "a native reference at the same token to a different class blocks AST recovery");
  assert.equal(call(conflicting, close.id, rank.id).length, 1,
    "a conflict at one token cannot damage a separate proven call");
  assert.ok(fileLines.length > 0);
});