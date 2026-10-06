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