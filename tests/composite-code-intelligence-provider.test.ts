import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_GRAPH_SCHEMA_VERSION,
  CompositeCodeIntelligenceProvider,
  type CodeFileInventory,
  type CodeGraphSnapshot,
  type CodeIndexRequest,
  type CodeIntelligenceProvider,
} from "../src/index.js";

class StaticInventory implements CodeFileInventory {
  constructor(private readonly paths: readonly string[]) {}
  async listFiles() {
    return this.paths.map((path) => ({ path }));
  }
}

class MutableProvider implements CodeIntelligenceProvider {
  readonly capabilities = {
    incrementalIndexing: false,
    impactAnalysis: false,
    callTrace: true,
  } as const;
  fail = false;

  constructor(
    readonly providerId: string,
    readonly languages: readonly string[],
    readonly fidelity: "semantic-reference" | "semantic-call",
    private readonly snapshot: CodeGraphSnapshot,
  ) {}

  async indexProject(_request: CodeIndexRequest): Promise<CodeGraphSnapshot> {
    if (this.fail) throw new Error(`${this.providerId} failed`);
    return structuredClone(this.snapshot);
  }
}

function tsGraph(providerNodeId = "ts-run", providerRelationId = "ts-call"): CodeGraphSnapshot {
  return {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId: "mixed",
    rootPath: "/workspace/mixed",
    indexedAt: "2026-09-28T01:00:00.000Z",
    nodes: [
      {
        id: "ts-caller",
        kind: "function",
        name: "main",
        canonicalIdentity: "src/main.ts#function:main",
        language: "typescript",
        location: { path: "src/main.ts", startLine: 1 },
      },
      {
        id: providerNodeId,
        kind: "function",
        name: "run",
        canonicalIdentity: "src/service.ts#function:run",
        language: "typescript",
        location: { path: "src/service.ts", startLine: 1 },
      },
    ],
    relations: [
      {
        id: providerRelationId,
        from: "ts-caller",
        to: providerNodeId,
        kind: "calls",
        confidence: 0.8,
        evidence: [{ location: { path: "src/main.ts", startLine: 2 }, label: "call" }],
      },
    ],
  };
}

function duplicateTsGraph(): CodeGraphSnapshot {
  return {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId: "mixed",
    rootPath: "/workspace/mixed",
    indexedAt: "2026-09-28T01:01:00.000Z",
    nodes: [
      {
        id: "second-caller-id",
        kind: "function",
        name: "main",
        canonicalIdentity: "src/main.ts#function:main",
        language: "typescript",
        location: { path: "src/main.ts", startLine: 1 },
      },
      {
        id: "second-run-id",
        kind: "function",
        name: "run",
        canonicalIdentity: "src/service.ts#function:run",
        language: "typescript",
        location: { path: "src/service.ts", startLine: 1 },
      },
    ],
    relations: [
      {
        id: "second-call-id",
        from: "second-caller-id",
        to: "second-run-id",
        kind: "calls",
        confidence: 0.95,
        evidence: [{ location: { path: "src/main.ts", startLine: 2 }, label: "second provider" }],
      },
    ],
  };
}

const inventory = new StaticInventory([
  "src/main.ts",
  "src/service.ts",
  "macos/Companion.swift",
  "scripts/bootstrap.sh",
  "windows/install.ps1",
]);

const request = { projectId: "mixed", rootPath: "/workspace/mixed" };

