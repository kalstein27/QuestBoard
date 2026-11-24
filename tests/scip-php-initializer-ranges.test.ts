import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPhpLexicalScopes } from "../src/adapters/code-intelligence/php-lexical-scopes.js";

const source = [
  "<?php",
  "namespace Fixture;",
  "final class OrderStatus {",
  "    public const PAID = 'paid', REFUNDED = 'refunded';",
  "}",
  "enum PaymentState: string {",
  "    case Paid = OrderStatus::PAID;",
  "    case Refunded = OrderStatus::REFUNDED;",
  "}",
  "final class PaymentPolicy {",
  "    /* 한글 😀 */ public const DEFAULT_STATUS = OrderStatus::PAID, FINAL_STATUSES = [OrderStatus::PAID, OrderStatus::REFUNDED];",
  "    public string $status = OrderStatus::PAID, $backup = OrderStatus::REFUNDED;",
  "    public ?string $unset;",
  "    public const LABEL = 'OrderStatus::REFUNDED';",
  "    public function status(): string {",
  "        return OrderStatus::PAID;",
  "    }",
  "}",
].join("\n");

type Range = readonly [number, number, number, number];
const lines = source.split("\n");
function slice(range: Range): string {
  return lines.slice(range[0], range[2] + 1)
    .map((line, i) => i === 0 ? line.slice(range[1]) : line)
    .map((line, i, arr) => i === arr.length - 1
      ? line.slice(0, range[3] - (range[0] === range[2] ? range[1] : 0)) : line)
    .join("\n");
}
function beforeOrEqual(a: readonly [number, number], b: readonly [number, number]): boolean {
  return a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]);
}

test("02/08: PHP Parser binds exact UTF-16 initializer ranges to each constant, enum case and property", async (t) => {
  const autoload = process.env.QUESTBOARD_TEST_PHP_PARSER_AUTOLOAD;
  if (!autoload) {
    t.skip("Set QUESTBOARD_TEST_PHP_PARSER_AUTOLOAD to a trusted PHP Parser 5 autoload.php");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "questboard-php-initializer-ranges-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "vendor"));
    writeFileSync(join(root, "vendor/autoload.php"), "<?php require " + JSON.stringify(autoload) + ";");
    writeFileSync(join(root, "src/PaymentPolicy.php"), source);
    const scopes = await extractPhpLexicalScopes(root, ["src/PaymentPolicy.php"]);
    const classes = scopes.get("src/PaymentPolicy.php")!.filter(scope => scope.type === "class");
    assert.equal(classes.length, 3);
    const policy = classes.find(scope => scope.className === "Fixture\\PaymentPolicy")!;
    const enm = classes.find(scope => scope.className === "Fixture\\PaymentState")!;
    assert.ok(policy && enm);
    const expected = [
      [policy.constantDefinitions, "DEFAULT_STATUS", "OrderStatus::PAID"],
      [policy.constantDefinitions, "FINAL_STATUSES", "[OrderStatus::PAID, OrderStatus::REFUNDED]"],
      [policy.constantDefinitions, "LABEL", "'OrderStatus::REFUNDED'"],
      [policy.propertyDefinitions, "status", "OrderStatus::PAID"],
      [policy.propertyDefinitions, "backup", "OrderStatus::REFUNDED"],
      [enm.constantDefinitions, "Paid", "OrderStatus::PAID"],
      [enm.constantDefinitions, "Refunded", "OrderStatus::REFUNDED"],
    ] as const;
    for (const [definitions, name, expression] of expected) {
      const matches = (definitions ?? []).filter(item => item.name === name);
      assert.equal(matches.length, 1, name + " must have one exact owner");
      const member = matches[0]!;
      assert.equal(slice(member.nameRange), name === "status" || name === "backup" ? "$" + name : name);
      assert.ok(member.valueRange, name + " must have valueRange");
      assert.equal(slice(member.valueRange), expression);
      const scope = definitions === enm.constantDefinitions ? enm : policy;
      assert.ok(beforeOrEqual([scope.range[0], scope.range[1]], [member.valueRange[0], member.valueRange[1]]));
      assert.ok(beforeOrEqual([member.nameRange[2], member.nameRange[3]], [member.valueRange[0], member.valueRange[1]]));
      assert.ok(beforeOrEqual([member.valueRange[2], member.valueRange[3]], [scope.range[2], scope.range[3]]));
    }
    assert.equal((policy.propertyDefinitions ?? []).find(item => item.name === "unset")?.valueRange, undefined,
      "uninitialized property must not acquire another member's initializer");
    const firstConstant = policy.constantDefinitions!.find(item => item.name === "DEFAULT_STATUS")!;
    assert.equal(firstConstant.nameRange[0], 10);
    assert.equal(firstConstant.nameRange[1], lines[10]!.indexOf("DEFAULT_STATUS"),
      "UTF-16 offset must count emoji as two code units");
    const final = policy.constantDefinitions!.find(item => item.name === "FINAL_STATUSES")!;
    assert.ok(beforeOrEqual([firstConstant.valueRange![2], firstConstant.valueRange![3]],
      [final.nameRange[0], final.nameRange[1]]), "first initializer cannot include the next declaration");
    const method = scopes.get("src/PaymentPolicy.php")!.find(scope =>
      scope.type === "method" && scope.name === "status")!;
    assert.ok(method);
    for (const member of [...(policy.propertyDefinitions ?? []), ...(policy.constantDefinitions ?? [])]) {
      if (member.valueRange) assert.ok(beforeOrEqual(
        [member.valueRange[2], member.valueRange[3]], [method.range[0], method.range[1]]),
        "initializer may not include method or nested executable scope");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});