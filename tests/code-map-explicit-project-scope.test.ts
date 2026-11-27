import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CODE_GRAPH_SCHEMA_VERSION, type CodeIntelligenceProvider } from "../src/application/code-intelligence.js";
import { CompositeCodeIntelligenceProvider } from "../src/application/composite-code-intelligence-provider.js";
import { CodeMapProviderRegistry } from "../src/application/code-map-provider-registry.js";
import { inspectCodeMapPreflight } from "../src/application/code-map-preflight.js";
import { queryCodeGraph } from "../src/application/code-map-query.js";
import { projectCodeMapExclusionPrefixes } from "../src/application/code-map-exclusions.js";
import { FileSystemCodeFileInventory } from "../src/adapters/code-intelligence/file-inventory.js";

test("explicit project scope skips only fully out-of-scope providers and retains files", async () => {
  const root = mkdtempSync(join(tmpdir(), "qb-provider-scope-"));
  try {
    const scopePath = join(root, "questboard-code-map.json");
    for (const directory of ["src", "fixtures", "fixtures-other"]) mkdirSync(join(root, directory));
    writeFileSync(join(root, "src/main.ts"), "export function main() {}");
    writeFileSync(join(root, "fixtures/helper.php"), "<?php function helper() {}");
    writeFileSync(scopePath, JSON.stringify({ excludePrefixes: ["fixtures"] }));
    const inventory = new FileSystemCodeFileInventory();
    const registry = new CodeMapProviderRegistry([
      { providerId: "ts", languages: ["typescript"], fidelity: "semantic-call", version: null },
      { providerId: "php", languages: ["php"], fidelity: "semantic-call", version: null },
    ], (entry) => ({
      configured: true, installed: entry.providerId === "ts", available: entry.providerId === "ts",
      executable: entry.providerId, health: entry.providerId === "ts" ? "ready" : "missing_executable",
      diagnostics: [],
    }));
    const request = { projectId: "scope", rootPath: root };
    let phpCalls = 0;
    const capabilities = { incrementalIndexing: false, impactAnalysis: false, callTrace: true };
    const ts: CodeIntelligenceProvider = {
      providerId: "ts", languages: ["typescript"], fidelity: "semantic-call", capabilities,
      async indexProject() {
        return {
          ...request, schemaVersion: CODE_GRAPH_SCHEMA_VERSION, indexedAt: new Date().toISOString(),
          nodes: [{ id: "ts-main", canonicalIdentity: "ts:main", name: "main", kind: "function",
            language: "typescript", location: { path: "src/main.ts", startLine: 1 } }],
          relations: [],
        };
      },
    };
    const php: CodeIntelligenceProvider = {
      providerId: "php", languages: ["php"], fidelity: "semantic-call", capabilities,
      async indexProject() { phpCalls++; throw new Error("missing executable"); },
    };
    const composite = new CompositeCodeIntelligenceProvider([ts, php], inventory);
    const preflight = async () => registry.report(undefined, root, await inspectCodeMapPreflight(root, inventory));
    const pre = await preflight();
    assert.equal(pre.health, "healthy");
    assert.equal(pre.providers[1]?.requirement, "not_needed");
    assert.equal(pre.providers[1]?.requirementReason, "supported_language_outside_project_scope");
    assert.equal(pre.languages.find(x => x.language === "php")?.excludedFileCount, 1);
    const graph = await composite.indexProject(request);
    assert.equal(phpCalls, 0);
    assert.ok(graph.nodes.some(n => n.kind === "file" && n.location?.path === "fixtures/helper.php"));
    const report = registry.report(graph);
    assert.equal(report.health, "healthy");
    const phpReport = report.languages.find(x => x.language === "php");
    assert.equal(phpReport?.eligibleFileCount, 0);
    assert.equal(phpReport?.excludedFileCount, 1);
    assert.equal(phpReport?.semanticCoverage, "not_applicable");
    assert.equal(report.providers[1]?.requirement, "not_needed");
    const files = queryCodeGraph(graph, "composite", { operation: "list_files", language: "php" });
    if (files.operation !== "list_files") throw Error("wrong operation");
    assert.equal(files.files.length, 1);
    assert.equal(files.files[0]?.analysisLevel, "file-only");
    assert.equal(files.files[0]?.analysisState, "excluded");
    assert.equal(files.files[0]?.reason, "provider_project_scope");
    const truncatedInventory = {
      async listFiles() { return Object.assign([{ path: "fixtures/helper.php" }], { truncated: true as const }); },
    };
    const truncatedPreflight = registry.report(undefined, root, await inspectCodeMapPreflight(root, truncatedInventory));
    assert.equal(truncatedPreflight.providers[1]?.requirement, "required");
    assert.equal(truncatedPreflight.health, "degraded");
    // A similar directory is not an exclusion. Composer absence is not a
    // reason to hide a real PHP source or skip a required provider.
    writeFileSync(join(root, "fixtures-other/main.php"), "<?php function main() {}");
    const actual = await preflight();
    assert.equal(actual.health, "degraded");
    assert.equal(actual.providers[1]?.requirement, "required");
    const failed = await composite.indexProject(request);
    assert.equal(phpCalls, 1);
    assert.equal(registry.report(failed).health, "degraded");
    rmSync(join(root, "fixtures-other/main.php"));
    writeFileSync(scopePath, JSON.stringify({ excludePrefixes: ["fixtures", "../src"] }));
    assert.deepEqual(projectCodeMapExclusionPrefixes(root), []);
    assert.equal((await preflight()).health, "degraded");
    rmSync(scopePath);
    assert.equal((await preflight()).health, "degraded");
  } finally { rmSync(root, { recursive: true, force: true }); }
});