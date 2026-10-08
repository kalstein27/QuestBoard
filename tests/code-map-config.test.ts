import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createConfiguredCodeMapRuntime,
  createConfiguredCodeMapService,
  resolveQuestBoardCodeMapConfig,
  withManagedServiceCodeMapDefault,
} from "../src/server/code-map-config.js";
import { semanticFactsProvider } from "../src/server/code-map-config.js";
import { CODE_GRAPH_SCHEMA_VERSION, type CodeGraphSnapshot } from "../src/application/code-intelligence.js";

test("managed service enables Code Map by default without changing ordinary runtime defaults", () => {
  const ordinaryEnv = withManagedServiceCodeMapDefault({}, false);
  assert.equal(resolveQuestBoardCodeMapConfig(ordinaryEnv), null);

  const managedEnv = withManagedServiceCodeMapDefault({}, true);
  assert.equal(managedEnv.QUESTBOARD_CODE_MAP, "1");
  assert.equal(resolveQuestBoardCodeMapConfig(managedEnv)?.provider, "scip-typescript");
  assert.deepEqual(resolveQuestBoardCodeMapConfig(managedEnv)?.providers, ["scip-typescript", "scip-php"]);
});

test("managed service preserves an explicit Code Map disable override", () => {
  const env = withManagedServiceCodeMapDefault({ QUESTBOARD_CODE_MAP: "0" }, true);
  assert.equal(env.QUESTBOARD_CODE_MAP, "0");
  assert.equal(resolveQuestBoardCodeMapConfig(env), null);
});

test("Code Map config uses SCIP TypeScript as the default provider", () => {
  const config = resolveQuestBoardCodeMapConfig({
    QUESTBOARD_CODE_MAP: "1",
    QUESTBOARD_CODE_MAP_STORAGE_ROOT: "/tmp/qb-code-map",
  });

  assert.equal(config?.provider, "scip-typescript");
  assert.deepEqual(config?.providers, ["scip-typescript", "scip-php"]);
  assert.match(config?.executable ?? "", /node_modules[/\\]\.bin[/\\]scip-typescript(?:\.cmd)?$/);
  assert.equal(config?.storageRoot, "/tmp/qb-code-map");
});

test("Code Map config composes an ordered zero-or-more semantic provider set", () => {
  const env = {
    QUESTBOARD_CODE_MAP: "1",
    QUESTBOARD_CODE_MAP_PROVIDERS: "scip-typescript,scip-php",
    QUESTBOARD_CODE_MAP_STORAGE_ROOT: "/tmp/qb-composite",
    QUESTBOARD_SCIP_TYPESCRIPT_EXECUTABLE: "/opt/tools/scip-typescript",
    QUESTBOARD_SCIP_PHP_EXECUTABLE: "/opt/tools/scip-php",
  };
  const config = resolveQuestBoardCodeMapConfig(env);

  assert.deepEqual(config, {
    provider: "scip-typescript",
    executable: "/opt/tools/scip-typescript",
    providers: ["scip-typescript", "scip-php"],
    storageRoot: "/tmp/qb-composite",
  });
  const service = createConfiguredCodeMapService(env);
  assert.equal(service?.providerId, "composite");
});

test("multi-provider semantic wrapper preserves compiler-scope coverage from the child service", async () => {
  const indexedAt = "2026-10-07T00:00:00.000Z";
  const nativeArtifactSha256 = "a".repeat(64);
  const providerRun = {
    providerId: "scip-typescript",
    nativeArtifactSha256,
    indexedAt,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(["scip-typescript", nativeArtifactSha256, indexedAt]))
      .digest("hex"),
    nativeReferences: [{ canonicalIdentity: "src/service.ts#Service", referenceOccurrenceCount: 2 }],
  };
  const graph: CodeGraphSnapshot = {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId: "project",
    rootPath: "/workspace/project",
    indexedAt,
    nodes: [
      {
        id: "ts-symbol",
        kind: "class",
        name: "Service",
        canonicalIdentity: "src/service.ts#Service",
        language: "typescript",
        location: { path: "src/service.ts", startLine: 1 },
        provenance: [{ providerId: "scip-typescript", fidelity: "semantic-call" }],
      },
      {
        id: "file:test",
        kind: "file",
        name: "service.test.ts",
        canonicalIdentity: "file:src/service.test.ts",
        language: "typescript",
        location: { path: "src/service.test.ts" },
        provenance: [{ providerId: "questboard:file-inventory", fidelity: "file-only" }],
      },
    ],
    relations: [],
    providerRuns: [providerRun, { ...providerRun, providerId: "scip-php" }],
    coverage: {
      degraded: false,
      providers: [{
        providerId: "scip-typescript",
        status: "fresh",
        fidelity: "semantic-call",
        languages: ["typescript"],
        nodeCount: 1,
        relationCount: 0,
      }],
      languages: [{
        language: "typescript",
        fileCount: 2,
        semanticEligibleFileCount: 1,
        semanticIndexedFileCount: 1,
        semanticExcludedFileCount: 1,
        semanticExclusionReason: "provider_project_scope",
        fidelity: "semantic-call",
        providerIds: ["scip-typescript", "questboard:file-inventory"],
        degraded: false,
      }],
    },
  };
  const service = {
    capabilities: { incrementalIndexing: false, impactAnalysis: false, callTrace: false },
    async refresh() {
      return { graph };
    },
  } as unknown as Parameters<typeof semanticFactsProvider>[0];

  const provider = semanticFactsProvider(service, "scip-typescript");
  const contribution = await provider.indexProject({
    projectId: "project",
    rootPath: "/workspace/project",
  });

  assert.deepEqual(contribution.coverage, graph.coverage);
  assert.deepEqual(contribution.nodes.map((node) => node.id), ["ts-symbol"]);
  assert.deepEqual(contribution.providerRuns, [providerRun], "native run SHA, fingerprint and reference counts must survive the provider wrapper");
});

