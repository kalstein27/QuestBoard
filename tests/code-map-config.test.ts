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
  assert.match(config?.executable ?? "", /node_modules[/\\]\.bin[/\\]scip-typescript(?:\.cmd)?$/);
  assert.equal(config?.storageRoot, "/tmp/qb-code-map");
});

test("Code Map runtime fails closed when the bundled SCIP TypeScript indexer is missing", () => {
  const runtime = createConfiguredCodeMapRuntime({
    QUESTBOARD_CODE_MAP: "1",
    QUESTBOARD_CODE_MAP_STORAGE_ROOT: "/tmp/qb-code-map-missing",
    QUESTBOARD_SCIP_TYPESCRIPT_EXECUTABLE: "/definitely/missing/scip-typescript",
  });

  assert.equal(runtime.service, undefined);
  assert.equal(runtime.availability.enabled, true);
  assert.equal(runtime.availability.available, false);
  assert.equal(runtime.availability.provider, "scip-typescript");
  assert.equal(runtime.availability.reason, "missing_executable");
  assert.deepEqual(runtime.availability.missingExecutables, ["/definitely/missing/scip-typescript"]);
});

test("GitNexus remains an explicit optional provider", () => {
  const config = resolveQuestBoardCodeMapConfig({
    QUESTBOARD_CODE_MAP: "1",
    QUESTBOARD_CODE_MAP_PROVIDER: "gitnexus",
    QUESTBOARD_CODE_MAP_STORAGE_ROOT: "/tmp/qb-gitnexus",
  });
  assert.equal(config?.provider, "gitnexus");
  assert.equal(config?.executable, "gitnexus");
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
