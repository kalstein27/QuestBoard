import assert from "node:assert/strict";
import test from "node:test";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { extractPhpLexicalScopes } from "../src/adapters/code-intelligence/php-lexical-scopes.js";
import { BundledScipIndexReader } from "../src/adapters/code-intelligence/scip-provider.js";
import { normalizeScipGraph } from "../src/adapters/code-intelligence/scip-normalizer.js";
import { queryCodeGraph } from "../src/application/code-map-query.js";

const source = [
  "<?php",
  "namespace Fixture;",
  "final class Wallet {",
  "  public function reset(): void {}",
  "  public function setBalance(int $value): self { return $this; }",
  "  public function save(): void {}",
  "}",
  "final class OtherWallet {",
  "  public function reset(): void {}",
  "}",
  "final class WalletFactory { public static function maybe(): ?Wallet { return null; } }",
  "final class Checkout {",
  "  public function settle(Wallet $wallet, bool $flag): void {",
  "    $work = function () use ($wallet): void {",
  "      $wallet->reset();",
  "      $wallet->setBalance(0)->save();",
  "    };",
  "    $byRef = function () use (&$wallet): void { $wallet->reset(); };",
  "    $withoutUse = function (): void { $wallet->reset(); };",
  "    $unknown = function () use ($unknownWallet): void { $unknownWallet->reset(); };",
  "    if ($flag) { $ambiguous = new Wallet(); }",
  "    else { $ambiguous = new OtherWallet(); }",
  "    $conflict = function () use ($ambiguous): void { $ambiguous->reset(); };",
  "    $outer = function () use ($wallet): void {",
  "      $nested = function () use ($wallet): void { $wallet->reset(); };",
  "    };",
  "    $arrow = fn() => $wallet->reset();",
  "    $wallet->reset();",
  "  }",
  "  public function nullable(?Wallet $possibly): void {",
  "    $unsafe = function () use ($possibly): void { $possibly?->reset(); };",
  "  }",
  "  public function nullableReturn(): void {",
  "    $wallet = WalletFactory::maybe();",
  "    $unsafeReturn = function () use ($wallet): void { $wallet->reset(); };",
  "  }",
  "  public function reassigned(?Wallet $wallet): void {",
  "    $wallet = new Wallet();",
  "    $safeReassigned = function () use ($wallet): void { $wallet->reset(); };",
  "  }",
  "}",
].join("\n");

