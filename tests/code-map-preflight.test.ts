import assert from "node:assert/strict";
import test from "node:test";
import {
  CodeMapProviderRegistry,
  CodeMapService,
  executeQuestBoardAgentTool,
  inspectCodeMapPreflight,
  QuestBoardService,
  SqliteQuestBoardRepository,
  type ActorRef,
  type CodeFileInventory,
  type CodeFileInventoryEntry,
  type CodeGraphSnapshot,
  type CodeIndexRequest,
  type CodeIntelligenceProvider,
  type CodeMapPersistenceConfig,
  type CodeProviderDefinition,
} from "../src/index.js";

const providerDefinitions: readonly CodeProviderDefinition[] = [
  {
    providerId: "scip-typescript",
    languages: ["typescript", "javascript"],
    fidelity: "semantic-call",
    version: "0.4.0",
    installOption: {
      providerId: "scip-typescript",
      sourceType: "npm",
      source: "@sourcegraph/scip-typescript",
      version: "0.4.0",
      executable: "scip-typescript",
      trust: "project-pinned",
      requiresApproval: true,
      executionBoundary: "external-host",
      permissions: ["network", "project-dependency-install"],
      reindexMode: "full",
    },
  },
  {
    providerId: "scip-php",
    languages: ["php"],
    fidelity: "semantic-call",
    version: "test",
    installOption: {
      providerId: "scip-php",
      sourceType: "composer",
      source: "davidrjenni/scip-php",
      version: "test",
      executable: "scip-php",
      trust: "project-pinned",
      requiresApproval: true,
      executionBoundary: "external-host",
      permissions: ["network", "project-dependency-install"],
      reindexMode: "full",
    },
  },
];

class FakeInventory implements CodeFileInventory {
  calls = 0;

  constructor(
    private readonly entries: readonly CodeFileInventoryEntry[] = [],
    private readonly failure?: Error,
  ) {}

  async listFiles(): Promise<readonly CodeFileInventoryEntry[]> {
    this.calls += 1;
    if (this.failure) throw this.failure;
    return this.entries;
  }
}

class NeverIndexProvider implements CodeIntelligenceProvider {
  readonly providerId = "test-provider";
  readonly capabilities = {
    incrementalIndexing: false,
    impactAnalysis: false,
    callTrace: false,
  } as const;
  calls = 0;

  async indexProject(_request: CodeIndexRequest): Promise<CodeGraphSnapshot> {
    this.calls += 1;
    throw new Error("preflight must not invoke semantic indexing");
  }
}

function persistence(rootPath?: string): CodeMapPersistenceConfig {
  return {
    store: {
      load: () => undefined,
      save: () => {},
    },
    sourceState: {
      rootIdentity: (value) => value,
      sourceManifestFingerprint: () => "preflight-test",
    },
    providerConfigFingerprint: "preflight-test",
    rootPathForProject: (projectId) => projectId === "project-1" ? rootPath : undefined,
  };
}

function providerRegistry(availableProviderIds: readonly string[] = []): CodeMapProviderRegistry {
  const available = new Set(availableProviderIds);
  return new CodeMapProviderRegistry(providerDefinitions, (definition) => ({
    configured: true,
    installed: available.has(definition.providerId),
    available: available.has(definition.providerId),
    executable: definition.providerId,
    health: available.has(definition.providerId) ? "ready" : "missing_executable",
    diagnostics: [],
  }));
}

test("Code Map preflight detects normalized project languages without semantic indexing", async () => {
  const inventory = new FakeInventory([
    { path: "src/main.ts" },
    { path: "src/view.tsx" },
    { path: "web/app.js" },
    { path: "php/index.php" },
    { path: "php/lib/Service.php" },
    { path: "generated/custom.file", language: "Go" },
    { path: "README.md" },
  ]);

  const report = await inspectCodeMapPreflight("/workspace/project", inventory);

  assert.equal(report.status, "ready");
  assert.equal(report.rootPathConfigured, true);
  assert.equal(report.inventoryAvailable, true);
  assert.equal(report.totalFileCount, 7);
  assert.equal(report.recognizedFileCount, 6);
  assert.equal(report.unknownFileCount, 1);
  assert.deepEqual(report.languages, [
    { language: "go", discoveredFileCount: 1 },
    { language: "javascript", discoveredFileCount: 1 },
    { language: "php", discoveredFileCount: 2 },
    { language: "typescript", discoveredFileCount: 2 },
  ]);
});

