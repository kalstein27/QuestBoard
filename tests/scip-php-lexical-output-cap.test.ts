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
