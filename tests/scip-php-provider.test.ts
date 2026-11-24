import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ScipPhpProvider } from "../src/adapters/code-intelligence/scip-php-provider.js";
import type {
  ScipIndexReader,
  ScipProcessRunOptions,
  ScipProcessRunResult,
  ScipProcessRunner,
} from "../src/adapters/code-intelligence/scip-provider.js";
import { parseScipJsonIndex, type ScipJsonIndex } from "../src/adapters/code-intelligence/scip-normalizer.js";

class FakeRunner implements ScipProcessRunner {
  readonly calls: Array<{ executable: string; args: readonly string[]; options: ScipProcessRunOptions }> = [];
  constructor(readonly onRun?: (options: ScipProcessRunOptions) => void) {}

  async run(executable: string, args: readonly string[], options: ScipProcessRunOptions): Promise<ScipProcessRunResult> {
    this.calls.push({ executable, args: [...args], options });
    this.onRun?.(options);
    return { stdout: "", stderr: "", exitCode: 0 };
  }
}

class FakeIndexReader implements ScipIndexReader {
  readonly paths: string[] = [];
  constructor(readonly index: ScipJsonIndex) {}

  async read(indexPath: string): Promise<ScipJsonIndex> {
    this.paths.push(indexPath);
    return this.index;
  }
}

function phpIndex(): ScipJsonIndex {
  const caller = "scip-php composer example/app 1.0.0 src/functions.php/caller().";
  const target = "scip-php composer example/app 1.0.0 src/functions.php/target().";
  return parseScipJsonIndex({
    documents: [{
      relativePath: "src/functions.php",
      language: "php",
      symbols: [
        { symbol: caller, displayName: "caller", kind: "Function" },
        { symbol: target, displayName: "target", kind: "Function" },
      ],
      occurrences: [
        { symbol: caller, symbolRoles: 1, range: [1, 9, 15], enclosingRange: [1, 0, 3, 1] },
        { symbol: target, symbolRoles: 0, range: [2, 4, 10] },
        { symbol: target, symbolRoles: 1, range: [4, 9, 15], enclosingRange: [4, 0, 4, 20] },
      ],
    }],
    externalSymbols: [],
  });
}

function preparePhpProject(root: string): string {
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "vendor", "bin"), { recursive: true });
  writeFileSync(join(root, "composer.json"), "{}\n");
  writeFileSync(join(root, "composer.lock"), "{}\n");
  writeFileSync(join(root, "vendor", "autoload.php"), "<?php\n");
  const executable = join(root, "vendor", "bin", process.platform === "win32" ? "scip-php.bat" : "scip-php");
  writeFileSync(executable, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
  if (process.platform !== "win32") chmodSync(executable, 0o755);
  writeFileSync(join(root, "src", "functions.php"), [
    "<?php",
    "function caller() {",
    "    target();",
    "}",
    "function target() {}",
  ].join("\n"));
  return executable;
}