test("Code Map preflight reports missing canonical root without scanning", async () => {
  const inventory = new FakeInventory([{ path: "src/main.ts" }]);

  const report = await inspectCodeMapPreflight(undefined, inventory);

  assert.equal(report.status, "unavailable");
  assert.equal(report.unavailableReason, "root_path_unavailable");
  assert.equal(report.rootPathConfigured, false);
  assert.equal(report.inventoryAvailable, true);
  assert.equal(inventory.calls, 0);
});

test("Code Map preflight fails closed when repository inventory cannot be read", async () => {
  const inventory = new FakeInventory([], new Error("filesystem unavailable"));

  const report = await inspectCodeMapPreflight("/workspace/project", inventory);

  assert.equal(report.status, "unavailable");
  assert.equal(report.unavailableReason, "inventory_failed");
  assert.equal(report.rootPathConfigured, true);
  assert.equal(report.inventoryAvailable, true);
  assert.deepEqual(report.languages, []);
});

test("CodeMapService can preflight canonical project root before the first index", async () => {
  const provider = new NeverIndexProvider();
  const inventory = new FakeInventory([
    { path: "src/main.ts" },
    { path: "app/index.php" },
  ]);
  const service = new CodeMapService(
    provider,
    undefined,
    undefined,
    undefined,
    persistence("/workspace/project"),
    inventory,
  );

  const report = await service.preflight("project-1");

  assert.equal(report.status, "ready");
  assert.deepEqual(report.languages, [
    { language: "php", discoveredFileCount: 1 },
    { language: "typescript", discoveredFileCount: 1 },
  ]);
  assert.equal(inventory.calls, 1);
  assert.equal(provider.calls, 0);
  assert.equal(service.getCached("project-1"), undefined);
});

test("pre-index provider requirements mark only detected-language providers as required", async () => {
  const provider = new NeverIndexProvider();
  const inventory = new FakeInventory([
    { path: "src/main.ts" },
    { path: "web/app.js" },
    { path: "README.md" },
  ]);
  const service = new CodeMapService(
    provider,
    undefined,
    providerRegistry(["scip-typescript"]),
    undefined,
    persistence("/workspace/project"),
    inventory,
  );

  const report = await service.providerCapabilitiesWithPreflight("project-1");
  assert.ok(report);
  const typescript = report.providers.find((entry) => entry.providerId === "scip-typescript");
  const php = report.providers.find((entry) => entry.providerId === "scip-php");

  assert.equal(typescript?.requirement, "required");
  assert.equal(typescript?.requirementReason, "detected_supported_language");
  assert.deepEqual(typescript?.matchingLanguages, ["javascript", "typescript"]);
  assert.equal(php?.requirement, "not_needed");
  assert.equal(php?.requirementReason, "supported_language_not_detected");
  assert.deepEqual(php?.matchingLanguages, []);
  assert.equal(report.indexed, false);
  assert.equal(report.health, "healthy");
  assert.equal(report.semanticCoverage, null);
  assert.deepEqual(report.languages.map((entry) => ({
    language: entry.language,
    discoveredFileCount: entry.discoveredFileCount,
    eligibleFileCount: entry.eligibleFileCount,
    indexedFileCount: entry.indexedFileCount,
    symbolCount: entry.symbolCount,
    fidelity: entry.fidelity,
    semanticCoverage: entry.semanticCoverage,
    gapReason: entry.gapReason,
    installOptions: entry.installOptions.map((option) => option.providerId),
  })), [
    {
      language: "javascript",
      discoveredFileCount: 1,
      eligibleFileCount: null,
      indexedFileCount: 0,
      symbolCount: 0,
      fidelity: "file-only",
      semanticCoverage: "unavailable",
      gapReason: "file_only",
      installOptions: [],
    },
    {
      language: "typescript",
      discoveredFileCount: 1,
      eligibleFileCount: null,
      indexedFileCount: 0,
      symbolCount: 0,
      fidelity: "file-only",
      semanticCoverage: "unavailable",
      gapReason: "file_only",
      installOptions: [],
    },
    {
      language: "unknown",
      discoveredFileCount: 1,
      eligibleFileCount: 0,
      indexedFileCount: 0,
      symbolCount: 0,
      fidelity: "file-only",
      semanticCoverage: "not_applicable",
      gapReason: null,
      installOptions: [],
    },
  ]);
  assert.equal(provider.calls, 0);
});

