import assert from "node:assert/strict";
import test from "node:test";
import { normalizeScipGraph, parseScipJsonIndex, type ScipPhpLexicalScope } from "../src/adapters/code-intelligence/scip-normalizer.js";

const source = [
  "<?php",
  "namespace Fixture;",
  "final class OrderStatus {",
  "  public const PAID = 'paid', REFUNDED = 'refunded';",
  "}",
  "enum PaymentState: string {",
  "  case Paid = OrderStatus::PAID;",
  "}",
  "final class PaymentPolicy {",
  "  public const DEFAULT_STATUS = OrderStatus::PAID, FINAL_STATUSES = [OrderStatus::PAID, OrderStatus::REFUNDED];",
  "  public string $status = OrderStatus::PAID;",
  "  public ?string $unused;",
  "  public const LITERAL = 'OrderStatus::PAID';",
  "  public function initial(): string { return OrderStatus::PAID; }",
  "}",
].join("\n");
const lines = source.split("\n");
const prefix = "scip-php composer fixture/policy 1.0 Fixture/";
const status = prefix + "OrderStatus#";
const paid = status + "PAID.";
const refunded = status + "REFUNDED.";
const state = prefix + "PaymentState#";
const enumPaid = state + "Paid.";
const policy = prefix + "PaymentPolicy#";
const defaultStatus = policy + "DEFAULT_STATUS.";
const finalStatuses = policy + "FINAL_STATUSES.";
const property = policy + "$status.";
const unused = policy + "$unused.";
const literal = policy + "LITERAL.";
const method = policy + "initial().";
type Range = readonly [number, number, number, number];

function token(line: number, text: string, nth = 0): [number, number, number] {
  let start = 0;
  let offset = -1;
  for (let i = 0; i <= nth; i++) {
    offset = lines[line]!.indexOf(text, start);
    assert.ok(offset >= 0, text + " not found");
    start = offset + text.length;
  }
  return [line, offset, offset + text.length];
}
function range(line: number, text: string, nth = 0): Range {
  const [row, start, end] = token(line, text, nth);
  return [row, start, row, end];
}
function constantReference(symbol: string, line: number, name: string, nth = 0, roles = 0) {
  const [row, pos] = token(line, "OrderStatus::" + name, nth);
  const start = pos + "OrderStatus::".length;
  return { symbol, symbolRoles: roles, range: [row, start, start + name.length] };
}
const symbols = [
  [status, "OrderStatus", 0], [paid, "PAID", 0], [refunded, "REFUNDED", 0],
  [state, "PaymentState", "Enum"], [enumPaid, "Paid", 0],
  [policy, "PaymentPolicy", 0], [defaultStatus, "DEFAULT_STATUS", 0],
  [finalStatuses, "FINAL_STATUSES", 0], [property, "$status", "Property"],
  [unused, "$unused", "Property"], [literal, "LITERAL", 0], [method, "initial", "Method"],
] as const;
const definitions: Array<{ symbol: string; symbolRoles: number; range: number[] }> = [
  [status, 2, "OrderStatus"], [paid, 3, "PAID"], [refunded, 3, "REFUNDED"],
  [state, 5, "PaymentState"], [enumPaid, 6, "Paid"],
  [policy, 8, "PaymentPolicy"], [defaultStatus, 9, "DEFAULT_STATUS"],
  [finalStatuses, 9, "FINAL_STATUSES"], [property, 10, "$status"],
  [unused, 11, "$unused"], [literal, 12, "LITERAL"], [method, 13, "initial"],
].map(([symbol, line, name]) => ({ symbol: String(symbol), symbolRoles: 1, range: token(Number(line), String(name)) }));
const references = [
  constantReference(paid, 6, "PAID"),
  constantReference(paid, 9, "PAID", 0),
  constantReference(paid, 9, "PAID", 1),
  constantReference(refunded, 9, "REFUNDED"),
  constantReference(paid, 10, "PAID"),
  constantReference(paid, 13, "PAID"),
];
const member = (name: string, nameLine: number, expression: string) => ({
  name, nameRange: range(nameLine, name === "status" ? "$" + name : name),
  valueRange: range(nameLine, expression),
});
const constant = (name: string, line: number, expression: string, kind: "constant" | "enum_case") =>
  ({ ...member(name, line, expression), kind });