test("Code Map runtime keeps healthy semantic providers when another configured provider is missing", () => {
  const runtime = createConfiguredCodeMapRuntime({
    QUESTBOARD_CODE_MAP: "1",
    QUESTBOARD_CODE_MAP_PROVIDERS: "scip-typescript,scip-php",
    QUESTBOARD_CODE_MAP_STORAGE_ROOT: "/tmp/qb-composite-partial",
    QUESTBOARD_SCIP_TYPESCRIPT_EXECUTABLE: process.execPath,
    QUESTBOARD_SCIP_PHP_EXECUTABLE: "/definitely/missing/scip-php",
  });

  assert.ok(runtime.service);
  assert.equal(runtime.service.providerId, "scip-typescript");
  assert.equal(runtime.availability.available, true);
  assert.equal(runtime.availability.reason, "missing_executable");
  assert.deepEqual(runtime.availability.missingExecutables, ["scip-php"]);
  assert.doesNotMatch(runtime.availability.message ?? "", /\/definitely\/missing/);
});


test("Code Map runtime degrades to file-only when the configured semantic indexer is missing", () => {
  const runtime = createConfiguredCodeMapRuntime({
    QUESTBOARD_CODE_MAP: "1",
    QUESTBOARD_CODE_MAP_PROVIDER: "scip-typescript",
    QUESTBOARD_CODE_MAP_STORAGE_ROOT: "/tmp/qb-code-map-missing",
    QUESTBOARD_SCIP_TYPESCRIPT_EXECUTABLE: "/definitely/missing/scip-typescript",
  });

  assert.ok(runtime.service);
  assert.equal(runtime.service.providerId, "file-inventory");
  assert.equal(runtime.availability.enabled, true);
  assert.equal(runtime.availability.available, true);
  assert.equal(runtime.availability.provider, "scip-typescript");
  assert.equal(runtime.availability.reason, "missing_executable");
  assert.match(runtime.availability.message ?? "", /file-only fidelity/);
  assert.deepEqual(runtime.availability.missingExecutables, ["scip-typescript"]);
  assert.doesNotMatch(runtime.availability.message ?? "", /\/definitely\/missing/);
});

test("SCIP PHP is an explicit project-local semantic provider", () => {
  const config = resolveQuestBoardCodeMapConfig({
    QUESTBOARD_CODE_MAP: "1",
    QUESTBOARD_CODE_MAP_PROVIDER: "scip-php",
    QUESTBOARD_CODE_MAP_STORAGE_ROOT: "/tmp/qb-scip-php",
  });
  assert.equal(config?.provider, "scip-php");
  assert.equal(config?.executable, "vendor/bin/scip-php");
  const service = createConfiguredCodeMapService({
    QUESTBOARD_CODE_MAP: "1",
    QUESTBOARD_CODE_MAP_PROVIDER: "scip-php",
    QUESTBOARD_CODE_MAP_STORAGE_ROOT: "/tmp/qb-scip-php",
  });
  assert.equal(service?.providerId, "scip-php");
});

test("Code Map config supports an explicit SCIP TypeScript indexer override", () => {
  const config = resolveQuestBoardCodeMapConfig({
    QUESTBOARD_CODE_MAP: "true",
    QUESTBOARD_CODE_MAP_PROVIDER: "scip-typescript",
    QUESTBOARD_CODE_MAP_STORAGE_ROOT: "/tmp/qb-scip",
    QUESTBOARD_SCIP_TYPESCRIPT_EXECUTABLE: "/opt/tools/scip-typescript",
  });

  assert.deepEqual(config, {
    provider: "scip-typescript",
    executable: "/opt/tools/scip-typescript",
    storageRoot: "/tmp/qb-scip",
  });
  const service = createConfiguredCodeMapService({
    QUESTBOARD_CODE_MAP: "1",
    QUESTBOARD_CODE_MAP_PROVIDER: "scip-typescript",
    QUESTBOARD_CODE_MAP_STORAGE_ROOT: "/tmp/qb-scip-config-test",
  });
  assert.equal(service?.providerId, "scip-typescript");
  assert.deepEqual(service?.capabilities, {
    incrementalIndexing: false,
    impactAnalysis: false,
    callTrace: false,
  });
});

test("Code Map config rejects unknown providers instead of silently falling back", () => {
  assert.throws(
    () => resolveQuestBoardCodeMapConfig({
      QUESTBOARD_CODE_MAP: "1",
      QUESTBOARD_CODE_MAP_PROVIDER: "mystery-provider",
    }),
    /Unsupported Code Map provider/,
  );
});
