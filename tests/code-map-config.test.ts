import assert from "node:assert/strict";
import test from "node:test";
import {
  createConfiguredCodeMapRuntime,
  createConfiguredCodeMapService,
  resolveQuestBoardCodeMapConfig,
  withManagedServiceCodeMapDefault,
} from "../src/server/code-map-config.js";

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