const scopes: ScipPhpLexicalScope[] = [
  { type: "class", className: "Fixture\\OrderStatus", nameRange: range(2, "OrderStatus"),
    range: [2, 0, 4, 1], ancestors: [],
    constantDefinitions: [
      constant("PAID", 3, "'paid'", "constant"),
      constant("REFUNDED", 3, "'refunded'", "constant"),
    ] },
  { type: "class", className: "Fixture\\PaymentState", nameRange: range(5, "PaymentState"),
    range: [5, 0, 7, 1], ancestors: [],
    constantDefinitions: [constant("Paid", 6, "OrderStatus::PAID", "enum_case")] },
  { type: "class", className: "Fixture\\PaymentPolicy", nameRange: range(8, "PaymentPolicy"),
    range: [8, 0, 14, 1], ancestors: [],
    constantDefinitions: [
      constant("DEFAULT_STATUS", 9, "OrderStatus::PAID", "constant"),
      constant("FINAL_STATUSES", 9, "[OrderStatus::PAID, OrderStatus::REFUNDED]", "constant"),
      constant("LITERAL", 12, "'OrderStatus::PAID'", "constant"),
    ],
    propertyDefinitions: [
      member("status", 10, "OrderStatus::PAID"),
      { name: "unused", nameRange: range(11, "$unused") },
    ] },
  { type: "method", className: "Fixture\\PaymentPolicy", name: "initial",
    nameRange: range(13, "initial"), range: [13, 2, 13, lines[13]!.length] },
];

function graph(
  changes: { scopes?: ScipPhpLexicalScope[]; refs?: typeof references;
    defs?: typeof definitions;
    extraSymbols?: { symbol: string; displayName: string; kind: number | string }[];
    externalSymbols?: { symbol: string; displayName: string; kind: number | string }[] } = {},
) {
  const occurrences = [...(changes.defs ?? definitions), ...(changes.refs ?? references)];
  return normalizeScipGraph({
    projectId: "initializer-reads",
    rootPath: "/isolated/php-initializer",
    indexedAt: "2026-11-17T00:00:00Z",
    providerId: "scip-php",
    index: parseScipJsonIndex({ documents: [{
      relativePath: "src/Policy.php", language: "php",
      symbols: [...symbols.map(([symbol, displayName, kind]) => ({ symbol, displayName, kind })),
        ...(changes.extraSymbols ?? [])],
      occurrences,
    }], externalSymbols: changes.externalSymbols ?? [] }),
    sourceTextByPath: new Map([["src/Policy.php", source]]),
    phpLexicalScopes: new Map([["src/Policy.php", changes.scopes ?? scopes]]),
  });
}
function reads(from: string, to: string, result = graph()) {
  const byId = new Map(result.nodes.map(node => [node.id, node.name]));
  return result.relations.filter(edge => edge.kind === "reads"
    && byId.get(edge.from) === from && byId.get(edge.to) === to);
}

test("03/08: exact native member owners recover three initializer reads and retain existing executable reads", () => {
  const result = graph();
  const expected = [
    ["Paid", "PAID", 7], ["DEFAULT_STATUS", "PAID", 10],
    ["FINAL_STATUSES", "PAID", 10], ["FINAL_STATUSES", "REFUNDED", 10],
    ["$status", "PAID", 11], ["initial", "PAID", 14],
  ] as const;
  for (const [owner, target, line] of expected) {
    const edges = reads(owner, target, result);
    assert.equal(edges.length, 1, owner + " -> " + target);
    assert.equal(edges[0]!.evidence?.length, 1);
    assert.equal(edges[0]!.evidence?.[0]?.location.startLine, line);
    assert.equal(edges[0]!.provenance?.[0]?.providerId, "scip-php");
  }
  assert.equal(result.relations.filter(edge => edge.kind === "reads").length, expected.length);
  assert.equal(result.relations.filter(edge => edge.kind === "writes" || edge.kind === "imports").length, 0);
  assert.equal(result.relations.some(edge => result.nodes.find(node => node.id === edge.from)?.name === "LITERAL"
    && edge.kind === "reads"), false, "string contents cannot manufacture reads");
});

