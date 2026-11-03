import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractPhpLexicalScopes } from "../src/adapters/code-intelligence/php-lexical-scopes.js";

test("PHP lexical output accepts 13MiB but rejects output above 32MiB", async () => {
  const root = mkdtempSync(join(tmpdir(), "questboard-php-lexical-cap-"));
  const file = "src/Test.php";
  try {
    const makeExecutable = (filename: string, whitespaceBytes: number): string => {
      const path = join(root, filename);
      writeFileSync(path, [
        "#!/usr/bin/env node",
        "process.stdout.write(Buffer.alloc(" + whitespaceBytes + ", 0x20));",
        "process.stdout.end(JSON.stringify({ documents: { 'src/Test.php': [] }, parsed: 1, errors: 0 }));",
      ].join("\n") + "\n");
      chmodSync(path, 0o755);
      return path;
    };
    const accepted = makeExecutable("mock-small.cjs", 13 * 1024 * 1024);
    const result = await extractPhpLexicalScopes(root, [file], { phpExecutable: accepted });
    assert.deepEqual(result.get(file), []);

    const oversized = makeExecutable("mock-large.cjs", 33 * 1024 * 1024);
    await assert.rejects(
      extractPhpLexicalScopes(root, [file], { phpExecutable: oversized }),
      /output exceeded 32MiB cap/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PHP lexical output rejects a valid JSON envelope with incomplete parsing", async () => {
  const root = mkdtempSync(join(tmpdir(), "questboard-php-lexical-failed-"));
  try {
    const executable = join(root, "mock-incomplete.cjs");
    writeFileSync(executable, [
      "#!/usr/bin/env node",
      "process.stdout.write(JSON.stringify({",
      " documents: { 'src/Test.php': [] }, parsed: 0, errors: 1",
      "}));",
    ].join("\n"));
    chmodSync(executable, 0o755);
    await assert.rejects(
      extractPhpLexicalScopes(root, ["src/Test.php"], { phpExecutable: executable }),
      /PHP AST lexical extraction incomplete: parsed 0\/1, errors 1/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PHP lexical output accepts over 100,000 bounded call sites without silent truncation", async () => {
  const root = mkdtempSync(join(tmpdir(), "questboard-php-lexical-sites-"));
  try {
    const executable = join(root, "mock-many-sites.cjs");
    writeFileSync(executable, [
      "#!/usr/bin/env node",
      "const calls = Array.from({length: 100_100}, () => ({",
      " className: 'Domain\\\\Order', name: 'save', nameRange: [0, 7, 0, 11]",
      "}));",
      "process.stdout.write(JSON.stringify({",
      " documents: { 'src/Test.php': [{",
      " type: 'method', name: 'test', className: 'Domain\\\\Service',",
      " nameRange: [0, 1, 0, 5], range: [0, 0, 0, 20], calls",
      " }] }, parsed: 1, errors: 0",
      "}));",
    ].join("\n"));
    chmodSync(executable, 0o755);
    const parsed = await extractPhpLexicalScopes(root, ["src/Test.php"], { phpExecutable: executable });
    assert.equal(parsed.get("src/Test.php")?.[0]?.calls?.length, 100_100);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
