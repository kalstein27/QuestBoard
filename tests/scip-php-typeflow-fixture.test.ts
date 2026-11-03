import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPhpLexicalScopes } from "../src/adapters/code-intelligence/php-lexical-scopes.js";
const source = "<?php\nnamespace Domain;\nclass Order { public function touch(): void {} }\nclass Refund { public function touch(): void {} }\nclass Cart { public Order $order; }\nclass Repository {\n  public static function find(): ?Order { return null; }\n  /** @return Order[] */\n  public static function list(): array { return []; }\n  /** @return array<int, Order> */\n  public static function mapped(): array { return []; }\n  /** @return Order[][] */\n  public static function grouped(): array { return []; }\n  /** @return array<int, Order[]> */\n  public static function groupedMap(): array { return []; }\n}\nclass Service {\n  public static function sameBranches(): void {\n    $order = Repository::find();\n    if ($order === null) { $order = new Order(); }\n    $order->touch();\n  }\n  public static function differentBranches(): void {\n    $item = new Order();\n    if (time() > 0) { $item = new Refund(); }\n    $item->touch();\n  }\n  public static function arrayItems(): void {\n    $items = Repository::list();\n    $first = $items[0]; $first->touch();\n    $last = array_pop($items); $last->touch();\n    $unknownItems = []; $unknown = $unknownItems[0]; $unknown->touch();\n  }\n  public static function nestedArrays(): void {\n    foreach (Repository::grouped() as $orders) {\n      foreach ($orders as $order) { $order->touch(); }\n    }\n    foreach (Repository::groupedMap() as $orders) {\n      foreach ($orders as $order) { $order->touch(); }\n    }\n    foreach (Repository::mapped() as $order) { $order->touch(); }\n  }\n  public static function cloned(Order $order): void {\n    $copy = clone $order; $copy->touch();\n  }\n  public static function typedProperty(Cart $cart): void {\n    $order = $cart->order; $order->touch();\n  }\n  public static function annotated(object $raw): void {\n    /** @var Order $order */\n    $order = $raw;\n    $order->touch();\n  }\n  public static function incompatibleUnion(Order|Refund $document): void {\n    $document->touch();\n  }\n}\n";
test("A2: PHP AST branch joins, arrays, clone and object properties preserve only proved types", async (t)=>{
  const autoload=process.env.QUESTBOARD_TEST_PHP_PARSER_AUTOLOAD;
  if (!autoload) {
    t.skip("Requires trusted PHP Parser 5 fixture at QUESTBOARD_TEST_PHP_PARSER_AUTOLOAD");
    return;
  }
  const root=mkdtempSync(join(tmpdir(),"qb-a2-php-dataflow-"));
  try {
    mkdirSync(join(root,"vendor")); mkdirSync(join(root,"src"));
    writeFileSync(join(root,"vendor/autoload.php"),"<?php require "+JSON.stringify(autoload)+";");
    writeFileSync(join(root,"src","Demo.php"),source);
    const scopes=await extractPhpLexicalScopes(root,["src/Demo.php"]);
    const all=scopes.get("src/Demo.php") ?? [];
    const find=(name:string)=> {
      const scope=all.find(s=>s.type==="method" && s.name===name && s.className==="Domain\\Service");
      assert.ok(scope,"missing method "+name); return scope;
    };
    const count=(name:string)=> (find(name).calls ?? [])
      .filter(c=>c.name==="touch" && c.className==="Domain\\Order").length;
    const unresolved=(name:string)=> (find(name).unresolvedCalls ?? [])
      .filter(c=>c.name==="touch").length;
    assert.equal(count("sameBranches"),1);
    assert.equal(count("arrayItems"),2);
    assert.equal(unresolved("arrayItems"),1,"untyped array element stays unresolved");
    assert.equal(count("nestedArrays"),3);
    assert.equal(count("cloned"),1);
    assert.equal(count("typedProperty"),1);
    assert.equal(count("annotated"),1);
    assert.equal(count("differentBranches"),0);
    assert.equal(unresolved("differentBranches"),1,"different branch class cannot be guessed");
    assert.equal(count("incompatibleUnion"),0);
    assert.equal(unresolved("incompatibleUnion"),1);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
