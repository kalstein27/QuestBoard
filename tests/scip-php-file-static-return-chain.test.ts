import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPhpLexicalScopes } from "../src/adapters/code-intelligence/php-lexical-scopes.js";
import { BundledScipIndexReader } from "../src/adapters/code-intelligence/scip-provider.js";
import { normalizeScipGraph } from "../src/adapters/code-intelligence/scip-normalizer.js";
import { queryCodeGraph } from "../src/application/code-map-query.js";

const configSource = [
  "<?php",
  "namespace Fixture;",
  "final class ConfigSnapshot { public function isProduction(): bool { return true; } }",
  "class AppConfig {",
  "  public static function get(): ConfigSnapshot { return new ConfigSnapshot(); }",
  "  public static function optional(): ?ConfigSnapshot { return null; }",
  "  public static function mixed(): ConfigSnapshot|false { return false; }",
  "  public static function uncertain(): mixed { return null; }",
  "  public static function late(): static { return new static(); }",
  "  private static function hidden(): ConfigSnapshot { return new ConfigSnapshot(); }",
  "  public function isProduction(): bool { return false; }",
  "}",
  "final class ReportJob { public static function run(): void {} }",
].join("\n");
const fileSource = [
  "<?php",
  "namespace Fixture;",
  "AppConfig::get()->isProduction();",
  "try { AppConfig::get()->isProduction(); } catch (\\Throwable $e) {}",
  "AppConfig::optional()?->isProduction();",
  "AppConfig::mixed()->isProduction();",
  "AppConfig::uncertain()->isProduction();",
  "AppConfig::late()->isProduction();",
  "AppConfig::hidden()->isProduction();",
  "$dynamic = 'Fixture\\AppConfig';",
  "$dynamic::get()->isProduction();",
  "$job = new ConfigSnapshot();",
  "$job->isProduction();",
  "ReportJob::run();",
  "try { $later = new ConfigSnapshot(); } catch (\\Throwable $e) {}",
  "$later->isProduction();",
  "final class BootstrapMarker {}",
].join("\n");

