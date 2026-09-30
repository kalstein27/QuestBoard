import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  CODE_GRAPH_SCHEMA_VERSION,
  CodeMapProviderRegistry,
  CodeMapService,
  createQuestBoardHttpServer,
  executeQuestBoardAgentTool,
  QuestBoardService,
  SqliteQuestBoardRepository,
  type ActorRef,
  type CodeGraphSnapshot,
  type CodeIndexRequest,
  type CodeIntelligenceProvider,
  type CodeProviderDefinition,
} from "../src/index.js";

const human: ActorRef = { id: "human:owner", provider: "human" };
const installOption = {
  providerId: "scip-typescript",
  sourceType: "npm" as const,
  source: "@sourcegraph/scip-typescript",
  version: "0.4.0",
  executable: "scip-typescript",
  trust: "project-pinned" as const,
  requiresApproval: true as const,
  executionBoundary: "external-host" as const,
  permissions: ["network", "project-dependency-install"],
  reindexMode: "full" as const,
};
const definitions: readonly CodeProviderDefinition[] = [
  {
    providerId: "scip-typescript",
    languages: ["typescript", "javascript"],
    fidelity: "semantic-call",
    version: "0.4.0",
    installOption,
  },
];

function mixedGraph(projectId = "project-1", rootPath = "/workspace/project"): CodeGraphSnapshot {
  return {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId,
    rootPath,
    indexedAt: "2026-09-29T00:00:00.000Z",
    nodes: [
      { id: "file:src/main.ts", kind: "file", name: "main.ts", canonicalIdentity: "src/main.ts", language: "typescript", location: { path: "src/main.ts" }, provenance: [{ providerId: "questboard:file-inventory", fidelity: "file-only" }] },
      { id: "symbol:main", kind: "function", name: "main", canonicalIdentity: "main", language: "typescript", location: { path: "src/main.ts", startLine: 1 }, provenance: [{ providerId: "scip-typescript", fidelity: "semantic-call" }] },
      { id: "file:macos/App.swift", kind: "file", name: "App.swift", canonicalIdentity: "macos/App.swift", language: "swift", location: { path: "macos/App.swift" }, provenance: [{ providerId: "questboard:file-inventory", fidelity: "file-only" }] },
      { id: "file:scripts/run.sh", kind: "file", name: "run.sh", canonicalIdentity: "scripts/run.sh", language: "shellscript", location: { path: "scripts/run.sh" }, provenance: [{ providerId: "questboard:file-inventory", fidelity: "file-only" }] },
      { id: "file:windows/install.ps1", kind: "file", name: "install.ps1", canonicalIdentity: "windows/install.ps1", language: "powershell", location: { path: "windows/install.ps1" }, provenance: [{ providerId: "questboard:file-inventory", fidelity: "file-only" }] },
    ],
    relations: [
      { id: "contains:ts", from: "file:src/main.ts", to: "symbol:main", kind: "contains", confidence: 1, provenance: [{ providerId: "scip-typescript", fidelity: "semantic-call" }] },
    ],
    coverage: {
      degraded: false,
      providers: [{ providerId: "scip-typescript", status: "fresh", fidelity: "semantic-call", languages: ["typescript", "javascript"], nodeCount: 1, relationCount: 1 }],
      languages: [
        { language: "typescript", fileCount: 1, fidelity: "semantic-call", providerIds: ["scip-typescript"], degraded: false },
        { language: "swift", fileCount: 1, fidelity: "file-only", providerIds: [], degraded: false },
        { language: "shellscript", fileCount: 1, fidelity: "file-only", providerIds: [], degraded: false },
        { language: "powershell", fileCount: 1, fidelity: "file-only", providerIds: [], degraded: false },
      ],
    },
  };
}