test("03/08: misaligned definition, unknown class, duplicate native definitions and missing raw reference fail closed", () => {
  const shift = scopes.map(scope => scope.type === "class" && scope.className === "Fixture\\PaymentPolicy"
    ? { ...scope, constantDefinitions: scope.constantDefinitions!.map(item =>
      item.name === "DEFAULT_STATUS" ? { ...item, nameRange: [9, 16, 9, 30] as const } : item) }
    : scope);
  assert.equal(reads("DEFAULT_STATUS", "PAID", graph({ scopes: shift })).length, 0);
  assert.equal(reads("FINAL_STATUSES", "REFUNDED", graph({ scopes: shift })).length, 1);
  const wrongClass = scopes.map(scope => scope.type === "class" && scope.className === "Fixture\\PaymentPolicy"
    ? { ...scope, className: "Fixture\\OtherPolicy" } : scope);
  assert.equal(reads("DEFAULT_STATUS", "PAID", graph({ scopes: wrongClass })).length, 0);
  const duplicate = [...definitions, { symbol: policy + "OTHER.", symbolRoles: 1,
    range: token(9, "DEFAULT_STATUS") }];
  assert.equal(reads("DEFAULT_STATUS", "PAID", graph({ defs: duplicate })).length, 1,
    "unrelated symbol name cannot steal a declaration token");
  const shadow = policy + "SHADOW.";
  const ambiguous = [...definitions, { symbol: shadow, symbolRoles: 1,
    range: token(9, "DEFAULT_STATUS") }];
  assert.equal(reads("DEFAULT_STATUS", "PAID", graph({ defs: ambiguous,
    extraSymbols: [{ symbol: shadow, displayName: "DEFAULT_STATUS", kind: 0 }],
  })).length, 0, "two same-name SCIP definitions at the same token are ambiguous");
  assert.equal(reads("DEFAULT_STATUS", "PAID",
    graph({ refs: references.filter(ref => !(ref.symbol === paid && ref.range[0] === 9
      && ref.range[1] === constantReference(paid, 9, "PAID").range[1])) })).length, 0);
});

test("03/08: writes/imports and anonymous lexical scopes are never promoted to initializer reads", () => {
  for (const role of [2, 4]) {
    const changed = references.map(ref => ref.symbol === paid && ref.range[0] === 10
      ? { ...ref, symbolRoles: role } : ref);
    assert.equal(reads("$status", "PAID", graph({ refs: changed })).length, 0);
  }
  const anonymous: ScipPhpLexicalScope = {
    type: "anonymous", range: range(9, "OrderStatus::PAID"),
  };
  assert.equal(reads("DEFAULT_STATUS", "PAID", graph({ scopes: [...scopes, anonymous] })).length, 0);
  assert.equal(reads("FINAL_STATUSES", "REFUNDED", graph({ scopes: [...scopes, anonymous] })).length, 1);
});

test("03/08: self reference and external package symbol cannot manufacture initializer reads", () => {
  const memberRef = constantReference(paid, 9, "PAID");
  const mutated = references.map(ref => ref.symbol === paid && ref.range[0] === 9
    && ref.range[1] === memberRef.range[1] ? { ...ref, symbol: defaultStatus } : ref);
  assert.equal(reads("DEFAULT_STATUS", "DEFAULT_STATUS", graph({ refs: mutated })).length, 0);
  const external = "scip-php composer vendor/package 1.0 External#PAID.";
  const foreign = references.map(ref => ref.symbol === paid && ref.range[0] === 9
    && ref.range[1] === memberRef.range[1] ? { ...ref, symbol: external } : ref);
  const result = graph({ refs: foreign,
    externalSymbols: [{ symbol: external, displayName: "PAID", kind: 0 }] });
  assert.equal(result.relations.some(edge => edge.kind === "reads"
    && result.nodes.find(node => node.id === edge.from)?.name === "DEFAULT_STATUS"), false);
});