import assert from "node:assert/strict";
import test from "node:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { extractPhpLexicalScopes } from "../src/adapters/code-intelligence/php-lexical-scopes.js";
import { BundledScipIndexReader } from "../src/adapters/code-intelligence/scip-provider.js";
import { normalizeScipGraph } from "../src/adapters/code-intelligence/scip-normalizer.js";
import { queryCodeGraph } from "../src/application/code-map-query.js";

const source = `<?php
namespace Followup;
/**
 * @method int getTimeStamp()
 * @method static int dateModify(int $ts)
 * @method static int getCurrentTimeStamp()
 */
final class Clock {
  public static function getInstance(): self { return new self(); }
  public function __call($method, $arguments) {}
  public static function __callStatic($method, $arguments) {}
}
final class OtherClock { public function getTimeStamp(): int { return 1; } }
final class ServerType { const LIVE = 1; }
final class ResetJob {
  const DEFAULT_COUNT = 100;
  const FROM_LIVE = ServerType::LIVE;
  public static function run(int $count): void {}
  public static function issue(): void {
    Clock::getInstance()->getTimeStamp(); // exact
    Clock::getInstance()->getTimestamp(); // case object
    Clock::datemodify(1); // case static
    Clock::getTimestamp(); // invalid static dispatch
    $unknown->getTimestamp(); // unresolved receiver
  }
}
final class Wallet {
  public function lock(): void {} public function reset(): void {}
  public function setBalance(int $n): self { return $this; }
  public function setStep(int $n): self { return $this; }
}
final class WalletDAO { public static function find(int $id): ?Wallet { return null; } }
final class WalletService {
  public static function create(int $id): Wallet { return new Wallet(); }
  /** @param Wallet[] $list */
  public static function settle(int $id, array $list): void {
    $wallet = WalletDAO::find($id);
    $unsafe = static function () use ($wallet): void { $wallet->reset(); }; // nullable capture
    if ($wallet === null) { $ignored = 1; }
    $unsafe2 = static function () use ($wallet): void { $wallet->reset(); }; // nonterminal guard
    if ($wallet === null) { return; }
    $wallet->lock();
    $rollback = static function () use ($wallet): void { $wallet->reset(); }; // narrowed capture
    foreach ($list as $value) {
      $job = function () use ($value) { $value->reset(); }; // foreach capture
    }
    array_walk($list, function ($value) {
      /** @var Wallet $value */
      $value->reset(); // inline hint
      $value->reset(); // hint not propagated
    });
    foreach ($list as $value) {
      $job = function () use ($value) { $value->reset(); }; // invalidated array
    }
    $unknown = function ($value) { $value->reset(); }; // untyped
    $instance = WalletDAO::find($id);
    if (!($instance instanceof Wallet)) { return; }
    $guarded = function () use ($instance) { $instance->reset(); }; // instanceof guard
  }
}
final class MemoryObject {
  const DELETED = 0;
  public function getStatus(): int { return 1; }
  public function getData(): array { return []; }
}
final class MemoryStore {
  public static function replace(&$value): void { $value = new OtherClock(); }
  public function replaceObject(&$value): void { $value = new OtherClock(); }
  public static function find(array|object $target, bool $raw): array {
    $result = [];
    if (is_array($target) === false) {
      /** @var MemoryObject $target */
      if ($target->getStatus() !== MemoryObject::DELETED) { // d1 method condition
        $result[] = $target->getData(); // d1 method body
      }
    } else {
      array_walk_recursive($target, function ($value) use (&$result) {
        /** @var MemoryObject $value */
        if ($value->getStatus() !== MemoryObject::DELETED) { // d1 closure condition
          $result[] = $value->getData(); // d1 closure body
        }
      });
    }
    return $result;
  }
  public static function negative(object $value, bool $flag): void {
    if ($flag) {
      /** @var MemoryObject $value */
      if ($value->getStatus()) { // d1 branch known
        $value = new OtherClock();
        $value->getData(); // d1 reassigned
      }
    }
    $value->getData(); // d1 outside
    /** @var MemoryObject|OtherClock $unknown */
    if ($unknown->getStatus()) {} // d1 union
    /** @var MemoryObject $other */
    if ($unknown->getStatus()) {} // d1 other variable
  }
  public static function byReference(object $value): void {
    /** @var MemoryObject $value */
    if ($value->getStatus()) { // d1 reference before
      self::replace($value);
      $value->getData(); // d1 reference after
    }
  }
  public static function branchReference(object $value, bool $flag): void {
    /** @var MemoryObject $value */
    if ($value->getStatus()) {
      if ($flag) {
        $store = new MemoryStore();
        $store->replaceObject($value);
      }
      $value->getData(); // d1 branch reference after
    }
  }
}
final class WalletHandler {
  public function process(int $userId): void {
    $wallet = WalletDAO::find($userId);
    if ($wallet instanceof Wallet === false) {
      $wallet = WalletService::create($userId);
    }
    $wallet->lock();
    $reset = static function () use ($wallet): void {
      $wallet->setBalance(0)->setStep(0); // d2 good
    };
    $reset();
  }
  public function negative(int $id, bool $flag): void {
    $wallet = WalletDAO::find($id);
    if ($wallet instanceof Wallet === false) {
      if ($flag) $wallet = WalletService::create($id);
    }
    $unsafe = function () use ($wallet) { $wallet->setBalance(0); }; // d2 conditional
    $wallet = WalletDAO::find($id);
    if ($wallet instanceof Wallet === false) { $wallet = new OtherClock(); }
    $wrong = function () use ($wallet) { $wallet->setBalance(0); }; // d2 conflict
    $wallet = WalletDAO::find($id);
    if ($wallet instanceof Wallet === false) { $wallet = WalletDAO::find($id); }
    $nullable = function () use ($wallet) { $wallet->setBalance(0); }; // d2 nullable
  }
}
try {
  Clock::getCurrentTimeStamp(); // file static
  Clock::getInstance()->getTimeStamp(); // file object
  Clock::getInstance()->getTimestamp(); // file case
} catch (\\Throwable $e) {}
if (ServerType::LIVE === 2) { exit; } // file constant
ResetJob::run($argv[1] ?? ResetJob::DEFAULT_COUNT); // file default
`;

