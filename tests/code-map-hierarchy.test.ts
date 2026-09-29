import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CODE_GRAPH_SCHEMA_VERSION,
  materializeCodeFileHierarchy,
  type CodeGraphSnapshot,
} from "../src/index.js";
import { FileSystemCodeFileInventory } from "../src/adapters/code-intelligence/file-inventory.js";

function semanticGraph(): CodeGraphSnapshot {
  return {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId: "mixed",
    rootPath: "/workspace/mixed",
    indexedAt: "2026-09-28T00:00:00.000Z",
    nodes: [
      {
        id: "service",
        kind: "class",
        name: "Service",
        canonicalIdentity: "src/service.ts#class:Service",
        location: { path: "src/service.ts", startLine: 1 },
      },
      {
        id: "run",
        kind: "method",
        name: "run",
        canonicalIdentity: "src/service.ts#method:Service.run",
        location: { path: "src/service.ts", startLine: 2 },
      },
    ],
    relations: [
      {
        id: "service-contains-run",
        from: "service",
        to: "run",
        kind: "contains",
        confidence: 1,
      },
    ],
  };
}

test("file hierarchy preserves provider containment and keeps unsupported-language files visible", () => {
  const graph = materializeCodeFileHierarchy(semanticGraph(), [
    { path: "src/service.ts" },
    { path: "macos/Companion.swift" },
    { path: "scripts/bootstrap.sh" },
    { path: "windows/install.ps1" },
  ]);
  const files = graph.nodes.filter((node) => node.kind === "file");
  const byPath = new Map(files.map((node) => [node.location?.path, node] as const));
  const serviceFile = byPath.get("src/service.ts")!;

  assert.equal(files.length, 4);
  assert.equal(byPath.get("src/service.ts")?.language, "typescript");
  assert.equal(byPath.get("macos/Companion.swift")?.language, "swift");
  assert.equal(byPath.get("scripts/bootstrap.sh")?.language, "shellscript");
  assert.equal(byPath.get("windows/install.ps1")?.language, "powershell");
  assert.equal(graph.nodes.find((node) => node.id === "service")?.language, "typescript");
  assert.equal(graph.nodes.find((node) => node.id === "run")?.language, "typescript");
  assert.ok(graph.relations.some((relation) =>
    relation.kind === "contains" && relation.from === serviceFile.id && relation.to === "service",
  ));
  assert.ok(graph.relations.some((relation) =>
    relation.kind === "contains" && relation.from === "service" && relation.to === "run",
  ));
  assert.equal(graph.relations.some((relation) =>
    relation.kind === "contains" && relation.from === serviceFile.id && relation.to === "run",
  ), false, "nested symbols must not also be attached directly to the file");

  const incomingContains = new Map<string, number>();
  for (const relation of graph.relations.filter((entry) => entry.kind === "contains")) {
    incomingContains.set(relation.to, (incomingContains.get(relation.to) ?? 0) + 1);
  }
  assert.equal(incomingContains.get("service"), 1);
  assert.equal(incomingContains.get("run"), 1);
});

test("filesystem inventory is provider-neutral and skips generated/dependency/runtime directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "questboard-file-inventory-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "macos"), { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "windows"), { recursive: true });
    mkdirSync(join(root, ".questboard"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "src", "main.ts"), "export const value = 1;\n");
    writeFileSync(join(root, "macos", "Companion.swift"), "func start() {}\n");
    writeFileSync(join(root, "scripts", "bootstrap.sh"), "#!/bin/sh\n");
    writeFileSync(join(root, "windows", "install.ps1"), "Write-Host ok\n");
    writeFileSync(join(root, ".questboard", "questboard.sqlite"), "runtime state\n");
    writeFileSync(join(root, "node_modules", "pkg", "ignored.js"), "ignored\n");
    writeFileSync(join(root, "dist", "ignored.js"), "ignored\n");

    const inventory = await new FileSystemCodeFileInventory().listFiles(root);
    assert.deepEqual(inventory.map((entry) => entry.path), [
      "macos/Companion.swift",
      "scripts/bootstrap.sh",
      "src/main.ts",
      "windows/install.ps1",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
