import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CODE_GRAPH_SCHEMA_VERSION, type CodeGraphSnapshot } from "../src/application/code-intelligence.js";
import { addConservativeSourceDeclarations } from "../src/application/code-map-lexical-declarations.js";
import { classifyCodeFileType, inferCodeLanguageFromPath } from "../src/application/code-map-hierarchy.js";

test("lexical source declarations produce source-located syntax containment without guessed calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "qb-lexical-only-"));
  const contents: Record<string, string> = {
    "scripts/setup.ps1": `$text = @"\nfunction Fake {\n"@\n<#\nfunction AnotherFake {\n#>\nfunction Real-Setup {\n  Write-Host "hello"\n}\n`,
    "scripts/bootstrap.sh": `cat <<'EOF'\nnot_real() {\nEOF\nhello() {\n  echo hello\n}\n`,
    "macos/Main.swift": `let text = """\nclass NotReal {}\n"""\npublic class Session {}\nfunc render() {}\n`,
    "windows/Engine.cs": `var code = """\nclass NotReal {}\n""";\npublic class Engine {}\n`,
  };
  try {
    const inventory = Object.keys(contents).map((path) => ({ path }));
    const files = inventory.map(({ path }, i) => ({
      id: "file-" + i, kind: "file" as const, name: path.split("/").at(-1)!,
      canonicalIdentity: "file:" + path, language: inferCodeLanguageFromPath(path)!,
      location: { path },
    }));
    for (const [path, source] of Object.entries(contents)) {
      const parts = path.split("/");
      mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
      writeFileSync(join(root, ...parts), source);
    }
    const graph: CodeGraphSnapshot = {
      schemaVersion: CODE_GRAPH_SCHEMA_VERSION, projectId: "lexical-test",
      rootPath: root, indexedAt: "2026-11-04T00:00:00Z", nodes: files, relations: [],
    };
    const result = await addConservativeSourceDeclarations(graph, inventory, root);
    const syntax = result.nodes.filter((node) => node.kind !== "file");
    assert.deepEqual(syntax.map((node) => node.name).sort(),
      ["Engine", "Real-Setup", "Session", "hello", "render"].sort());
    assert.ok(syntax.every((node) => node.provenance?.[0]?.fidelity === "syntax"));
    assert.equal(result.relations.length, syntax.length);
    assert.ok(result.relations.every((edge) => edge.kind === "contains"
      && edge.provenance?.[0]?.fidelity === "syntax" && edge.evidence?.[0]?.location.startLine));
    assert.equal((await addConservativeSourceDeclarations(graph, inventory, root))
      .nodes.map((node) => node.id).join(","), result.nodes.map((node) => node.id).join(","));
    assert.equal(graph.relations.length, 0);
    assert.equal(inferCodeLanguageFromPath("windows/setup.cmd"), "windowsbatch");
    assert.equal(classifyCodeFileType("macos/App/Info.plist").type, "configuration_or_data");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
