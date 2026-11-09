import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SourceKitLspProvider } from "../src/adapters/code-intelligence/sourcekit-lsp-provider.js";
import { createConfiguredCodeMapService, resolveQuestBoardCodeMapConfig } from "../src/server/code-map-config.js";

test("Swift SourceKit provider stays opt-in and uses the Xcode toolchain", () => {
  const env = { QUESTBOARD_CODE_MAP: "1", QUESTBOARD_CODE_MAP_PROVIDER: "sourcekit-lsp" };
  const config = resolveQuestBoardCodeMapConfig(env);
  assert.equal(config?.provider, "sourcekit-lsp");
  assert.equal(config?.executable, "/usr/bin/xcrun");
  const service = createConfiguredCodeMapService(env);
  assert.equal(service?.providerId, "sourcekit-lsp");
  assert.equal(service?.capabilities.callTrace, true);
});

test("Swift SourceKit provider does not start a language server for projects without Swift", async () => {
  const provider = new SourceKitLspProvider({
    executable: "/does/not/exist",
    inventory: { listFiles: async () => [{ path: "src/main.ts" }] },
  });
  const graph = await provider.indexProject({ projectId: "only-ts", rootPath: "/virtual/project" });
  assert.deepEqual(graph.nodes, []);
  assert.deepEqual(graph.relations, []);
  assert.equal(graph.coverage?.languages[0]?.semanticEligibleFileCount, 0);
});

test("Swift SourceKit provider fails closed when a Swift project has no BSP configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "questboard-swift-bsp-"));
  try {
    const provider = new SourceKitLspProvider({
      executable: "/does/not/exist",
      inventory: { listFiles: async () => [{ path: "Sources/Test.swift" }] },
    });
    await assert.rejects(
      provider.indexProject({ projectId: "unconfigured", rootPath: root }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, "code_map_semantic_index_failed");
        assert.match(String(error.cause), /buildServer\.json/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configured Swift Code Map preserves last-good instead of persisting a file-only graph", async () => {
  const root = await mkdtemp(join(tmpdir(), "questboard-swift-guard-"));
  try {
    await writeFile(join(root, "Test.swift"), "func hello() {}\n");
    const service = createConfiguredCodeMapService({
      QUESTBOARD_CODE_MAP: "1",
      QUESTBOARD_CODE_MAP_PROVIDER: "sourcekit-lsp",
    });
    assert.ok(service);
    await assert.rejects(
      service.refresh({ projectId: "guarded-swift", rootPath: root }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, "code_map_semantic_index_failed");
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