test("05/08 B1: file-level static return chains use only a single public nonnullable native class", async (t) => {
  const autoload = process.env.QUESTBOARD_TEST_PHP_PARSER_AUTOLOAD;
  if (!autoload) { t.skip("Trusted PHP Parser 5 autoload.php unavailable"); return; }
  const root = mkdtempSync(join(tmpdir(), "questboard-b1-static-chain-"));
  try {
    mkdirSync(join(root, "src")); mkdirSync(join(root, "vendor"));
    writeFileSync(join(root, "vendor/autoload.php"), "<?php require " + JSON.stringify(autoload) + ";");
    writeFileSync(join(root, "src/Config.php"), configSource);
    writeFileSync(join(root, "src/bootstrap.php"), fileSource);
    const scopes = await extractPhpLexicalScopes(root, ["src/Config.php", "src/bootstrap.php"]);
    const file = scopes.get("src/bootstrap.php")!.find(scope => scope.type === "file");
    assert.ok(file, "file-level owner must survive");
    const calls = file.calls ?? [];
    const at = (text: string) => fileSource.split("\n").findIndex(line => line.includes(text));
    const productionCalls = calls.filter(call => call.name === "isProduction");
    const expected = [at("AppConfig::get()->isProduction();"),
      at("try { AppConfig::get()->isProduction();"),
      at("$job->isProduction();")].sort((a, b) => a - b);
    assert.deepEqual(productionCalls.map(call => call.nameRange[0]).sort((a, b) => a - b), expected);
    assert.ok(productionCalls.every(call => call.className === "Fixture\\ConfigSnapshot"
      && call.callStyle === "object"), "all resolved receivers must have a proven class");
    assert.deepEqual(calls.filter(call => call.name === "get")
      .map(call => call.nameRange[0]).sort((a, b) => a - b), expected.slice(0, 2));
    assert.equal(calls.filter(call => call.name === "run" && call.className === "Fixture\\ReportJob").length, 1);
    for (const expr of ["optional()?->isProduction", "mixed()->isProduction",
      "uncertain()->isProduction", "late()->isProduction", "hidden()->isProduction",
      "$dynamic::get()->isProduction", "$later->isProduction"]) {
      assert.ok((file.unresolvedCalls ?? []).some(call => call.name === "isProduction"
        && call.nameRange[0] === at(expr)), "ambiguous or leaked type must remain unresolved: " + expr);
    }
    assert.equal(file.instantiations?.filter(item => item.className === "Fixture\\ConfigSnapshot").length, 2,
      "existing file-level object creation is unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Reuse a native scip-php index generated in an isolated test fixture. Never
// invoke the indexer or write to any production project in this regression.
const nativeFixture = process.env.QUESTBOARD_TEST_NATIVE_SCIP_PHP_B1_ROOT;
if (nativeFixture) test("05/08 B1: native SCIP target, file caller evidence and negative roles", async () => {
  const root = realpathSync.native(nativeFixture);
  const index = await new BundledScipIndexReader().read(join(root, "index.scip"));
  const paths = index.documents.map(doc => doc.relativePath);
  assert.ok(paths.includes("src/bootstrap.php"));
  const scopes = await extractPhpLexicalScopes(root, paths);
  const sourceTextByPath = new Map(paths.map(path => [path, readFileSync(join(root, path), "utf8")]));
  const build = () => normalizeScipGraph({
    projectId: "b1-native", rootPath: root, indexedAt: "2026-11-17T00:00:00Z",
    providerId: "scip-php", index, phpLexicalScopes: scopes, sourceTextByPath,
  });
  const graph = build();
  const file = graph.nodes.find(node => node.canonicalIdentity === "file:src/bootstrap.php");
  const production = graph.nodes.find(node => node.name === "isProduction"
    && node.canonicalIdentity.includes("ConfigSnapshot#"));
  assert.ok(file && production);
  const edges = graph.relations.filter(edge => edge.from === file.id);
  const calls = edges.filter(edge => edge.kind === "calls" && edge.to === production.id);
  assert.equal(calls.length, 1);
  const callers = queryCodeGraph(graph, "scip-php", {
    operation: "relations", semantic: "callers", nodeId: production.id,
  });
  assert.equal(callers.operation, "relations");
  assert.ok(callers.entries.some(entry => entry.relation.from === file.id && entry.relation.kind === "calls"),
    "the actual callers query must expose the file-level owner");
  assert.deepEqual(calls[0]!.evidence?.map(item => item.location.startLine).sort((a, b) => (a ?? -1) - (b ?? -1)),
    [3, 4, 11], "only two static return chains and the existing direct object call");
  assert.ok(calls[0]!.evidence?.every(item => item.receiverClass === "Fixture\\ConfigSnapshot"
    && item.label?.includes("file-level typed object call")));
  const named = (kind: string, name: string) => edges.find(edge =>
    edge.kind === kind && graph.nodes.find(node => node.id === edge.to)?.name === name);
  assert.equal(named("calls", "get")?.evidence?.length, 2);
  assert.equal(named("calls", "run")?.evidence?.length, 1);
  assert.equal(named("instantiates", "ConfigSnapshot")?.evidence?.length, 1);
  assert.equal(edges.filter(edge => edge.kind === "calls").length, 6);
  // A native occurrence at the same token with a different target blocks
  // AST receiver recovery, rather than inventing a competing relation.
  const bootstrap = index.documents.find(doc => doc.relativePath === "src/bootstrap.php")!;
  const token = scopes.get("src/bootstrap.php")!.find(scope => scope.type === "file")!.calls!
    .find(call => call.name === "isProduction" && call.nameRange[0] === 2)!.nameRange;
  const get = index.documents.flatMap(doc => doc.occurrences).find(occurrence =>
    (occurrence.symbolRoles & 1) !== 0 && occurrence.symbol.includes("ReportJob#run()."))!;
  assert.ok(get);
  bootstrap.occurrences.push({ symbol: get.symbol, symbolRoles: 0,
    range: { startLine: token[0], startCharacter: token[1], endLine: token[2], endCharacter: token[3] } });
  const conflicting = build();
  const conflictingFile = conflicting.nodes.find(node => node.canonicalIdentity === "file:src/bootstrap.php")!;
  const conflictingProduction = conflicting.nodes.find(node => node.canonicalIdentity === production.canonicalIdentity)!;
  const kept = conflicting.relations.filter(edge => edge.from === conflictingFile.id
    && edge.to === conflictingProduction.id && edge.kind === "calls");
  assert.equal(kept.length, 1);
  assert.deepEqual(kept[0]!.evidence?.map(item => item.location.startLine).sort((a, b) => (a ?? -1) - (b ?? -1)),
    [4, 11], "one conflicting native target excludes only its own call site");
});