test("SCIP PHP uses the project-local Composer executable, externalizes index.scip, and preserves semantic calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "questboard-scip-php-project-"));
  const storageRoot = mkdtempSync(join(tmpdir(), "questboard-scip-php-storage-"));
  try {
    const executable = preparePhpProject(root);
    const runner = new FakeRunner(({ cwd }) => writeFileSync(join(cwd, "index.scip"), "fixture"));
    const reader = new FakeIndexReader(phpIndex());
    const provider = new ScipPhpProvider(runner, {
      storageRoot,
      indexReader: reader,
      now: () => "2026-10-06T00:00:00.000Z",
    });

    const graph = await provider.indexProject({ projectId: "php-project", rootPath: root });

    assert.equal(runner.calls.length, 1);
    assert.equal(runner.calls[0]?.executable, executable);
    assert.deepEqual(runner.calls[0]?.args, []);
    assert.equal(runner.calls[0]?.options.cwd, root);
    assert.equal(existsSync(join(root, "index.scip")), false, "generated index.scip must not remain in the project");
    assert.equal(reader.paths.length, 1);
    assert.equal(reader.paths[0]?.startsWith(storageRoot), true);
    assert.equal(readFileSync(reader.paths[0]!, "utf8"), "fixture");
    assert.equal(graph.coverage?.providers[0]?.providerId, "scip-php");
    assert.equal(graph.coverage?.languages[0]?.language, "php");
    assert.deepEqual(graph.coverage?.languages[0]?.providerIds, ["scip-php"]);
    assert.equal(graph.relations.filter((relation) => relation.kind === "calls").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("SCIP PHP coverage reports all first-party eligible files rather than calling native document count complete", async () => {
  const root = mkdtempSync(join(tmpdir(), "questboard-scip-php-coverage-"));
  const storageRoot = mkdtempSync(join(tmpdir(), "questboard-scip-php-storage-"));
  try {
    preparePhpProject(root);
    writeFileSync(join(root, "src", "not-indexed.php"), "<?php function missing() {}\n");
    mkdirSync(join(root, "vendor", "package"), { recursive: true });
    writeFileSync(join(root, "vendor", "package", "dependency.php"), "<?php\n");
    const runner = new FakeRunner(({ cwd }) => writeFileSync(join(cwd, "index.scip"), "fixture"));
    const nativeIndex = phpIndex();
    nativeIndex.documents.push({
      relativePath: "vendor/package/dependency.php",
      language: "php",
      occurrences: [],
      symbols: [],
    });
    const provider = new ScipPhpProvider(runner, { storageRoot, indexReader: new FakeIndexReader(nativeIndex) });
    const graph = await provider.indexProject({ projectId: "coverage", rootPath: root });
    const php = graph.coverage?.languages.find((entry) => entry.language === "php");
    assert.equal(php?.semanticEligibleFileCount, 2,
      "first-party file inventory includes missing source but excludes installed Composer vendor");
    assert.equal(php?.semanticIndexedFileCount, 1,
      "out-of-scope vendor SCIP documents cannot inflate first-party indexing claims");
    assert.equal(php?.fileCount, 2);
    assert.equal(runner.calls.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("Composer source scope excludes views and translations without hiding native out-of-scope documents or real misses", async () => {
  const root = mkdtempSync(join(tmpdir(), "questboard-scip-php-composer-scope-"));
  const storageRoot = mkdtempSync(join(tmpdir(), "questboard-scip-php-storage-"));
  try {
    preparePhpProject(root);
    writeFileSync(join(root, "composer.json"), JSON.stringify({
      autoload: { "psr-4": { "App\\": "app/" } },
      "autoload-dev": { "psr-4": { "Tests\\": "tests/" } },
      bin: ["bin/cli.php"],
    }));
    const samples = new Map([
      ["app/Controller.php", "<?php class Controller {}"],
      ["app/Config/settings.php", "<?php return ['enabled' => true];"],
      ["app/views/panel.blade.php", "{{ $value }}"],
      ["tests/FeatureTest.php", "<?php class FeatureTest {}"],
      ["bin/cli.php", "<?php function command() {}"],
      ["database/migrations/2026_create.php", "<?php return new class {};"],
      ["routes/api.php", "<?php function routeHandler() {}"],
      ["lang/en/messages.php", "<?php return ['ok' => 'Okay'];"],
      ["resources/views/page.blade.php", "{{ $value }}"],
    ]);
    for (const [path, contents] of samples) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), contents);
    }
    const index = phpIndex();
    index.documents.push({ relativePath: "app/Controller.php", language: "php", symbols: [], occurrences: [] });
    index.documents.push({ relativePath: "vendor/external.php", language: "php", symbols: [], occurrences: [] });
    const runner = new FakeRunner(({ cwd }) => writeFileSync(join(cwd, "index.scip"), "fixture"));
    const provider = new ScipPhpProvider(runner, { storageRoot, indexReader: new FakeIndexReader(index) });
    const graph = await provider.indexProject({ projectId: "composer-scope", rootPath: root });
    const php = graph.coverage?.languages.find((entry) => entry.language === "php");
    assert.equal(php?.fileCount, 10, "all first-party PHP files remain discoverable");
    assert.equal(php?.semanticEligibleFileCount, 5,
      "Composer app/tests/bin plus a genuine native document outside those roots");
    assert.equal(php?.semanticIndexedFileCount, 2, "vendor-native PHP is not a first-party success");
    assert.equal(php?.semanticExcludedFileCount, 5,
      "Blade inside a PSR-4 root and out-of-scope translation/migration/route remain file-only");
    assert.equal(php?.semanticExclusionReason, "provider_project_scope");
    writeFileSync(join(root, "composer.json"), JSON.stringify({
      autoload: { classmap: ["app/*/src"] },
    }));
    const uncertainGraph = await provider.indexProject({ projectId: "composer-wildcard", rootPath: root });
    const uncertainPhp = uncertainGraph.coverage?.languages.find((entry) => entry.language === "php");
    assert.equal(uncertainPhp?.semanticEligibleFileCount, 8,
      "unknown Composer patterns must retain every non-template PHP file as eligible");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("SCIP PHP refuses to overwrite a pre-existing project index.scip", async () => {
  const root = mkdtempSync(join(tmpdir(), "questboard-scip-php-existing-"));
  const storageRoot = mkdtempSync(join(tmpdir(), "questboard-scip-php-storage-"));
  try {
    preparePhpProject(root);
    writeFileSync(join(root, "index.scip"), "keep-me");
    const runner = new FakeRunner();
    const provider = new ScipPhpProvider(runner, { storageRoot, indexReader: new FakeIndexReader(phpIndex()) });

    await assert.rejects(
      provider.indexProject({ projectId: "php-project", rootPath: root }),
      /refuses to overwrite an existing project index\.scip/,
    );
    assert.equal(readFileSync(join(root, "index.scip"), "utf8"), "keep-me");
    assert.equal(runner.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("SCIP PHP fails before execution when the Composer project is not ready", async () => {
  const root = mkdtempSync(join(tmpdir(), "questboard-scip-php-unready-"));
  const storageRoot = mkdtempSync(join(tmpdir(), "questboard-scip-php-storage-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "main.php"), "<?php\n");
    writeFileSync(join(root, "composer.json"), "{}\n");
    const runner = new FakeRunner();
    const provider = new ScipPhpProvider(runner, { storageRoot, indexReader: new FakeIndexReader(phpIndex()) });

    await assert.rejects(
      provider.indexProject({ projectId: "php-project", rootPath: root }),
      /composer\.lock/,
    );
    assert.equal(runner.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("SCIP PHP is a no-op semantic contribution when a repository has no PHP files", async () => {
  const root = mkdtempSync(join(tmpdir(), "questboard-scip-php-empty-"));
  const storageRoot = mkdtempSync(join(tmpdir(), "questboard-scip-php-storage-"));
  try {
    writeFileSync(join(root, "README.md"), "no php here\n");
    const runner = new FakeRunner();
    const provider = new ScipPhpProvider(runner, { storageRoot, indexReader: new FakeIndexReader(phpIndex()) });

    const graph = await provider.indexProject({ projectId: "empty-project", rootPath: root });
    assert.equal(runner.calls.length, 0);
    assert.equal(graph.nodes.length, 0);
    assert.equal(graph.coverage?.providers[0]?.providerId, "scip-php");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(storageRoot, { recursive: true, force: true });
  }
});