test("06/08 B2: captured native type is scoped to explicit by-value use, never by-ref or conflicting branches", async (t) => {
  const autoload = process.env.QUESTBOARD_TEST_PHP_PARSER_AUTOLOAD;
  if (!autoload) { t.skip("Trusted PHP Parser 5 autoload unavailable"); return; }
  const root = mkdtempSync(join(tmpdir(), "questboard-b2-capture-"));
  try {
    mkdirSync(join(root, "src")); mkdirSync(join(root, "vendor"));
    writeFileSync(join(root, "vendor/autoload.php"), "<?php require " + JSON.stringify(autoload) + ";");
    writeFileSync(join(root, "src/Wallet.php"), source);
    const scopes = (await extractPhpLexicalScopes(root, ["src/Wallet.php"])).get("src/Wallet.php")!;
    const anonymous = scopes.filter(scope => scope.type === "anonymous");
    const line = (snippet: string) => source.split("\n").findIndex(text => text.includes(snippet));
    const at = (lineNumber: number) => anonymous.find(scope => scope.range[0] === lineNumber);
    const main = at(line("$work = function"));
    assert.ok(main);
    assert.deepEqual(main.calls?.map(call => call.name).sort(), ["reset", "save", "setBalance"]);
    assert.ok(main.calls?.every(call => call.className === "Fixture\\Wallet"
      && call.evidenceSource !== "docblock"));
    for (const snippet of ["$byRef = function", "$withoutUse = function",
      "$unknown = function", "$conflict = function", "$arrow = fn"]) {
      const scope = at(line(snippet));
      assert.ok(scope, snippet);
      assert.equal(scope.calls?.filter(call => ["reset", "setBalance", "save"].includes(call.name)).length ?? 0, 0,
        snippet + " must not receive the outer Wallet type");
    }
    const inner = at(line("$nested = function"));
    assert.ok(inner?.calls?.some(call => call.name === "reset" && call.className === "Fixture\\Wallet"));
    const outer = at(line("$outer = function"));
    assert.ok(outer);
    assert.equal(outer.calls?.length ?? 0, 0, "nested closure calls may not leak to parent closure");
    const settle = scopes.find(scope => scope.type === "method" && scope.name === "settle");
    const directLine = source.split("\n").lastIndexOf("    $wallet->reset();");
    assert.ok(settle?.calls?.some(call => call.name === "reset"
      && call.nameRange[0] === directLine),
    "method-local direct call remains owned by settle");
    assert.ok(!settle?.calls?.some(call => [line("$work = function") + 1, line("$work = function") + 2]
      .includes(call.nameRange[0])), "closure calls must never appear in settle");
    const nullable = at(line("$unsafe = function"));
    assert.equal(nullable?.calls?.length ?? 0, 0, "nullable capture cannot prove one nonnullable receiver");
    const nullableReturn = at(line("$unsafeReturn = function"));
    assert.ok(nullableReturn, "return-value capture is a distinct anonymous scope");
    assert.equal(nullableReturn.calls?.length ?? 0, 0,
      "?Wallet returned from a method must never be promoted to a nonnullable closure receiver");
    assert.equal(nullableReturn.unresolvedCalls?.filter(call => call.name === "reset").length, 1);
    const reassigned = at(line("$safeReassigned = function"));
    assert.deepEqual(reassigned?.calls?.map(call => call.name), ["reset"],
      "a nullable parameter reassigned to a definite Wallet must be capturable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Native artifact is created in a private temporary fixture, not in QuestBoard.
const nativeRoot = process.env.QUESTBOARD_TEST_NATIVE_SCIP_PHP_B2_ROOT;
if (nativeRoot) test("06/08 B2: real native SCIP call targets and callers retain separate anonymous ownership", async () => {
  const root = realpathSync.native(nativeRoot), path = "src/Wallet.php";
  const index = await new BundledScipIndexReader().read(join(root, "index.scip"));
  const scopes = await extractPhpLexicalScopes(root, [path]);
  const graph = normalizeScipGraph({
    projectId: "b2-native", rootPath: root, indexedAt: "2026-11-17T00:00:00Z",
    providerId: "scip-php", index, phpLexicalScopes: scopes,
    sourceTextByPath: new Map([[path, readFileSync(join(root, path), "utf8")]]),
  });
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const wallet = graph.nodes.filter(node => node.canonicalIdentity.includes("Wallet#")
    && !node.canonicalIdentity.includes("OtherWallet#"));
  const reset = wallet.find(node => node.name === "reset")!;
  const balance = wallet.find(node => node.name === "setBalance")!;
  const save = wallet.find(node => node.name === "save")!;
  const settle = graph.nodes.find(node => node.name === "settle")!;
  assert.ok(reset && balance && save && settle);
  const primary = graph.nodes.find(node => node.name === "closure@15:17")!;
  const nested = graph.nodes.find(node => node.name === "closure@30:22")!;
  assert.ok(primary && nested);
  for (const target of [reset, balance, save]) {
    const edges = graph.relations.filter(edge => edge.kind === "calls"
      && edge.from === primary.id && edge.to === target.id);
    assert.equal(edges.length, 1, target.name);
    assert.equal(edges[0]!.evidence?.length, 1);
  }
  assert.equal(graph.relations.filter(edge => edge.kind === "calls"
    && edge.from === nested.id && edge.to === reset.id).length, 1);
  assert.equal(graph.relations.filter(edge => edge.kind === "calls"
    && edge.from === settle.id && edge.to === reset.id).length, 1);
  assert.ok(!graph.relations.some(edge => edge.kind === "calls"
    && nodes.get(edge.from)?.name.startsWith("closure@")
    && nodes.get(edge.to)?.canonicalIdentity.includes("OtherWallet#")),
  "same-name method on OtherWallet cannot steal typed calls");
  const callers = queryCodeGraph(graph, "scip-php",
    { operation: "relations", semantic: "callers", nodeId: reset.id });
  assert.equal(callers.operation, "relations");
  assert.ok(callers.entries.some(entry => entry.relation.from === primary.id));
  assert.ok(callers.entries.some(entry => entry.relation.from === nested.id));
  assert.ok(callers.entries.some(entry => entry.relation.from === settle.id));
});


// One native fixture covers all four review rounds. It is constructed outside
// the repository using the same trusted Composer toolchain as the AST tests.
const reviewSource = [
  "<?php", "namespace Review;",
  "final class Wallet { public function reset(): void {} }",
  "final class Repo { public static function maybe(): ?Wallet { return null; } }",
  "final class TeamRecord { public function increaseWin(): void {} }",
  "final class OtherRecord { public function increaseWin(): void {} }",
  "final class Record { public function apply(): void {} public function touch(): void {} }",
  "final class Other { public function apply(): void {} public function touch(): void {} }",
  "final class Job { public function run(): void {} }",
  "function replaceRecords(array &$records): void { $records[0] = new OtherRecord(); }",
  "class EditorParent { public function mutate(array &$records): void { $records[0] = new Other(); } }",
  "final class EditorChild extends EditorParent {}",
  "final class Holder {",
  "  public ?Wallet $wallet = null;",
  "  public function nullableProperty(): void {",
  "    $value = $this->wallet;",
  "    $fn = function () use ($value): void { $value->reset(); };",
  "  }",
  "}",
  "final class Cases {",
  "  public function nullableReturn(): void {",
  "    $value = Repo::maybe();",
  "    $fn = function () use ($value): void { $value->reset(); };",
  "  }",
  "  public function reassigned(?Wallet $value): void {",
  "    $value = new Wallet();",
  "    $safe = function () use ($value): void { $value->reset(); };",
  "  }",
  "  public function safeCoalesce(?Wallet $value): void {",
  "    $value = $value ?? new Wallet();",
  "    $safeFallback = function () use ($value): void { $value->reset(); };",
  "  }",
  "  public function safeLeft(Wallet $value): void {",
  "    $value = $value ?? Repo::maybe();",
  "    $safeLeftCapture = function () use ($value): void { $value->reset(); };",
  "  }",
  "  public function safeLeftUnknown(Wallet $value, mixed $unknown): void {",
  "    $value = $value ?? $unknown;",
  "    $safeUnknownCapture = function () use ($value): void { $value->reset(); };",
  "  }",
  "  public function stillNullable(?Wallet $value): void {",
  "    $value = $value ?? Repo::maybe();",
  "    $unsafeNullable = function () use ($value): void { $value->reset(); };",
  "  }",
  "  /** @return Other[] */",
  "  public function otherList(): array { return [new Other()]; }",
  "  /** @param Record[] $records */",
  "  public function bothSame(array $records, bool $flag): void {",
  "    if ($flag) { $records = $this->otherList(); }",
  "    else { $records = $this->otherList(); }",
  "    $records[0]->touch();",
  "  }",
  "  /** @param Record[] $records */",
  "  public function onlyOne(array $records, bool $flag): void {",
  "    if ($flag) { $records = $this->otherList(); }",
  "    $records[0]->touch();",
  "  }",
  "  /** @param TeamRecord[] $records */",
  "  public function unshifted(array $records): void { array_unshift($records, new OtherRecord()); $records[0]->increaseWin(); }",
  "  /** @param TeamRecord[] $records */",
  "  public function mutatorBranch(array $records, bool $flag): void {",
  "    if ($flag) array_unshift($records, new OtherRecord());",
  "    $records[0]->increaseWin();",
  "  }",
  "  /** @param TeamRecord[] $records */",
  "  public function customByRef(array $records): void { replaceRecords($records); $records[0]->increaseWin(); }",
  "  /** @param TeamRecord[] $records */",
  "  public function customNamedByRef(array $records): void { replaceRecords(records: $records); $records[0]->increaseWin(); }",
  "  public function changeRecords(array &$records): void { $records[0] = new Other(); }",
  "  /** @param Record[] $records */",
  "  public function methodByRef(array $records): void { $this->changeRecords($records); $records[0]->apply(); }",
  "  /** @param Record[] $records */",
  "  public function referenceAlias(array $records): void { $alias =& $records; $alias[0] = new Other(); $records[0]->apply(); }",
  "  /** @return Record[] */",
  "  public function freshRecords(): array { return [new Record()]; }",
  "  /** @param Record[] $records */",
  "  public function aliasReintroduced(array $records): void {",
  "    $alias =& $records;",
  "    $records = $this->freshRecords();",
  "    $alias[0] = new Other();",
  "    $records[0]->apply();",
  "  }",
  "  /** @param Record[] $records */",
  "  public function aliasInBranch(array $records, bool $flag): void {",
  "    if ($flag) { $alias =& $records; }",
  "    $records = $this->freshRecords();",
  "    if ($flag) { $alias[0] = new Other(); }",
  "    $records[0]->apply();",
  "  }",
  "  public function objectAliasReintroduced(Record $record): void {",
  "    $alias =& $record;",
  "    $record = new Record();",
  "    $alias = new Other();",
  "    $record->apply();",
  "  }",
  "  /** @param Record[] $records */",
  "  public function closureAliasReintroduced(array $records): void {",
  "    $change = function () use (&$records): void { $records[0] = new Other(); };",
  "    $records = $this->freshRecords();",
  "    $change();",
  "    $records[0]->apply();",
  "  }",
  "  /** @param Record[] $records */",
  "  public function closureForeach(array $records): void {",
  "    $change = function () use (&$records): void {",
  "      foreach ($records as &$item) { $item = new Other(); }",
  "    };",
  "    $records = $this->freshRecords();",
  "    $change();",
  "    $records[0]->apply();",
  "  }",
  "  /** @param Record[] $records */",
  "  public function closureUnsets(array $records): void {",
  "    $change = function () use (&$records): void { unset($records[0]); };",
  "    $records = $this->freshRecords();",
  "    $change();",
  "    $records[0]->apply();",
  "  }",
  "  /** @param Record[] $records */",
  "  public function directUnset(array $records): void {",
  "    $records = $this->freshRecords();",
  "    unset($records[0]);",
  "    $records[0]->apply();",
  "  }",
  "  /** @param Record[] $records */",
  "  public function branchIndependent(array $records, bool $flag): void {",
  "    if ($flag) { $alias =& $records; }",
  "    else { $records = $this->freshRecords(); $records[0]->apply(); }",
  "  }",
  "  /** @param Record[] $records */",
  "  public function elseifIndependent(array $records, bool $flag, bool $second): void {",
  "    if ($flag) { $alias =& $records; }",
  "    elseif ($second) { $records = $this->freshRecords(); $records[0]->apply(); }",
  "  }",
  "  /** @param Record[] $records */",
  "  public function switchIndependent(array $records, int $mode): void {",
  "    switch ($mode) {",
  "      case 1: $alias =& $records; break;",
  "      case 2: $records = $this->freshRecords(); $records[0]->apply(); break;",
  "      default: break;",
  "    }",
  "  }",
  "  /** @param Record[] $records */",
  "  public function catchAfterThrow(array $records): void {",
  "    try { throw new \\RuntimeException(); $alias =& $records; }",
  "    catch (\\Throwable $e) { $records = $this->freshRecords(); $records[0]->apply(); }",
  "  }",
  "  /** @param Record[] $records */",
  "  public function catchAfterAlias(array $records): void {",
  "    try { $alias =& $records; throw new \\RuntimeException(); }",
  "    catch (\\Throwable $e) {",
  "      $records = $this->freshRecords();",
  "      $alias[0] = new Other();",
  "      $records[0]->apply();",
  "    }",
  "  }",
  "  public function catchLeak(): void {",
  "    try { throw new \RuntimeException(); $job = new Job(); }",
  "    catch (\Throwable $e) { $job->run(); }",
  "  }",
  "  /** @param Record[] $records */",
  "  public function branchReceiver(array $records, bool $flag): void {",
  "    if ($flag) { $editor = new EditorParent(); $editor->mutate($records); }",
  "    $records[0]->touch();",
  "  }",
  "  /** @param Record[] $records */",
  "  public function inheritedReference(array $records, EditorChild $editor): void {",
  "    $editor->mutate($records); $records[0]->touch();",
  "  }",
  "  /** @param Record[] $records */",
  "  public function foreachInside(array $records): void {",
  "    foreach ($records as &$item) { $item = new Other(); $records[0]->touch(); }",
  "  }",
  "  /** @param Record[] $records */",
  "  public function firstClassCallables(array $records): void {",
  "    $functionRef = replaceRecords(...);",
  "    $methodRef = $this->changeRecords(...);",
  "    $staticRef = Repo::maybe(...);",
  "    $arrayFactory = $this->freshRecords(...);",
  "    $staticRef->reset();",
  "    $arrayFactory[0]->apply();",
  "    $records[0]->touch();",
  "  }",
  "  public function healthy(Wallet $w, TeamRecord $t, Record $r, Job $j): void {",
  "    $w->reset(); $t->increaseWin(); $r->apply(); $r->touch(); $j->run();",
  "  }",
  "}",
  "try { throw new \RuntimeException(); $job = new Job(); }",
  "catch (\Throwable $e) { $job->run(); }",
  "$safeJob = new Job(); $safeJob->run();",
].join("\n");

test("review: native SCIP retains proven calls, discards stale receivers across four review rounds", async t => {
  const autoload = process.env.QUESTBOARD_TEST_PHP_PARSER_AUTOLOAD;
  if (!autoload) { t.skip("Native SCIP review requires trusted Composer autoload"); return; }
  const vendor = dirname(realpathSync.native(autoload));
  const executable = join(vendor, "bin/scip-php");
  const composerRoot = dirname(vendor);
  if (!existsSync(executable) || !existsSync(join(composerRoot, "composer.lock"))) {
    t.skip("Native SCIP review requires scip-php in trusted Composer vendor");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "questboard-native-review-"));
  const path = "src/Review.php";
  try {
    mkdirSync(join(root, "src"));
    symlinkSync(vendor, join(root, "vendor"), "dir");
    // Reuse the installed dependency loader, not the donor project's source roots.
    writeFileSync(join(root, "composer.json"), JSON.stringify({
      name: "questboard/native-review-fixture",
      autoload: { classmap: ["src/"] },
    }));
    copyFileSync(join(composerRoot, "composer.lock"), join(root, "composer.lock"));
    writeFileSync(join(root, path), reviewSource);
    execFileSync("php", ["vendor/bin/scip-php", "--memory-limit=512M"], {
      cwd: root, stdio: "pipe", timeout: 60_000,
    });
    const index = await new BundledScipIndexReader().read(join(root, "index.scip"));
    const scopes = await extractPhpLexicalScopes(root, [path]);
    const graph = normalizeScipGraph({
      projectId: "review-native-unified", rootPath: root,
      indexedAt: "2026-11-17T00:00:00Z", providerId: "scip-php",
      index, phpLexicalScopes: scopes,
      sourceTextByPath: new Map([[path, reviewSource]]),
    });
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    const target = (className: string, name: string) => graph.nodes.find(node =>
      node.name === name && node.canonicalIdentity.includes("Review/" + className + "#" + name + "()."))!;
    const callers = (to: string) => graph.relations.filter(edge => edge.kind === "calls" && edge.to === to)
      .map(edge => nodes.get(edge.from)?.name).sort();
    const healthy = "healthy";
    assert.deepEqual(callers(target("TeamRecord", "increaseWin").id), [healthy]);
    assert.deepEqual(callers(target("Record", "apply").id),
      ["branchIndependent", "catchAfterThrow", "elseifIndependent", healthy, "switchIndependent"],
      "independent else/elseif/switch/catch paths must keep proven calls while tainted paths fail closed");
    assert.deepEqual(callers(target("Record", "touch").id), ["firstClassCallables", healthy],
      "first-class callable references must not invalidate arrays or execute mutators");
    assert.deepEqual(callers(target("Other", "touch").id), ["bothSame"],
      "identical replacements in every branch prove the new array element class");
    assert.deepEqual(callers(target("Job", "run").id), ["Review.php", healthy]);
    assert.deepEqual(callers(target("EditorParent", "mutate").id), ["branchReceiver", "inheritedReference"]);
    assert.deepEqual(callers(target("Cases", "changeRecords").id), ["methodByRef"]);
    assert.ok(!callers(target("Repo", "maybe").id).includes("firstClassCallables"),
      "first-class static callable reference does not invoke the method");
    assert.ok(!callers(target("Cases", "freshRecords").id).includes("firstClassCallables"),
      "first-class array factory reference does not invoke or return its declared array");
    const resets = callers(target("Wallet", "reset").id);
    assert.equal(resets.length, 5,
      "healthy, reassigned, fallback, nonnull-left, and nonnull-left/unknown-right closures call Wallet::reset");
    assert.ok(resets.includes(healthy) && resets.filter(name => name?.startsWith("closure@")).length === 4);
    const anonymous = scopes.get(path)?.filter(scope => scope.type === "anonymous") ?? [];
    const line = reviewSource.split("\n").findIndex(text => text.includes("$safe = function"));
    assert.ok(anonymous.some(scope => scope.range[0] === line
      && scope.calls?.some(call => call.name === "reset")), "reassigned nullable is captured");
    const fallbackLine = reviewSource.split("\n").findIndex(text => text.includes("$safeFallback = function"));
    assert.ok(anonymous.some(scope => scope.range[0] === fallbackLine
      && scope.calls?.some(call => call.name === "reset")),
    "nullable coalesce with a nonnullable fallback must be captured");
    for (const captureName of ["$safeLeftCapture", "$safeUnknownCapture"]) {
      const captureLine = reviewSource.split("\n").findIndex(text => text.includes(captureName + " = function"));
      assert.ok(anonymous.some(scope => scope.range[0] === captureLine
        && scope.calls?.some(call => call.name === "reset")),
      "a nonnullable coalesce left remains safe even with nullable or unknown right");
    }
    const excluded: Record<string, string> = {
      unshifted: "increaseWin", mutatorBranch: "increaseWin",
      customByRef: "increaseWin", customNamedByRef: "increaseWin",
      methodByRef: "apply", referenceAlias: "apply", catchLeak: "run",
      aliasReintroduced: "apply", aliasInBranch: "apply",
      objectAliasReintroduced: "apply", closureAliasReintroduced: "apply",
      closureForeach: "apply", closureUnsets: "apply", directUnset: "apply",
      catchAfterAlias: "apply",
      branchReceiver: "touch", inheritedReference: "touch", foreachInside: "touch",
      onlyOne: "touch",
      firstClassCallables: "reset",
    };
    for (const [name, badCall] of Object.entries(excluded)) {
      const owner = scopes.get(path)?.find(scope => scope.type === "method" && scope.name === name);
      assert.ok(owner);
      assert.ok(!owner.calls?.some(call => call.name === badCall), name);
      assert.ok(owner.unresolvedCalls?.some(call => call.name === badCall), name + " unresolved");
    }
    const nullableCaptures = anonymous.filter(scope => scope.range[0] !== line
      && scope.range[0] !== fallbackLine
      && !["$safeLeftCapture", "$safeUnknownCapture"].some(capture =>
        scope.range[0] === reviewSource.split("\n").findIndex(text => text.includes(capture + " = function"))));
    assert.ok(nullableCaptures.every(scope => !scope.calls?.some(call => call.name === "reset")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