test("provider capability report names concrete mixed-language gaps instead of generic unsupported", () => {
  const registry = new CodeMapProviderRegistry(definitions, () => ({
    configured: true,
    installed: true,
    available: true,
    executable: "/tools/scip-typescript",
    health: "ready",
    diagnostics: [],
  }));
  const report = registry.report(mixedGraph());

  assert.equal(report.indexed, true);
  assert.equal(report.providers[0]?.executable, "scip-typescript");
  assert.equal(report.languages.find((entry) => entry.language === "typescript")?.gapReason, null);
  assert.deepEqual(report.languages.find((entry) => entry.language === "typescript")?.providerIds, ["scip-typescript"]);
  for (const language of ["swift", "shellscript", "powershell"]) {
    const entry = report.languages.find((candidate) => candidate.language === language);
    assert.ok(entry, language);
    assert.equal(entry.discoveredFileCount, 1);
    assert.equal(entry.indexedFileCount, 0);
    assert.equal(entry.symbolCount, 0);
    assert.equal(entry.fidelity, "file-only");
    assert.equal(entry.gapReason, "no_trusted_provider_available");
    assert.deepEqual(entry.providerIds, []);
  }
});

test("provider capability distinguishes intentional compiler-project exclusions from real partial coverage", () => {
  const registry = new CodeMapProviderRegistry(definitions, () => ({
    configured: true,
    installed: true,
    available: true,
    executable: "/tools/scip-typescript",
    health: "ready",
    diagnostics: [],
  }));
  const baseGraph = mixedGraph();
  const graph: CodeGraphSnapshot = {
    ...baseGraph,
    nodes: [
      ...baseGraph.nodes,
      { id: "file:tests/main.test.ts", kind: "file", name: "main.test.ts", canonicalIdentity: "tests/main.test.ts", language: "typescript", location: { path: "tests/main.test.ts" }, provenance: [{ providerId: "questboard:file-inventory", fidelity: "file-only" }] },
      { id: "file:vitest.config.ts", kind: "file", name: "vitest.config.ts", canonicalIdentity: "vitest.config.ts", language: "typescript", location: { path: "vitest.config.ts" }, provenance: [{ providerId: "questboard:file-inventory", fidelity: "file-only" }] },
    ],
    coverage: {
      ...baseGraph.coverage!,
      providers: [...baseGraph.coverage!.providers],
      languages: baseGraph.coverage!.languages.map((entry) => ({ ...entry })),
    },
  };
  const typescriptCoverage = graph.coverage!.languages.find((entry) => entry.language === "typescript")!;
  Object.assign(typescriptCoverage, {
    fileCount: 3,
    semanticEligibleFileCount: 1,
    semanticIndexedFileCount: 1,
    semanticExcludedFileCount: 2,
    semanticExclusionReason: "provider_project_scope",
  });

  const report = registry.report(graph);
  const entry = report.languages.find((candidate) => candidate.language === "typescript")!;
  assert.equal(entry.discoveredFileCount, 3);
  assert.equal(entry.eligibleFileCount, 1);
  assert.equal(entry.indexedFileCount, 1);
  assert.equal(entry.excludedFileCount, 2);
  assert.equal(entry.exclusionReason, "provider_project_scope");
  assert.equal(entry.gapReason, null);

  Object.assign(typescriptCoverage, {
    semanticEligibleFileCount: 2,
    semanticIndexedFileCount: 1,
    semanticExcludedFileCount: 1,
  });
  const partial = registry.report(graph).languages.find((candidate) => candidate.language === "typescript")!;
  assert.equal(partial.gapReason, "partial_coverage");
});

class LifecycleProvider implements CodeIntelligenceProvider {
  readonly providerId = "scip-typescript";
  readonly languages = ["typescript"];
  readonly fidelity = "semantic-call" as const;
  readonly capabilities = { incrementalIndexing: false, impactAnalysis: false, callTrace: true } as const;
  semantic = false;

  async indexProject(request: CodeIndexRequest): Promise<CodeGraphSnapshot> {
    const graph = mixedGraph(request.projectId, request.rootPath);
    if (this.semantic) return graph;
    return {
      ...graph,
      nodes: graph.nodes.filter((node) => node.kind === "file"),
      relations: [],
      coverage: {
        degraded: true,
        providers: [{ providerId: "scip-typescript", status: "failed", fidelity: "semantic-call", languages: ["typescript"], nodeCount: 0, relationCount: 0 }],
        languages: graph.coverage!.languages.map((entry) => ({ ...entry, fidelity: "file-only", providerIds: [], degraded: entry.language === "typescript" })),
      },
    };
  }
}

