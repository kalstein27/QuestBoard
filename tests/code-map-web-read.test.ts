import assert from "node:assert/strict";
import test from "node:test";
import { CODE_GRAPH_SCHEMA_VERSION, type CodeGraphSnapshot } from "../src/application/code-intelligence.js";
import { CodeMapQueryError } from "../src/application/code-map-query.js";
import { createCodeMapSourceTreePage } from "../src/application/code-map-web-read.js";

const graph: CodeGraphSnapshot = {
  schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
  projectId: "s7-web-read-synthetic",
  rootPath: "/synthetic",
  indexedAt: "2026-10-30T00:00:00.000Z",
  nodes: [
    { id: "file-main", kind: "file", name: "Main.php", canonicalIdentity: "file:src/Main.php",
      language: "php", location: { path: "src/Main.php" } },
    { id: "file-readme", kind: "file", name: "README.md", canonicalIdentity: "file:README.md",
      location: { path: "README.md" } },
    { id: "file-service", kind: "file", name: "Worker.php", canonicalIdentity: "file:src/Domain/Worker.php",
      language: "php", location: { path: "src/Domain/Worker.php" } },
    { id: "semantic", kind: "method", name: "run", canonicalIdentity: "native:run",
      location: { path: "src/Domain/Worker.php", startLine: 10 },
      provenance: [{ providerId: "scip-php", fidelity: "semantic-call" }] },
  ],
  relations: [],
};
const pin = { graphDigest: "digest", snapshotId: "exact-s7-web-source-tree-pin" };

test("P2 Web source directory page contains only immediate child folders/files and does not transfer semantic graph", () => {
  const root = createCodeMapSourceTreePage(graph, pin, { limit: 1 });
  assert.equal(root.projectId, graph.projectId);
  assert.equal(root.snapshotId, pin.snapshotId);
  assert.equal(root.candidateCount, 2);
  assert.equal(root.returnedCount, 1);
  assert.equal(root.hasMore, true);
  assert.equal(root.entries[0]?.type, "directory");
  assert.equal(root.entries[0]?.path, "src");
  const next = createCodeMapSourceTreePage(graph, pin, {
    offset: 1, limit: 1, expectedSnapshotId: pin.snapshotId,
  });
  assert.equal(next.entries[0]?.type, "file");
  assert.equal(next.entries[0]?.node?.id, "file-readme");
  assert.equal(next.entries[0]?.node?.canonicalIdentity, "file:README.md");
  assert.deepEqual(next.entries[0]?.node?.location, { path: "README.md" });
  assert.equal(next.entries[0]?.node?.provenance, undefined,
    "source tree intentionally transfers only minimal file identity");
  const src = createCodeMapSourceTreePage(graph, pin, {
    pathPrefix: "src", expectedSnapshotId: pin.snapshotId,
  });
  assert.deepEqual(src.entries.map(item => item.path), ["src/Domain", "src/Main.php"]);
  assert.equal(src.entries.some(item => item.name === "run"), false,
    "semantic relations and symbols are fetched separately through bounded queries");
});

test("P2 source tree rejects stale page pins, unpinned later offsets, invalid relative paths, and oversized limits", () => {
  const invalid = (input: Parameters<typeof createCodeMapSourceTreePage>[2]) =>
    assert.throws(() => createCodeMapSourceTreePage(graph, pin, input),
      (error: unknown) => error instanceof CodeMapQueryError);
  invalid({ offset: 1, limit: 1 });
  invalid({ offset: 1, limit: 1, expectedSnapshotId: "another-snapshot" });
  invalid({ pathPrefix: "../src" });
  invalid({ pathPrefix: "/src" });
  invalid({ pathPrefix: "src//Domain" });
  invalid({ pathPrefix: "src\\Domain" });
  invalid({ limit: 81 });
  invalid({ limit: 0 });
  invalid({ offset: -1 });
  assert.equal(createCodeMapSourceTreePage(graph, pin, {
    pathPrefix: "not-real", expectedSnapshotId: pin.snapshotId,
  }).candidateCount, 0);
});
