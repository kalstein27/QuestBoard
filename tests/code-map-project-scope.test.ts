import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CODE_GRAPH_SCHEMA_VERSION, type CodeIntelligenceProvider } from "../src/application/code-intelligence.js";
import { CompositeCodeIntelligenceProvider } from "../src/application/composite-code-intelligence-provider.js";
import { CodeMapService } from "../src/application/code-map-service.js";
import { normalizeCodeMapExcludedPaths, scopedCodeMapFiles } from "../src/application/code-map-path-scope.js";
import { FileSystemCodeFileInventory } from "../src/adapters/code-intelligence/file-inventory.js";
import { QuestBoardService } from "../src/application/quest-board-service.js";
import { executeQuestBoardAgentTool } from "../src/adapters/agent-tools.js";
import { SqliteQuestBoardRepository } from "../src/storage/sqlite/sqlite-quest-board-repository.js";

const actor = { id: "human:owner", provider: "human" };

test("per-project excluded paths are validated, persisted and replaceable without changing another project", () => {
  const root = mkdtempSync(join(tmpdir(), "qb-scope-store-"));
  const dbPath = join(root, "board.sqlite");
  try {
    let repo = new SqliteQuestBoardRepository(dbPath);
    let service = new QuestBoardService(repo);
    const one = service.createProject({ name: "one" }, actor);
    const two = service.createProject({ name: "two" }, actor);
    const updated = service.updateProject(one.id, {
      codeMapExcludedPaths: ["Labs/**", "docs/evidence/", "Labs/**"],
    }, actor);
    assert.deepEqual(updated.codeMapExcludedPaths, ["Labs", "docs/evidence"]);
    assert.deepEqual(service.getProject(two.id).codeMapExcludedPaths, []);
    for (const bad of ["../outside", "/tmp", "foo/../src", "**", "foo/*", "", "C:/root"]) {
      assert.throws(() => service.updateProject(one.id, { codeMapExcludedPaths: [bad] }, actor), TypeError, bad);
    }
    repo.close();
    repo = new SqliteQuestBoardRepository(dbPath);
    service = new QuestBoardService(repo);
    assert.deepEqual(service.getProject(one.id).codeMapExcludedPaths, ["Labs", "docs/evidence"]);
    assert.deepEqual(service.updateProject(one.id, { codeMapExcludedPaths: [] }, actor).codeMapExcludedPaths, []);
    repo.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("scoped refresh removes excluded files, semantic nodes, dangling edges and call-site evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "qb-scoped-index-"));
  try {
    for (const dir of ["src", "Labs", "Labs-more"]) mkdirSync(join(root, dir));
    for (const path of ["src/main.swift", "Labs/old.swift", "Labs-more/keep.swift"]) {
      writeFileSync(join(root, path), "func work() {}\n");
    }
    const request = { projectId: "scope-e2e", rootPath: root, excludedPaths: ["Labs"] };
    const fake: CodeIntelligenceProvider = {
      providerId: "swift-fixture",
      languages: ["swift"],
      fidelity: "semantic-call",
      capabilities: { incrementalIndexing: false, impactAnalysis: false, callTrace: true },
      async indexProject(input) {
        assert.deepEqual(input.excludedPaths, ["Labs"]);
        const nodes = ["src/main.swift", "Labs/old.swift", "Labs-more/keep.swift"].map((path, i) => ({
          id: "n" + i, kind: "function" as const, name: "work", canonicalIdentity: path,
          language: "swift", location: { path, startLine: 1 },
        }));
        return {
          schemaVersion: CODE_GRAPH_SCHEMA_VERSION, projectId: input.projectId,
          rootPath: input.rootPath, indexedAt: new Date().toISOString(),
          nodes,
          relations: [
            { id: "old-edge", from: "n0", to: "n1", kind: "calls" as const, confidence: 1,
              evidence: [{ location: { path: "src/main.swift", startLine: 1 } }] },
            { id: "keep-edge", from: "n0", to: "n2", kind: "calls" as const, confidence: 1,
              evidence: [
                { location: { path: "src/main.swift", startLine: 1 } },
                { location: { path: "Labs/old.swift", startLine: 1 } },
              ] },
          ],
        };
      },
    };
    const inventory = new FileSystemCodeFileInventory();
    const composite = new CompositeCodeIntelligenceProvider([fake], inventory);
    const service = new CodeMapService(composite, inventory);
    const result = await service.refresh(request);
    const paths = result.graph.nodes.map(node => node.location?.path).filter(Boolean);
    assert.ok(paths.includes("src/main.swift"));
    assert.ok(paths.includes("Labs-more/keep.swift"));
    assert.ok(!paths.includes("Labs/old.swift"));
    assert.ok(!result.graph.relations.some(rel => rel.id === "old-edge"));
    assert.equal(result.graph.relations.find(rel => rel.id === "keep-edge")?.evidence?.length, 1);
    assert.equal(result.graph.coverage?.languages.find(l => l.language === "swift")?.fileCount, 2);
    assert.deepEqual(scopedCodeMapFiles([{ path: "Labs/old.swift" }, { path: "Labs-more/keep.swift" }], request),
      [{ path: "Labs-more/keep.swift" }]);
    assert.deepEqual(normalizeCodeMapExcludedPaths(["src/**", "src"]), ["src"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Code Map web exposes saved project scope without editing repository files", () => {
  const markup = readFileSync(join(process.cwd(), "web/index.html"), "utf8");
  const app = readFileSync(join(process.cwd(), "web/app.js"), "utf8");
  assert.match(markup, /id="code-map-excluded-paths"/);
  assert.match(markup, /id="code-map-scope"/);
  assert.match(app, /body: \{ codeMapExcludedPaths \}/);
  assert.match(app, /Index scope saved\. Run Index code to apply/);
});

test("agent may save project scope without implicitly running a refresh", () => {
  const repo = new SqliteQuestBoardRepository();
  try {
    const service = new QuestBoardService(repo);
    const project = service.createProject({ name: "TouchPilot" }, actor);
    const result = executeQuestBoardAgentTool({ service },
      "questboard_set_code_map_excluded_paths", {
        projectId: project.id, excludedPaths: ["Labs/**", "docs/evidence/**"], actor,
      }) as { project: { codeMapExcludedPaths: string[] } };
    assert.deepEqual(result.project.codeMapExcludedPaths, ["Labs", "docs/evidence"]);
    assert.deepEqual(service.getProject(project.id).codeMapExcludedPaths, ["Labs", "docs/evidence"]);
  } finally { repo.close(); }
});