test("pre-index provider requirements detect PHP-only projects", async () => {
  const service = new CodeMapService(
    new NeverIndexProvider(),
    undefined,
    providerRegistry(),
    undefined,
    persistence("/workspace/project"),
    new FakeInventory([
      { path: "public/index.php" },
      { path: "src/Service.php" },
    ]),
  );

  const report = await service.providerCapabilitiesWithPreflight("project-1");
  assert.ok(report);
  const typescript = report.providers.find((entry) => entry.providerId === "scip-typescript");
  const php = report.providers.find((entry) => entry.providerId === "scip-php");

  assert.equal(typescript?.requirement, "not_needed");
  assert.equal(php?.requirement, "required");
  assert.equal(php?.requirementReason, "detected_supported_language");
  assert.deepEqual(php?.matchingLanguages, ["php"]);
  assert.equal(report.health, "degraded");
  assert.deepEqual(report.languages.map((entry) => ({
    language: entry.language,
    discoveredFileCount: entry.discoveredFileCount,
    eligibleFileCount: entry.eligibleFileCount,
    indexedFileCount: entry.indexedFileCount,
    semanticCoverage: entry.semanticCoverage,
    gapReason: entry.gapReason,
    installOptions: entry.installOptions.map((option) => option.providerId),
  })), [{
    language: "php",
    discoveredFileCount: 2,
    eligibleFileCount: null,
    indexedFileCount: 0,
    semanticCoverage: "unavailable",
    gapReason: "provider_missing",
    installOptions: ["scip-php"],
  }]);
});

test("mixed TypeScript and PHP preflight recommends only the missing required PHP provider", async () => {
  const repository = new SqliteQuestBoardRepository();
  const questBoard = new QuestBoardService(repository);
  const actor: ActorRef = { id: "human:owner", provider: "human" };
  const project = questBoard.createProject({
    name: "Mixed preflight",
    rootPath: "/workspace/mixed-project",
  }, actor);
  const provider = new NeverIndexProvider();
  const codeMapService = new CodeMapService(
    provider,
    undefined,
    providerRegistry(["scip-typescript"]),
    undefined,
    undefined,
    new FakeInventory([
      { path: "src/main.ts" },
      { path: "public/index.php" },
    ]),
  );

  try {
    const status = await executeQuestBoardAgentTool(
      { service: questBoard, codeMapService },
      "questboard_get_code_map_status",
      { projectId: project.id },
    ) as { codeMap: any };

    assert.deepEqual(status.codeMap.detectedLanguages, [
      { language: "php", discoveredFileCount: 1 },
      { language: "typescript", discoveredFileCount: 1 },
    ]);
    assert.deepEqual(status.codeMap.providers.map((entry: any) => ({
      providerId: entry.providerId,
      available: entry.available,
      requirement: entry.requirement,
    })), [
      { providerId: "scip-typescript", available: true, requirement: "required" },
      { providerId: "scip-php", available: false, requirement: "required" },
    ]);
    assert.deepEqual(status.codeMap.recommendedNextAction, {
      tool: "questboard_request_code_map_provider_install",
      args: { projectId: project.id, providerId: "scip-php" },
      reason: "required_provider_missing",
    });
    assert.equal(provider.calls, 0);
  } finally {
    repository.close();
  }
});

test("projects with no semantic languages stay file-only without useless provider installs", async () => {
  const repository = new SqliteQuestBoardRepository();
  const questBoard = new QuestBoardService(repository);
  const actor: ActorRef = { id: "human:owner", provider: "human" };
  const project = questBoard.createProject({
    name: "Docs only preflight",
    rootPath: "/workspace/docs-only",
  }, actor);
  const codeMapService = new CodeMapService(
    new NeverIndexProvider(),
    undefined,
    providerRegistry(),
    undefined,
    undefined,
    new FakeInventory([
      { path: "README.md" },
      { path: "config.json" },
    ]),
  );

  try {
    const status = await executeQuestBoardAgentTool(
      { service: questBoard, codeMapService },
      "questboard_get_code_map_status",
      { projectId: project.id },
    ) as { codeMap: any };

    assert.equal(status.codeMap.providerHealth, "healthy");
    assert.deepEqual(status.codeMap.detectedLanguages, [
      { language: "unknown", discoveredFileCount: 2 },
    ]);
    assert.ok(status.codeMap.providers.every((entry: any) => entry.requirement === "not_needed"));
    assert.deepEqual(status.codeMap.recommendedNextAction, {
      tool: "questboard_refresh_code_map",
      args: { projectId: project.id },
      reason: "refresh_required_unindexed",
    });
    await assert.rejects(
      codeMapService.requestProviderInstall(project.id, "scip-php", project.rootPath),
      (error: any) => error?.code === "code_map_provider_not_needed",
    );
  } finally {
    repository.close();
  }
});

