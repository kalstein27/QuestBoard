import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import test from "node:test";
import { extractPhpLexicalScopes } from "../src/adapters/code-intelligence/php-lexical-scopes.js";
import { BundledScipIndexReader } from "../src/adapters/code-intelligence/scip-provider.js";
import { normalizeScipGraph, parseScipJsonIndex, type ScipPhpLexicalScope } from "../src/adapters/code-intelligence/scip-normalizer.js";

test("04/08: native SCIP metadata UTF-8 byte offsets convert to UTF-16 before initializer owner matching", () => {
  const lines = [
    "<?php",
    "namespace Fixture;",
    "class OrderStatus { public const PAID = 'paid'; }",
    "class PaymentPolicy {",
    "  /* 한글 😀 */ public const DEFAULT_STATUS = OrderStatus::PAID;",
    "}",
  ];
  const source = lines.join("\n");
  const token = (line: number, value: string) => {
    const col = lines[line]!.indexOf(value);
    assert.ok(col >= 0);
    return [line, col, line, col + value.length] as const;
  };
  const native = (line: number, value: string) => {
    const col = lines[line]!.indexOf(value);
    assert.ok(col >= 0);
    return [line, Buffer.byteLength(lines[line]!.slice(0, col), "utf8"),
      Buffer.byteLength(lines[line]!.slice(0, col + value.length), "utf8")];
  };
  const klass = "scip-php composer fixture/a1 1.0 Fixture/OrderStatus#";
  const paid = klass + "PAID.";
  const owner = "scip-php composer fixture/a1 1.0 Fixture/PaymentPolicy#";
  const defaultStatus = owner + "DEFAULT_STATUS.";
  const valueStart = lines[4]!.indexOf("OrderStatus::PAID");
  const scopes: ScipPhpLexicalScope[] = [
    { type: "class", className: "Fixture\\OrderStatus",
      nameRange: token(2, "OrderStatus"), range: [2, 0, 2, lines[2]!.length],
      ancestors: [], constantDefinitions: [{ name: "PAID",
        nameRange: token(2, "PAID"), kind: "constant" }] },
    { type: "class", className: "Fixture\\PaymentPolicy",
      nameRange: token(3, "PaymentPolicy"), range: [3, 0, 5, 1],
      ancestors: [], constantDefinitions: [{ name: "DEFAULT_STATUS",
        nameRange: token(4, "DEFAULT_STATUS"),
        valueRange: [4, valueStart, 4, valueStart + "OrderStatus::PAID".length],
        kind: "constant" }] },
  ];
  const raw = {
    metadata: { text_document_encoding: 1 },
    documents: [{ relativePath: "src/Main.php", language: "php",
      symbols: [
        { symbol: klass, displayName: "OrderStatus", kind: "Class" },
        { symbol: paid, displayName: "PAID", kind: 0 },
        { symbol: owner, displayName: "PaymentPolicy", kind: "Class" },
        { symbol: defaultStatus, displayName: "DEFAULT_STATUS", kind: 0 },
      ],
      occurrences: [
        { symbol: klass, symbolRoles: 1, range: native(2, "OrderStatus") },
        { symbol: paid, symbolRoles: 1, range: native(2, "PAID") },
        { symbol: owner, symbolRoles: 1, range: native(3, "PaymentPolicy") },
        { symbol: defaultStatus, symbolRoles: 1, range: native(4, "DEFAULT_STATUS") },
        { symbol: paid, symbolRoles: 0,
          range: [4, Buffer.byteLength(lines[4]!.slice(0, valueStart + "OrderStatus::".length), "utf8"),
            Buffer.byteLength(lines[4]!.slice(0, valueStart + "OrderStatus::PAID".length), "utf8")] },
      ],
    }],
  };
  const index = parseScipJsonIndex(raw);
  assert.equal(index.positionEncoding, 1);
  const build = (input: typeof index) => normalizeScipGraph({
    projectId: "a1-utf8", rootPath: "/isolated/a1-utf8",
    indexedAt: "2026-11-17T00:00:00Z", providerId: "scip-php",
    index: input, phpLexicalScopes: new Map([["src/Main.php", scopes]]),
    sourceTextByPath: new Map([["src/Main.php", source]]),
  });
  const reads = (result: ReturnType<typeof build>) => {
    const names = new Map(result.nodes.map(node => [node.id, node.name]));
    return result.relations.filter(edge => edge.kind === "reads"
      && names.get(edge.from) === "DEFAULT_STATUS" && names.get(edge.to) === "PAID");
  };
  const fixed = reads(build(index));
  assert.equal(fixed.length, 1);
  assert.equal(fixed[0]!.evidence?.[0]?.location.startColumn,
    valueStart + "OrderStatus::".length + 1);
  assert.equal(reads(build(parseScipJsonIndex({ ...raw, metadata: undefined }))).length, 0,
    "without UTF-8 metadata the multibyte native byte offsets cannot match AST UTF-16 names");
});

// Opt-in integration with a genuine, independently generated scip-php
// index.scip. It never creates or reindexes an operational project.
const nativeFixture = process.env.QUESTBOARD_TEST_NATIVE_SCIP_PHP_FIXTURE_ROOT;
if (nativeFixture) test("04/08: real scip-php retains exact initializer, method and closure references", async () => {
  const root = realpathSync.native(nativeFixture);
  const relativePath = "src/PaymentPolicy.php";
  const index = await new BundledScipIndexReader().read(root + "/index.scip");
  const phpLexicalScopes = await extractPhpLexicalScopes(root, [relativePath]);
  const graph = normalizeScipGraph({
    projectId: "a1-native", rootPath: root, indexedAt: "2026-11-17T00:00:00Z",
    providerId: "scip-php", index, phpLexicalScopes,
    sourceTextByPath: new Map([[relativePath, readFileSync(root + "/" + relativePath, "utf8")]]),
  });
  assert.equal(index.positionEncoding, 1);
  const names = new Map(graph.nodes.map(node => [node.id, node.name]));
  const reads = graph.relations.filter(edge => edge.kind === "reads").map(edge =>
    ({ from: names.get(edge.from), to: names.get(edge.to), evidence: edge.evidence }));
  const expected = [
    ["Paid", "PAID"], ["Refunded", "REFUNDED"],
    ["DEFAULT_STATUS", "PAID"], ["FINAL_STATUSES", "PAID"],
    ["FINAL_STATUSES", "REFUNDED"], ["$status", "PAID"],
    ["$backup", "REFUNDED"], ["initial", "PAID"],
    ["isFinal", "FINAL_STATUSES"],
  ] as const;
  assert.equal(reads.length, expected.length + 1, "closure owns the remaining native read");
  for (const [from, to] of expected) {
    const matches = reads.filter(edge => edge.from === from && edge.to === to);
    assert.equal(matches.length, 1, from + " -> " + to);
    assert.equal(matches[0]!.evidence?.length, 1);
  }
  assert.equal(reads.filter(edge => edge.from?.startsWith("closure@") && edge.to === "PAID").length, 1);
  assert.ok(!reads.some(edge => edge.from === "withClosure" || edge.from === "LITERAL"
    || edge.from === "$unset"), "no outer-closure or literal false reads");
  assert.equal(graph.relations.filter(edge => edge.kind === "calls"
    && names.get(edge.from) === "isFinal" && names.get(edge.to) === "in_array").length, 1);
});