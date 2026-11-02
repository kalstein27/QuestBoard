import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileSystemCodeFileInventory } from "../src/adapters/code-intelligence/file-inventory.js";
import * as persistenceAdapters from "../src/adapters/code-intelligence/code-map-persistence.js";
import {
  CODE_GRAPH_SCHEMA_VERSION, CodeMapProviderRegistry,
  type CodeGraphSnapshot, type CodeNode,
} from "../src/index.js";
import {
  configuredCodeMapExclusionPrefixes, isConfiguredCodeMapExcluded,
} from "../src/application/code-map-exclusions.js";

test("D5: Git and non-Git file inventories return bounded deterministic subsets above file cap", async () => {
  for (const git of [true, false]) {
    const root = mkdtempSync(join(tmpdir(), "qb-truncated-files-"));
    try {
      mkdirSync(join(root, "src"));
      if (git) execFileSync("git", ["init", "-q", root]);
      for (const name of ["a", "b", "c", "d"]) {
        writeFileSync(join(root, "src", name + ".php"), "<?php\n");
      }
      const inventory = new FileSystemCodeFileInventory({ maxFiles: 2 });
      const first = (await inventory.listFiles(root)).map((file) => file.path);
      const second = (await inventory.listFiles(root)).map((file) => file.path);
      assert.equal(first.length, 2);
      assert.deepEqual(first, second);
      assert.ok(first.every((path) => path.endsWith(".php")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("D5: source manifest over cap returns a fingerprint and reflects tracked subset changes", () => {
  // The production source-state adapter is the sole exported class offering this method.
  const SourceState = Object.values(persistenceAdapters).find((value) =>
    typeof value === "function" && "sourceManifestFingerprint" in value.prototype) as
    (new (options: { maxFiles: number }) => {
      sourceManifestFingerprint(root: string): string;
    }) | undefined;
  assert.ok(SourceState);
  for (const git of [true, false]) {
    const root = mkdtempSync(join(tmpdir(), "qb-truncated-manifest-"));
    try {
      mkdirSync(join(root, "src"));
      if (git) execFileSync("git", ["init", "-q", root]);
      for (const name of ["a", "b", "c", "d"]) {
        writeFileSync(join(root, "src", name + ".php"), "<?php\n");
      }
      const sourceState: { sourceManifestFingerprint(root: string): string } =
        new SourceState({ maxFiles: 2 });
      const first: string = sourceState.sourceManifestFingerprint(root);
      assert.match(first, /^[a-f0-9]{64}$/);
      assert.equal(sourceState.sourceManifestFingerprint(root), first);
      writeFileSync(join(root, "src", "a.php"), "<?php\nclass Modified {}\n");
      assert.notEqual(sourceState.sourceManifestFingerprint(root), first,
        "a change inside the bounded manifest subset is still detected");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("D6: configured directory prefixes reduce only unindexed semantic eligibility", () => {
  const original = process.env.QUESTBOARD_CODE_MAP_EXCLUDE_PREFIXES;
  const available = () => ({
    configured: true, installed: true, available: true,
    executable: "/bin/scip-php", health: "ready" as const, diagnostics: [],
  });
  const registry = new CodeMapProviderRegistry([{
    providerId: "scip-php", languages: ["php"],
    fidelity: "semantic-call", version: "1.0",
  }], available);
  const paths = [
    "src/Order.php", "generated/OrderProxy.php",
    "generated-other/Unindexed.php", "tests/Legacy.php",
  ];
  const files: CodeNode[] = paths.map((path, index) => ({
    id: "file:" + index, kind: "file", name: path.split("/").at(-1)!,
    canonicalIdentity: "file:" + path, language: "php", location: { path },
  }));
  const graph: CodeGraphSnapshot = {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId: "php-prefix-coverage", rootPath: "/tmp/php-prefix-coverage",
    indexedAt: "2026-11-03T00:00:00Z",
    nodes: [...files, {
      id: "php:order", kind: "method", name: "save",
      canonicalIdentity: "scip:Order#save", language: "php",
      location: { path: "src/Order.php", startLine: 1 },
      provenance: [{ providerId: "scip-php", fidelity: "semantic-call" }],
    }],
    relations: [],
    coverage: {
      degraded: false,
      providers: [{
        providerId: "scip-php", status: "fresh", nodeCount: 1,
        relationCount: 0, languages: ["php"],
      }],
      languages: [{
        language: "php", fileCount: 4, semanticEligibleFileCount: 4,
        semanticIndexedFileCount: 1, semanticExcludedFileCount: 0,
        fidelity: "semantic-call", providerIds: ["scip-php"], degraded: false,
      }],
    },
  };
  const php = () => registry.report(graph).languages.find((entry) => entry.language === "php")!;
  try {
    delete process.env.QUESTBOARD_CODE_MAP_EXCLUDE_PREFIXES;
    assert.equal(php().gapReason, "partial_coverage");
    process.env.QUESTBOARD_CODE_MAP_EXCLUDE_PREFIXES = "generated,tests";
    assert.equal(php().eligibleFileCount, 2);
    assert.equal(php().excludedFileCount, 2);
    assert.equal(php().exclusionReason, "configured_path_prefix");
    assert.equal(php().gapReason, "partial_coverage",
      "generated-other/ is not under generated/ and remains an actual uncovered file");
    process.env.QUESTBOARD_CODE_MAP_EXCLUDE_PREFIXES = "generated,tests,generated-other";
    assert.equal(php().eligibleFileCount, 1);
    assert.equal(php().excludedFileCount, 3);
    assert.equal(php().gapReason, null);
    assert.equal(registry.report(graph).health, "healthy");
    assert.equal(php().discoveredFileCount, 4, "all file nodes remain discoverable");
    process.env.QUESTBOARD_CODE_MAP_EXCLUDE_PREFIXES = "src,generated,tests,generated-other";
    assert.equal(php().eligibleFileCount, 1,
      "a file already indexed cannot be hidden from the eligible count");
    assert.equal(php().indexedFileCount, 1);
  } finally {
    if (original === undefined) delete process.env.QUESTBOARD_CODE_MAP_EXCLUDE_PREFIXES;
    else process.env.QUESTBOARD_CODE_MAP_EXCLUDE_PREFIXES = original;
  }
});

test("D6: unsafe exclusion prefixes and similar non-descendant directories never match", () => {
  const prefixes = configuredCodeMapExclusionPrefixes("../src,/tmp/root,./generated/,src//../../oops,generated");
  assert.deepEqual(prefixes, ["generated"]);
  assert.equal(isConfiguredCodeMapExcluded("generated/index.php", prefixes), true);
  assert.equal(isConfiguredCodeMapExcluded("generated-other/index.php", prefixes), false);
  assert.equal(isConfiguredCodeMapExcluded("src/index.php", prefixes), false);
});
