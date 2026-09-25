import assert from "node:assert/strict";
import test from "node:test";
import {
  GitNexusIndexer,
  assertFreshGitNexusStatus,
  parseGitNexusStatusJson,
  type GitNexusCliRunOptions,
  type GitNexusCliRunResult,
  type GitNexusCliRunner,
} from "../src/adapters/code-intelligence/gitnexus-indexer.js";

interface RecordedCall {
  args: readonly string[];
  options: GitNexusCliRunOptions;
}

class FakeRunner implements GitNexusCliRunner {
  readonly calls: RecordedCall[] = [];
  readonly #results: GitNexusCliRunResult[];

  constructor(results: GitNexusCliRunResult[]) {
    this.#results = [...results];
  }

  async run(args: readonly string[], options: GitNexusCliRunOptions): Promise<GitNexusCliRunResult> {
    this.calls.push({ args: [...args], options });
    const result = this.#results.shift();
    if (!result) {
      throw new Error("Unexpected GitNexus command");
    }
    return result;
  }
}

function success(stdout = "", stderr = ""): GitNexusCliRunResult {
  return { stdout, stderr, exitCode: 0 };
}

test("GitNexus indexer keeps generated files outside the repository and verifies freshness", async () => {
  const rootPath = "/workspace/example";
  const storageRoot = "/var/tmp/questboard-code-index";
  const runner = new FakeRunner([
    success("indexed", "analysis complete"),
    success(
      JSON.stringify({
        status: "up-to-date",
        index: {
          commit: "abc123",
          runnerIdentityStatus: "current",
          incompleteReasons: [],
        },
      }),
    ),
  ]);
  const indexer = new GitNexusIndexer(runner, { storageRoot });

  const result = await indexer.ensureIndexed(rootPath);

  assert.equal(result.status.status, "up-to-date");
  assert.equal(result.status.commit, "abc123");
  assert.equal(result.analyzeStderr, "analysis complete");
  assert.deepEqual(runner.calls.map((call) => call.args), [
    ["analyze", rootPath, "--index-only"],
    ["status", "--repo", rootPath, "--json"],
  ]);
  for (const call of runner.calls) {
    assert.equal(call.options.cwd, rootPath);
    assert.equal(call.options.env?.GITNEXUS_STORAGE_ROOT, storageRoot);
  }
});

test("GitNexus status parser accepts snake-case incomplete reasons but freshness stays fail-closed", () => {
  const incomplete = parseGitNexusStatusJson(
    JSON.stringify({
      status: "up-to-date",
      index: {
        runnerIdentityStatus: "current",
        incomplete_reasons: ["parser-warning"],
      },
    }),
  );
  assert.deepEqual(incomplete.incompleteReasons, ["parser-warning"]);
  assert.throws(() => assertFreshGitNexusStatus(incomplete), /index is incomplete/);

  const missingIdentity = parseGitNexusStatusJson(
    JSON.stringify({ status: "up-to-date", index: { incompleteReasons: [] } }),
  );
  assert.throws(() => assertFreshGitNexusStatus(missingIdentity), /runner identity is not current/);

  const stale = parseGitNexusStatusJson(
    JSON.stringify({
      status: "behind",
      index: { runnerIdentityStatus: "current", incompleteReasons: [] },
    }),
  );
  assert.throws(() => assertFreshGitNexusStatus(stale), /index is not current/);
});