test("composite Code Map keeps mixed-language files while preserving semantic provider facts and provenance", async () => {
  const scip = new MutableProvider("scip-typescript", ["typescript", "javascript"], "semantic-call", tsGraph());
  const provider = new CompositeCodeIntelligenceProvider([scip], inventory, {
    now: () => "2026-09-28T02:00:00.000Z",
  });

  const graph = await provider.indexProject(request);
  const files = graph.nodes.filter((node) => node.kind === "file");
  const byPath = new Map(files.map((node) => [node.location?.path, node] as const));
  const run = graph.nodes.find((node) => node.name === "run")!;
  const call = graph.relations.find((relation) => relation.kind === "calls")!;

  assert.equal(provider.providerId, "scip-typescript");
  assert.equal(files.length, 5);
  assert.equal(byPath.get("macos/Companion.swift")?.language, "swift");
  assert.equal(byPath.get("scripts/bootstrap.sh")?.language, "shellscript");
  assert.equal(byPath.get("windows/install.ps1")?.language, "powershell");
  assert.deepEqual(run.provenance, [{ providerId: "scip-typescript", fidelity: "semantic-call", freshness: "fresh" }]);
  assert.deepEqual(call.provenance, [{ providerId: "scip-typescript", fidelity: "semantic-call", freshness: "fresh" }]);
  assert.equal(graph.coverage?.degraded, false);
  assert.equal(graph.coverage?.languages.find((entry) => entry.language === "typescript")?.fidelity, "semantic-call");
  assert.equal(graph.coverage?.languages.find((entry) => entry.language === "swift")?.fidelity, "file-only");
});

test("composite Code Map deduplicates exact facts, keeps first provider stable ids, and merges evidence/provenance", async () => {
  const first = new MutableProvider("first", ["typescript"], "semantic-call", tsGraph());
  const second = new MutableProvider("second", ["typescript"], "semantic-call", duplicateTsGraph());
  const provider = new CompositeCodeIntelligenceProvider([first, second], inventory, {
    now: () => "2026-09-28T02:00:00.000Z",
  });

  const graph = await provider.indexProject(request);
  const run = graph.nodes.filter((node) => node.canonicalIdentity === "src/service.ts#function:run");
  const calls = graph.relations.filter((relation) => relation.kind === "calls");

  assert.equal(run.length, 1);
  assert.equal(run[0]?.id, "ts-run", "first provider keeps the stable id");
  assert.deepEqual(run[0]?.provenance?.map((entry) => entry.providerId), ["first", "second"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.id, "ts-call");
  assert.equal(calls[0]?.confidence, 0.95);
  assert.equal(calls[0]?.evidence?.length, 2);
  assert.deepEqual(calls[0]?.provenance?.map((entry) => entry.providerId), ["first", "second"]);
});

test("provider failure degrades only its coverage and reuses provider last-good facts as stale", async () => {
  const scip = new MutableProvider("scip-typescript", ["typescript", "javascript"], "semantic-call", tsGraph());
  const provider = new CompositeCodeIntelligenceProvider([scip], inventory, {
    now: () => "2026-09-28T02:00:00.000Z",
  });

  await provider.indexProject(request);
  scip.fail = true;
  const degraded = await provider.indexProject(request);
  const run = degraded.nodes.find((node) => node.name === "run")!;

  assert.equal(degraded.coverage?.degraded, true);
  assert.equal(degraded.coverage?.providers[0]?.status, "stale");
  assert.equal(run.provenance?.[0]?.freshness, "stale");
  assert.ok(degraded.nodes.some((node) => node.location?.path === "macos/Companion.swift"));
});

test("first-run provider failure still yields a file-only indexed graph instead of collapsing Code Map", async () => {
  const scip = new MutableProvider("scip-typescript", ["typescript", "javascript"], "semantic-call", tsGraph());
  scip.fail = true;
  const provider = new CompositeCodeIntelligenceProvider([scip], inventory, {
    now: () => "2026-09-28T02:00:00.000Z",
  });

  const degraded = await provider.indexProject(request);

  assert.equal(degraded.nodes.filter((node) => node.kind === "file").length, 5);
  assert.equal(degraded.relations.length, 0);
  assert.equal(degraded.coverage?.degraded, true);
  assert.equal(degraded.coverage?.providers[0]?.status, "failed");
  assert.equal(degraded.coverage?.languages.find((entry) => entry.language === "typescript")?.fidelity, "file-only");
});
