import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ScipTypeScriptCodeIntelligenceProvider,
  type ScipProcessRunOptions,
  type ScipProcessRunResult,
  type ScipProcessRunner,
} from "../src/adapters/code-intelligence/scip-provider.js";

interface Call {
  executable: string;
  args: readonly string[];
  options: ScipProcessRunOptions;
}

class FakeRunner implements ScipProcessRunner {
  readonly calls: Call[] = [];
  readonly #results: ScipProcessRunResult[];

  constructor(results: ScipProcessRunResult[]) {
    this.#results = [...results];
  }

  async run(executable: string, args: readonly string[], options: ScipProcessRunOptions): Promise<ScipProcessRunResult> {
    this.calls.push({ executable, args: [...args], options });
    const result = this.#results.shift();
    if (!result) throw new Error("Unexpected SCIP process call");
    return result;
  }
}

function success(stdout = ""): ScipProcessRunResult {
  return { stdout, stderr: "", exitCode: 0 };
}

const fixture = JSON.stringify({
  documents: [{
    relativePath: "src/application/quest-board-service.ts",
    language: "typescript",
    symbols: [{ symbol: "scip-typescript npm questboard 0.0.0 QuestBoardService#createTask().", displayName: "createTask", kind: "Method" }],
    occurrences: [{
      symbol: "scip-typescript npm questboard 0.0.0 QuestBoardService#createTask().",
      symbolRoles: 1,
      range: [3, 2, 12],
      enclosingRange: [3, 0, 20, 1],
    }],
  }],
});

test("SCIP TypeScript provider keeps index.scip outside the repository and normalizes scip print JSON", async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), "questboard-scip-"));
  try {
    const runner = new FakeRunner([success(), success(fixture)]);
    const provider = new ScipTypeScriptCodeIntelligenceProvider(runner, {
      storageRoot,
      indexerExecutable: "scip-typescript-test",
      scipExecutable: "scip-test",
      now: () => "2026-09-23T00:00:00.000Z",
    });

    const graph = await provider.indexProject({
      projectId: "questboard",
      rootPath: "/workspace/questboard",
    });

    assert.equal(graph.nodes.length, 1);
    assert.equal(graph.nodes[0]?.name, "createTask");
    assert.equal(runner.calls[0]?.executable, "scip-typescript-test");
    assert.deepEqual(runner.calls[0]?.args.slice(0, 2), ["index", "--output"]);
    const outputPath = runner.calls[0]?.args[2] ?? "";
    assert.ok(outputPath.startsWith(storageRoot));
    assert.equal(outputPath.startsWith("/workspace/questboard"), false);
    assert.equal(outputPath.endsWith("/index.scip"), true);
    assert.equal(runner.calls[0]?.options.cwd, "/workspace/questboard");
    assert.equal(runner.calls[1]?.executable, "scip-test");
    assert.deepEqual(runner.calls[1]?.args, ["print", "--json", outputPath]);
    assert.equal(runner.calls[1]?.options.cwd, join(outputPath, ".."));
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test("SCIP provider advertises full-index semantics instead of claiming incremental support", () => {
  const provider = new ScipTypeScriptCodeIntelligenceProvider(new FakeRunner([]), {
    storageRoot: "/tmp/questboard-scip",
  });
  assert.equal(provider.providerId, "scip-typescript");
  assert.deepEqual(provider.capabilities, {
    incrementalIndexing: false,
    impactAnalysis: false,
    callTrace: false,
  });
});


test("SCIP provider enriches call relations from indexed source text", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "questboard-scip-project-"));
  const storageRoot = mkdtempSync(join(tmpdir(), "questboard-scip-storage-"));
  try {
    writeFileSync(join(projectRoot, "caller.ts"), "function caller() {\n  target();\n}\n");
    writeFileSync(join(projectRoot, "service.ts"), "function target() {}\n");
    const liveFixture = JSON.stringify({
      documents: [
        {
          relativePath: "caller.ts",
          language: "typescript",
          symbols: [{ symbol: "scip ts qb 0 caller/caller().", displayName: "caller", kind: "Function" }],
          occurrences: [
            { symbol: "scip ts qb 0 caller/caller().", symbolRoles: 1, range: [0, 9, 15], enclosingRange: [0, 0, 2, 1] },
            { symbol: "scip ts qb 0 service/target().", symbolRoles: 0, range: [1, 2, 8] },
          ],
        },
        {
          relativePath: "service.ts",
          language: "typescript",
          symbols: [{ symbol: "scip ts qb 0 service/target().", displayName: "target", kind: "Function" }],
          occurrences: [{ symbol: "scip ts qb 0 service/target().", symbolRoles: 1, range: [0, 9, 15], enclosingRange: [0, 0, 0, 20] }],
        },
      ],
    });
    const runner = new FakeRunner([success(), success(liveFixture)]);
    const provider = new ScipTypeScriptCodeIntelligenceProvider(runner, {
      storageRoot,
      indexerExecutable: "scip-typescript-test",
      scipExecutable: "scip-test",
      now: () => "2026-09-23T00:00:00.000Z",
    });

    const graph = await provider.indexProject({ projectId: "questboard", rootPath: projectRoot });

    assert.equal(graph.relations.filter((relation) => relation.kind === "calls").length, 1);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(storageRoot, { recursive: true, force: true });
  }
});