test("provider requirements stay unknown when preflight inventory is unavailable", async () => {
  const service = new CodeMapService(
    new NeverIndexProvider(),
    undefined,
    providerRegistry(["scip-typescript", "scip-php"]),
    undefined,
    persistence("/workspace/project"),
    new FakeInventory([], new Error("inventory failed")),
  );

  const report = await service.providerCapabilitiesWithPreflight("project-1");
  assert.ok(report);
  for (const provider of report.providers) {
    assert.equal(provider.requirement, "unknown");
    assert.equal(provider.requirementReason, "language_inventory_unavailable");
    assert.deepEqual(provider.matchingLanguages, []);
  }
  assert.deepEqual(report.languages, []);
  assert.equal(report.health, "healthy");
});

test("provider install request fails closed when project requirement is unknown", async () => {
  const service = new CodeMapService(
    new NeverIndexProvider(),
    undefined,
    providerRegistry(),
    undefined,
    persistence("/workspace/project"),
    new FakeInventory([], new Error("inventory failed")),
  );

  await assert.rejects(
    service.requestProviderInstall("project-1", "scip-php"),
    (error: any) => error?.code === "code_map_provider_requirement_unknown",
  );
});


test("agent provider capability tool exposes pre-index languages from canonical Project root", async () => {
  const repository = new SqliteQuestBoardRepository();
  const questBoard = new QuestBoardService(repository);
  const actor: ActorRef = { id: "human:owner", provider: "human" };
  const project = questBoard.createProject({
    name: "Preflight agent tool",
    rootPath: "/workspace/agent-project",
  }, actor);
  const provider = new NeverIndexProvider();
  const inventory = new FakeInventory([{ path: "src/main.ts" }]);
  const codeMapService = new CodeMapService(
    provider,
    undefined,
    providerRegistry(["scip-typescript"]),
    undefined,
    undefined,
    inventory,
  );

  try {
    const result = await executeQuestBoardAgentTool(
      { service: questBoard, codeMapService },
      "questboard_get_code_map_provider_capabilities",
      { projectId: project.id },
    ) as { capabilities: { indexed: boolean; languages: Array<{ language: string; discoveredFileCount: number }> } };

    assert.equal(result.capabilities.indexed, false);
    assert.deepEqual(result.capabilities.languages.map((entry) => ({
      language: entry.language,
      discoveredFileCount: entry.discoveredFileCount,
    })), [{ language: "typescript", discoveredFileCount: 1 }]);
    assert.equal(inventory.calls, 1);
    assert.equal(provider.calls, 0);

    const status = await executeQuestBoardAgentTool(
      { service: questBoard, codeMapService },
      "questboard_get_code_map_status",
      { projectId: project.id },
    ) as { codeMap: any };
    assert.equal(status.codeMap.indexed, false);
    assert.equal(status.codeMap.languageDetection, "ready");
    assert.equal(status.codeMap.providerHealth, "healthy");
    assert.equal(status.codeMap.semanticCoverage, null);
    assert.deepEqual(status.codeMap.detectedLanguages, [
      { language: "typescript", discoveredFileCount: 1 },
    ]);
    assert.deepEqual(status.codeMap.providers, [
      {
        providerId: "scip-typescript",
        available: true,
        health: "ready",
        requirement: "required",
        requirementReason: "detected_supported_language",
        matchingLanguages: ["typescript"],
      },
      {
        providerId: "scip-php",
        available: false,
        health: "missing_executable",
        requirement: "not_needed",
        requirementReason: "supported_language_not_detected",
        matchingLanguages: [],
      },
    ]);
    assert.deepEqual(status.codeMap.recommendedNextAction, {
      tool: "questboard_refresh_code_map",
      args: { projectId: project.id },
      reason: "refresh_required_unindexed",
    });
    assert.equal("providerCapabilities" in status.codeMap, false);
    await assert.rejects(
      async () => executeQuestBoardAgentTool(
        { service: questBoard, codeMapService },
        "questboard_request_code_map_provider_install",
        { projectId: project.id, providerId: "scip-php" },
      ),
      (error: any) => error?.code === "code_map_provider_not_needed",
    );
  } finally {
    repository.close();
  }
});