test("C1-C4: actual SCIP and PHP AST recover exact call/read sites and preserve lexical owners", async t => {
  const autoload = process.env.QUESTBOARD_TEST_PHP_PARSER_AUTOLOAD;
  if (!autoload) { t.skip("Trusted PHP Parser/SCIP fixture unavailable"); return; }
  const vendor = dirname(realpathSync.native(autoload));
  if (!existsSync(join(vendor, "bin/scip-php")) || !existsSync(join(dirname(vendor), "composer.lock"))) {
    t.skip("Native SCIP fixture unavailable"); return;
  }
  const root = mkdtempSync(join(tmpdir(), "questboard-c1-c4-"));
  const path = "src/Followup.php";
  try {
    mkdirSync(join(root, "src"));
    symlinkSync(vendor, join(root, "vendor"), "dir");
    writeFileSync(join(root, "composer.json"), JSON.stringify({ name: "questboard/followup-fixture", autoload: { classmap: ["src/"] } }));
    copyFileSync(join(dirname(vendor), "composer.lock"), join(root, "composer.lock"));
    writeFileSync(join(root, path), source);
    execFileSync("php", ["vendor/bin/scip-php", "--memory-limit=512M"], { cwd: root, stdio: "pipe", timeout: 60000 });
    const index = await new BundledScipIndexReader().read(join(root, "index.scip"));
    const scopes = await extractPhpLexicalScopes(root, [path]);
    const graph = normalizeScipGraph({ projectId: "c1-c4", rootPath: root, indexedAt: "2026-11-24T00:00:00Z", providerId: "scip-php", index, phpLexicalScopes: scopes, sourceTextByPath: new Map([[path, source]]) });
    const at = (marker: string) => source.split("\n").findIndex(line => line.includes(marker)) + 1;
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    const failures: string[] = [];
    const check = (className: string, name: string, kind: string, marker: string, owner: string, expected = true) => {
      const targets = graph.nodes.filter(n => n.name === name && n.canonicalIdentity.includes("/" + className + "#"));
      assert.equal(targets.length, 1, className + "::" + name);
      const matches = graph.relations.filter(e => e.to === targets[0]!.id && e.kind === kind && e.evidence?.some(ev => ev.location.path === path && ev.location.startLine === at(marker)));
      const names = matches.map(e => nodes.get(e.from)?.name ?? "unknown");
      if (expected ? names.length !== 1 || !names[0]!.startsWith(owner) : names.length !== 0) failures.push(marker + ": " + JSON.stringify(names));
    };
    check("Clock", "getTimeStamp", "calls", "// exact", "issue");
    check("Clock", "getTimeStamp", "calls", "// case object", "issue");
    check("Clock", "dateModify", "calls", "// case static", "issue");
    check("Clock", "getCurrentTimeStamp", "calls", "// file static", "Followup.php");
    check("Clock", "getTimeStamp", "calls", "// file object", "Followup.php");
    check("Clock", "getTimeStamp", "calls", "// file case", "Followup.php");
    check("ServerType", "LIVE", "reads", "// file constant", "Followup.php");
    check("ResetJob", "DEFAULT_COUNT", "reads", "// file default", "Followup.php");
    check("ServerType", "LIVE", "reads", "const FROM_LIVE", "FROM_LIVE");
    check("Wallet", "reset", "calls", "// narrowed capture", "closure@");
    check("Wallet", "reset", "calls", "// inline hint", "closure@");
    check("Wallet", "reset", "calls", "// foreach capture", "closure@");
    check("Wallet", "reset", "calls", "// instanceof guard", "closure@");
    check("Wallet", "reset", "calls", "// nullable capture", "", false);
    check("Wallet", "reset", "calls", "// untyped", "", false);
    check("Wallet", "reset", "calls", "// nonterminal guard", "", false);
    check("Wallet", "reset", "calls", "// hint not propagated", "", false);
    check("Wallet", "reset", "calls", "// invalidated array", "", false);
    check("Clock", "getTimeStamp", "calls", "// invalid static dispatch", "", false);
    check("Clock", "getTimeStamp", "calls", "// unresolved receiver", "", false);
    check("MemoryObject", "getStatus", "calls", "// d1 method condition", "find");
    check("MemoryObject", "getData", "calls", "// d1 method body", "find");
    check("MemoryObject", "getStatus", "calls", "// d1 closure condition", "closure@");
    check("MemoryObject", "getData", "calls", "// d1 closure body", "closure@");
    check("MemoryObject", "getStatus", "calls", "// d1 branch known", "negative");
    check("MemoryObject", "getData", "calls", "// d1 reassigned", "", false);
    check("MemoryObject", "getData", "calls", "// d1 outside", "", false);
    check("MemoryObject", "getStatus", "calls", "// d1 union", "", false);
    check("MemoryObject", "getStatus", "calls", "// d1 other variable", "", false);
    check("MemoryObject", "getStatus", "calls", "// d1 reference before", "byReference");
    check("MemoryObject", "getData", "calls", "// d1 reference after", "", false);
    check("MemoryObject", "getData", "calls", "// d1 branch reference after", "", false);
    check("Wallet", "setBalance", "calls", "// d2 good", "closure@");
    check("Wallet", "setStep", "calls", "// d2 good", "closure@");
    check("Wallet", "setBalance", "calls", "// d2 conditional", "", false);
    check("Wallet", "setBalance", "calls", "// d2 conflict", "", false);
    check("Wallet", "setBalance", "calls", "// d2 nullable", "", false);
    assert.deepEqual(failures, []);
    const file = graph.nodes.find(node => node.canonicalIdentity === "file:" + path)!;
    const timestamp = graph.nodes.find(node => node.name === "getTimeStamp" && node.canonicalIdentity.includes("/Clock#"))!;
    const constant = graph.nodes.find(node => node.name === "LIVE" && node.canonicalIdentity.includes("/ServerType#"))!;
    const callers = queryCodeGraph(graph, "scip-php", { operation: "relations", semantic: "callers", nodeId: timestamp.id });
    const refs = queryCodeGraph(graph, "scip-php", { operation: "relations", semantic: "referenced_by", nodeId: constant.id });
    assert.equal(callers.operation, "relations");
    assert.equal(refs.operation, "relations");
    assert.ok(callers.entries.some(entry => entry.relation.from === file.id));
    assert.ok(refs.entries.some(entry => entry.relation.from === file.id && entry.relation.kind === "reads"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});