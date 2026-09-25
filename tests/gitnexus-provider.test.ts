import assert from "node:assert/strict";
import test from "node:test";
import {
  GITNEXUS_NODE_EXPORT_QUERY,
  GITNEXUS_RELATION_EXPORT_QUERY,
  GitNexusCodeIntelligenceProvider,
  parseGitNexusCypherOutput,
} from "../src/adapters/code-intelligence/gitnexus-provider.js";
import type {
  GitNexusCliRunOptions,
  GitNexusCliRunResult,
  GitNexusCliRunner,
} from "../src/adapters/code-intelligence/gitnexus-indexer.js";

interface Call {
  args: readonly string[];
  options: GitNexusCliRunOptions;
}

class FakeRunner implements GitNexusCliRunner {
  readonly calls: Call[] = [];
  readonly #results: GitNexusCliRunResult[];

  constructor(results: GitNexusCliRunResult[]) {
    this.#results = [...results];
  }

  async run(args: readonly string[], options: GitNexusCliRunOptions): Promise<GitNexusCliRunResult> {
    this.calls.push({ args: [...args], options });
    const result = this.#results.shift();
    if (!result) throw new Error("Unexpected GitNexus call");
    return result;
  }
}

function success(stdout: string): GitNexusCliRunResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function cypher(markdown: string, rowCount: number): string {
  return JSON.stringify({ markdown, row_count: rowCount });
}

test("parses controlled GitNexus markdown tables without leaking markdown into the graph", () => {
  const result = parseGitNexusCypherOutput(
    cypher("| uid | name |\n| --- | --- |\n| one | has\\|pipe |", 1),
  );

  assert.deepEqual(result.rows, [{ uid: "one", name: "has|pipe" }]);
  assert.throws(
    () => parseGitNexusCypherOutput(cypher("| uid |\n| --- |\n| one |", 2)),
    /row_count mismatch/,
  );
});

test("GitNexus provider serially indexes, verifies, exports, and normalizes the graph", async () => {
  const rootPath = "/workspace/questboard";
  const storageRoot = "/var/tmp/questboard-code-index";
  const runner = new FakeRunner([
    success("indexed"),
    success(
      JSON.stringify({
        status: "up-to-date",
        index: { runnerIdentityStatus: "current", incompleteReasons: [] },
      }),
    ),
    success(
      cypher(
        [
          "| uid | kind | name | filePath | startLine | endLine |",
          "| --- | --- | --- | --- | --- | --- |",
          "| service-native | Method | createTask | src/application/quest-board-service.ts | 250 | 280 |",
          "| repository-native | Interface | QuestBoardRepository | src/application/quest-board-repository.ts | 34 | 92 |",
        ].join("\n"),
        2,
      ),
    ),
    success(
      cypher(
        [
          "| fromUid | toUid | type | confidence | reason |",
          "| --- | --- | --- | --- | --- |",
          "| service-native | repository-native | TYPE_REF | 0.95 | constructor type |",
        ].join("\n"),
        1,
      ),
    ),
  ]);
  const provider = new GitNexusCodeIntelligenceProvider(runner, {
    storageRoot,
    now: () => "2026-09-22T13:00:00.000Z",
  });

  const graph = await provider.indexProject({ projectId: "questboard", rootPath });

  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.relations.length, 1);
  assert.equal(graph.relations[0]?.kind, "references_type");
  assert.equal(JSON.stringify(graph).includes("service-native"), false);
  assert.deepEqual(
    runner.calls.map((call) => call.args[0]),
    ["analyze", "status", "cypher", "cypher"],
  );
  assert.equal(runner.calls[2]?.args[1], GITNEXUS_NODE_EXPORT_QUERY);
  assert.equal(runner.calls[3]?.args[1], GITNEXUS_RELATION_EXPORT_QUERY);
  assert.equal(runner.calls[2]?.options.env?.GITNEXUS_STORAGE_ROOT, storageRoot);
});

test("GitNexus graph reader fails closed when an export reaches its row limit", async () => {
  const runner = new FakeRunner([
    success("indexed"),
    success(
      JSON.stringify({
        status: "up-to-date",
        index: { runnerIdentityStatus: "current", incompleteReasons: [] },
      }),
    ),
    success(cypher("| uid | kind | name | filePath | startLine | endLine |\n| --- | --- | --- | --- | --- | --- |\n| a | Class | A | src/a.ts | 1 | 2 |", 1)),
  ]);
  const provider = new GitNexusCodeIntelligenceProvider(runner, {
    storageRoot: "/tmp/index",
    maxRows: 1,
  });

  await assert.rejects(
    () => provider.indexProject({ projectId: "p", rootPath: "/workspace/p" }),
    /row safety limit/,
  );
});