test("trusted install requests are approval-only and external installation plus reindex can increase coverage", async () => {
  let available = false;
  const registry = new CodeMapProviderRegistry(definitions, () => ({
    configured: true,
    installed: available,
    available,
    executable: available ? "/tools/scip-typescript" : "scip-typescript",
    health: available ? "ready" : "missing_executable",
    diagnostics: available ? [] : ["Executable not found: scip-typescript"],
  }));
  const provider = new LifecycleProvider();
  const service = new CodeMapService(provider, undefined, registry);
  await service.refresh({ projectId: "project-1", rootPath: "/workspace/project" });

  const before = service.providerCapabilities("project-1")!;
  assert.equal(before.providers[0]?.available, false);
  assert.equal(before.providers[0]?.executable, "scip-typescript");
  assert.equal(before.languages.find((entry) => entry.language === "typescript")?.gapReason, "provider_missing");
  assert.equal(before.languages.find((entry) => entry.language === "typescript")?.symbolCount, 0);

  const request = service.requestProviderInstall("project-1", "scip-typescript");
  assert.equal(request.approvalRequired, true);
  assert.equal(request.executionBoundary, "external-host");
  assert.equal(request.indexingTriggered, false);
  assert.deepEqual(request.install, installOption);
  assert.equal(provider.semantic, false, "request generation must not install or reindex anything");

  available = true;
  provider.semantic = true;
  await service.refresh({ projectId: "project-1", rootPath: "/workspace/project" });
  const after = service.providerCapabilities("project-1")!;
  assert.equal(after.providers[0]?.available, true);
  assert.equal(after.languages.find((entry) => entry.language === "typescript")?.symbolCount, 1);
  assert.equal(after.languages.find((entry) => entry.language === "typescript")?.gapReason, null);
});

test("HTTP UI-facing discovery and agent tools share the same trusted install option", async () => {
  const registry = new CodeMapProviderRegistry(definitions, () => ({
    configured: true,
    installed: false,
    available: false,
    executable: "scip-typescript",
    health: "missing_executable",
    diagnostics: ["Executable not found: scip-typescript"],
  }));
  const provider = new LifecycleProvider();
  const codeMapService = new CodeMapService(provider, undefined, registry);
  const repository = new SqliteQuestBoardRepository();
  const service = new QuestBoardService(repository);
  const project = service.createProject({ name: "Provider lifecycle", rootPath: "/workspace/project" }, human);
  const context = { service, codeMapService };
  const server = createQuestBoardHttpServer(service, { codeMapService });

  try {
    const agentCapabilities = executeQuestBoardAgentTool(context, "questboard_get_code_map_provider_capabilities", { projectId: project.id }) as any;
    const agentInstall = executeQuestBoardAgentTool(context, "questboard_request_code_map_provider_install", { projectId: project.id, providerId: "scip-typescript" }) as any;

    await listen(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/projects/${encodeURIComponent(project.id)}/code-map/providers`;
    const httpCapabilities = await fetch(baseUrl).then((response) => response.json()) as any;
    const httpInstall = await fetch(`${baseUrl}/scip-typescript/install-request`, { method: "POST" }).then((response) => response.json()) as any;

    assert.deepEqual(httpCapabilities.capabilities.providers, agentCapabilities.capabilities.providers);
    assert.deepEqual(httpInstall.installRequest.install, agentInstall.installRequest.install);
    assert.equal(httpInstall.installRequest.approvalRequired, true);
    assert.equal(httpInstall.installRequest.executionBoundary, "external-host");
  } finally {
    await closeServer(server);
    repository.close();
  }
});

function listen(server: ReturnType<typeof createQuestBoardHttpServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function closeServer(server: ReturnType<typeof createQuestBoardHttpServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
