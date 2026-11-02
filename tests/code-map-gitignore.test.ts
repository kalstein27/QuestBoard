import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FileSystemCodeFileInventory,
  gitCodeMapPaths,
} from "../src/adapters/code-intelligence/file-inventory.js";

test("Code Map follows nested .gitignore while retaining tracked and untracked first-party PHP", async () => {
  const root = mkdtempSync(join(tmpdir(), "questboard-gitignore-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    mkdirSync(join(root, "src", "generated"), { recursive: true });
    mkdirSync(join(root, "venv", "bin"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "venv/\n.env*\n*.pem\nignored.log\n");
    writeFileSync(join(root, "src", ".gitignore"), "generated/\n");
    writeFileSync(join(root, "src", "Tracked.php"), "<?php class Tracked {}\n");
    writeFileSync(join(root, "src", "New.php"), "<?php class NewEntry {}\n");
    writeFileSync(join(root, "src", "generated", "Ignored.php"), "<?php\n");
    writeFileSync(join(root, "venv", "bin", "noise.py"), "print(1)\n");
    writeFileSync(join(root, ".env.production"), "test-secret\n");
    writeFileSync(join(root, "src", "private.key"), "test-secret\n");
    writeFileSync(join(root, "src", "chain.pem"), "test-secret\n");
    writeFileSync(join(root, "ignored.log"), "hidden\n");
    symlinkSync(join(root, "src", "Tracked.php"), join(root, "src", "linked.php"));
    execFileSync("git", ["-C", root, "add", "--", "src/Tracked.php"]);
    execFileSync("git", ["-C", root, "add", "-f", "--", ".env.production"]);

    const inventory = await new FileSystemCodeFileInventory().listFiles(root);
    const paths = inventory.map((entry) => entry.path);
    assert.ok(paths.includes("src/Tracked.php"));
    assert.ok(paths.includes("src/New.php"));
    for (const excluded of [
      "src/generated/Ignored.php", "venv/bin/noise.py", ".env.production",
      "src/private.key", "src/chain.pem", "ignored.log", "src/linked.php",
    ]) assert.equal(paths.includes(excluded), false, excluded);
    const gitPaths = gitCodeMapPaths(root);
    assert.ok(gitPaths?.includes("src/New.php"));
    assert.equal(gitPaths?.includes("src/generated/Ignored.php"), false);
    // Git lists symlinks as tracked/untracked paths; the inventory's lstat guard excludes them.

    // Previously ignored files become visible if the exclusion is removed.
    writeFileSync(join(root, "src", ".gitignore"), "");
    const updated = await new FileSystemCodeFileInventory().listFiles(root);
    assert.ok(updated.some((entry) => entry.path === "src/generated/Ignored.php"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-Git inventory still excludes credentials and virtual environments", async () => {
  const root = mkdtempSync(join(tmpdir(), "questboard-nongit-safe-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".venv"), { recursive: true });
    writeFileSync(join(root, "src", "Order.php"), "<?php\n");
    writeFileSync(join(root, ".env"), "test-secret\n");
    writeFileSync(join(root, "src", "auth.pem"), "test-secret\n");
    writeFileSync(join(root, ".venv", "noise.py"), "print(1)\n");
    const paths = (await new FileSystemCodeFileInventory().listFiles(root))
      .map((entry) => entry.path);
    assert.deepEqual(paths, ["src/Order.php"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
