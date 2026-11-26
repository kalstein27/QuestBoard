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
final class Ticket { public function setUsed(bool $used): void {} }
final class TicketService { public static function get(int $id, int $ticket): ?Ticket { return null; } }
final class TicketHandler {
  public function process(int $id, array $ids): void {
    $wallet = WalletDAO::find($id);
    if ($wallet instanceof Wallet === false) { throw new \\RuntimeException('no wallet'); }
    $wallet->lock(); // e1 throw
    foreach ($ids as $ticketId) {
      $ticket = TicketService::get($id, $ticketId);
      if ($ticket instanceof Ticket === false) { continue; }
      $ticket->setUsed(true); // e1 continue
    }
  }
  public function returning(int $id): void {
    $wallet = WalletDAO::find($id);
    if (false === ($wallet instanceof Wallet)) { return; }
    $wallet->setBalance(0)->setStep(0); // e1 return chain
    $job = function () use ($wallet) { $wallet->reset(); }; // e1 return capture
  }
  public function breaking(array $ids): void {
    foreach ($ids as $id) {
      $wallet = WalletDAO::find($id);
      if (!($wallet instanceof Wallet)) { break; }
      $wallet->lock(); // e1 break
    }
  }
  public function exiting(int $id): void {
    $wallet = WalletDAO::find($id);
    if ($wallet instanceof Wallet === false) { exit; }
    $wallet->lock(); // e1 exit
  }
  public function conditional(int $id, bool $flag): void {
    $wallet = WalletDAO::find($id);
    if ($wallet instanceof Wallet === false) { if ($flag) return; }
    $job = function () use ($wallet) { $wallet->reset(); }; // e1 conditional capture
  }
  public function mutatedBreak(int $id, array $ids): void {
    $wallet = WalletService::create($id);
    foreach ($ids as $unused) {
      if ($wallet instanceof Wallet === false) { $wallet = new OtherClock(); break; }
      $wallet->lock();
    }
    $job = function () use ($wallet) { $wallet->reset(); }; // e1 mutated break capture
  }
}
abstract class Model {
  public function getModifiedAttributes(): array { return []; }
  public function setInsertTime(int $time): Model { return $this; }
  public function setUpdateTime(int $time): Model { return $this; }
  public function fluent(): static { return $this; }
  public function selfReturn(): self { return $this; }
}
interface InventoryContract { public function getModifiedAttributes(): array; }
final class Inventory extends Model implements InventoryContract {
  public function setIncreaseTime(int $time): void {}
}
final class InventoryDAO {
  /** @param Inventory $object */
  public static function set(Model $object): void {
    $object->getModifiedAttributes(); // f1 parent
    $object->setIncreaseTime(1); // f1 child
  }
  /** @param Inventory $object */
  public static function contract(InventoryContract $object): void {
    $object->setIncreaseTime(2); // f1 interface
  }
  /** @param Inventory $other */
  public static function wrong(Model $object): void {
    $object->setIncreaseTime(1); // f1 wrong name
  }
  /** @param Inventory $object */
  public static function unrelated(Wallet $object): void {
    $object->setIncreaseTime(1); // f1 unrelated
  }
  /** @param Inventory $object */
  public static function add(Model $object): void {
    $object->setInsertTime(1)
      ->setUpdateTime(1); // g3 narrowed parent
  }
  public static function create(): Inventory {
    $item = new Inventory();
    $item->setInsertTime(1)
      ->setUpdateTime(1); // g3 new parent
    $item->fluent()->setIncreaseTime(1); // g3 inherited static
    $item->selfReturn()->setIncreaseTime(1); // g3 self not child
    return $item;
  }
  /** @param Inventory|null $object */
  public static function checkInit(?Model $object): void {
    $object->setIncreaseTime(1); // g6 nullable doc
    $job = function () use ($object) { $object->setIncreaseTime(1); }; // g6 nullable capture
  }
  /** @param Inventory|null $object */
  public static function wrongNullable(?Wallet $object): void {
    $object->setIncreaseTime(1); // g6 unrelated
  }
}
final class NormalSchedule {
  public function getScoutId(): int { return 1; }
  public function onlyNormal(): void {}
}
final class EventSchedule { public function getScoutId(): int { return 2; } }
final class ScoutHandler {
  public function validate(NormalSchedule|EventSchedule $schedule): void {
    $schedule->getScoutId(); // f2 both
    $schedule->onlyNormal(); // f2 one
  }
  public function nullable(NormalSchedule|EventSchedule|null $schedule): void {
    $job = function () use ($schedule) { $schedule->getScoutId(); }; // f2 nullable capture
  }
  public function assigned(NormalSchedule|EventSchedule $schedule): void {
    $schedule = new Wallet();
    $schedule->getScoutId(); // f2 reassigned
  }
}
final class ShopEntry { public function setPackageType(int $n): void {} }
final class ShopHandler {
  private function groupByDay(array $rows): array { return []; }
  public function process(array $rows): void {
    $targets = [];
    foreach ($rows as $row) { $targets[] = $row; }
    /** @var ShopEntry $target */
    foreach ($targets as $target) {
      $target->setPackageType(1); // f3 value
    }
    $target->setPackageType(1); // f3 outside
    /** @var ShopEntry[] $group */
    foreach ($this->groupByDay($rows) as $group) {
      foreach ($group as $entry) {
        $entry->setPackageType(2); // f3 nested
      }
    }
    /** @var ShopEntry $other */
    foreach ($rows as $target) {
      $target->setPackageType(3); // f3 wrong name
    }
  }
  public function extra(array $rows): void {
    foreach ($rows as $row) {
      /** @var ShopEntry $row */
      $row->setPackageType(1); // g7 body
    }
    /**
     * @var string $name
     * @var ShopEntry $store
     */
    foreach ($rows as $name => $store) {
      $store->setPackageType(2); // g7 multi
    }
    /** @var NormalSchedule|EventSchedule $deck */
    foreach ($rows as $deck) {
      $deck->getScoutId(); // g7 union
      $deck = new Wallet();
      $deck->getScoutId(); // g7 reassigned
    }
    $deck->getScoutId(); // g7 outside
    /** @var ShopEntry $row */
    foreach ($rows as &$row) { $row->setPackageType(1); } // g7 byref
    /**
     * @var Wallet $conflict
     * @var ShopEntry $conflict
     */
    foreach ($rows as $conflict) { $conflict->setPackageType(1); } // g7 duplicate
  }
}
final class MissionState { public function setCount(int $n): void {} }
final class MissionHandler {
  /** @var MissionState[] */
  private array $states = [];
  /** @var list<MissionState> */
  private array $list = [];
  public function adjust(int $id): void {
    foreach ($this->states as $state) {
      $state->setCount(1); // f4 foreach
    }
    $one = $this->states[$id];
    $one->setCount(2); // f4 assignment
    $this->list[0]->setCount(3); // f4 index
  }
  public function conflict(): void {
    $this->states[0] = new Wallet();
    $one = $this->states[0];
    $one->setCount(2); // f4 conflict
  }
}
final class UserRole { public function setRole(int $n): void {} }
final class Schedule {
  public static function create(int $id): self { return new self(); }
  public function setType(int $n): void {}
}
final class RoleService {
  public static function demote(array $all, int $aceId): void {
    /** @var UserRole[] $roles */
    $roles = [];
    foreach ($all as $role) {
      if ($role->user_id !== $aceId) { $roles[] = $role; }
    }
    foreach ($roles as $role) {
      $role->setRole(0); // f5 foreach
    }
    /** @var Schedule[] $list */
    $list = [];
    for ($i = 1; $i <= 3; $i++) { $list[$i] = Schedule::create($i); }
    $list[1]->setType(9); // f5 index
  }
  public static function conflict(bool $flag): void {
    /** @var Schedule[] $list */
    $list = [];
    if ($flag) { $list[] = new Wallet(); }
    $list[0]->setType(1); // f5 conflict
    /** @var Schedule[] $list */
    $list = [];
    $list[] = 42;
    $list[0]->setType(1); // f5 scalar
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
    check("Wallet", "lock", "calls", "// e1 throw", "process");
    check("Ticket", "setUsed", "calls", "// e1 continue", "process");
    check("Wallet", "setBalance", "calls", "// e1 return chain", "returning");
    check("Wallet", "setStep", "calls", "// e1 return chain", "returning");
    check("Wallet", "reset", "calls", "// e1 return capture", "closure@");
    check("Wallet", "lock", "calls", "// e1 break", "breaking");
    check("Wallet", "lock", "calls", "// e1 exit", "exiting");
    check("Wallet", "reset", "calls", "// e1 conditional capture", "", false);
    check("Wallet", "reset", "calls", "// e1 mutated break capture", "", false);
    check("Model", "getModifiedAttributes", "calls", "// f1 parent", "set");
    check("Inventory", "setIncreaseTime", "calls", "// f1 child", "set");
    check("Inventory", "setIncreaseTime", "calls", "// f1 interface", "contract");
    check("Inventory", "setIncreaseTime", "calls", "// f1 wrong name", "", false);
    check("Inventory", "setIncreaseTime", "calls", "// f1 unrelated", "", false);
    check("Model", "setUpdateTime", "calls", "// g3 narrowed parent", "add");
    check("Model", "setUpdateTime", "calls", "// g3 new parent", "create");
    check("Inventory", "setIncreaseTime", "calls", "// g3 inherited static", "create");
    check("Inventory", "setIncreaseTime", "calls", "// g3 self not child", "", false);
    check("Inventory", "setIncreaseTime", "calls", "// g6 nullable doc", "checkInit");
    check("Inventory", "setIncreaseTime", "calls", "// g6 nullable capture", "", false);
    check("Inventory", "setIncreaseTime", "calls", "// g6 unrelated", "", false);
    check("ShopEntry", "setPackageType", "calls", "// g7 body", "extra");
    check("ShopEntry", "setPackageType", "calls", "// g7 multi", "extra");
    check("NormalSchedule", "getScoutId", "calls", "// g7 union", "extra");
    check("EventSchedule", "getScoutId", "calls", "// g7 union", "extra");
    check("NormalSchedule", "getScoutId", "calls", "// g7 reassigned", "", false);
    check("EventSchedule", "getScoutId", "calls", "// g7 outside", "", false);
    check("ShopEntry", "setPackageType", "calls", "// g7 byref", "", false);
    check("ShopEntry", "setPackageType", "calls", "// g7 duplicate", "", false);
    check("NormalSchedule", "getScoutId", "calls", "// f2 both", "validate");
    check("EventSchedule", "getScoutId", "calls", "// f2 both", "validate");
    check("NormalSchedule", "onlyNormal", "calls", "// f2 one", "validate");
    check("NormalSchedule", "getScoutId", "calls", "// f2 nullable capture", "", false);
    check("EventSchedule", "getScoutId", "calls", "// f2 nullable capture", "", false);
    check("NormalSchedule", "getScoutId", "calls", "// f2 reassigned", "", false);
    check("EventSchedule", "getScoutId", "calls", "// f2 reassigned", "", false);
    check("ShopEntry", "setPackageType", "calls", "// f3 value", "process");
    check("ShopEntry", "setPackageType", "calls", "// f3 nested", "process");
    check("ShopEntry", "setPackageType", "calls", "// f3 outside", "", false);
    check("ShopEntry", "setPackageType", "calls", "// f3 wrong name", "", false);
    check("MissionState", "setCount", "calls", "// f4 foreach", "adjust");
    check("MissionState", "setCount", "calls", "// f4 assignment", "adjust");
    check("MissionState", "setCount", "calls", "// f4 index", "adjust");
    check("MissionState", "setCount", "calls", "// f4 conflict", "", false);
    check("UserRole", "setRole", "calls", "// f5 foreach", "demote");
    check("Schedule", "setType", "calls", "// f5 index", "demote");
    check("Schedule", "setType", "calls", "// f5 conflict", "", false);
    check("Schedule", "setType", "calls", "// f5 scalar", "", false);
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
    for (const [className, method, marker] of [["Wallet", "lock", "// e1 throw"], ["Ticket", "setUsed", "// e1 continue"]] as const) {
      const target = graph.nodes.find(node => node.name === method && node.canonicalIdentity.includes("/" + className + "#"))!;
      const result = queryCodeGraph(graph, "scip-php", { operation: "relations", semantic: "callers", nodeId: target.id });
      assert.equal(result.operation, "relations");
      assert.ok(result.entries.some(entry => nodes.get(entry.relation.from)?.name === "process" && entry.relation.evidence?.some(ev => ev.location.path === path && ev.location.startLine === at(marker))));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});