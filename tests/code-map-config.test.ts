import assert from "node:assert/strict";
import test from "node:test";
import {
  createConfiguredCodeMapRuntime,
  createConfiguredCodeMapService,
  resolveQuestBoardCodeMapConfig,
} from "../src/server/code-map-config.js";

test("Code Map config uses SCIP TypeScript as the default provider", () => {
  const config = resolveQuestBoardCodeMapConfig({
    QUESTBOARD_CODE_MAP: "1",
    QUESTBOARD_CODE_MAP_STORAGE_ROOT: "/tmp/qb-code-map",
  });

  assert.deepEqual(config, {
    provider: "scip-typescript",
    executable: "scip-typescript",
    scipExecutable: "scip",
    storageRoot: "/tmp/qb-code-map",
  });
});

test("Code Map runtime fails closed when default SCIP executables are missing", () => {
  const runtime = createConfiguredCodeMapRuntime({
    QUESTBOARD_CODE_MAP: "1",
    QUESTBOARD_CODE_MAP_STORAGE_ROOT: "/tmp/qb-code-map-missing",
    PATH: "",
  });

  assert.equal(runtime.service, undefined);
  assert.equal(runtime.availability.enabled, true);
  assert.equal(runtime.availability.available, false);
  assert.equal(runtime.availability.provider, "scip-typescript");
  assert.equal(runtime.availability.reason, "missing_executable");
  assert.deepEqual(runtime.availability.missingExecutables, ["scip-typescript", "scip"]);
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

test("Code Map config selects SCIP TypeScript without adding a runtime package dependency", () => {
  const config = resolveQuestBoardCodeMapConfig({
    QUESTBOARD_CODE_MAP: "true",
    QUESTBOARD_CODE_MAP_PROVIDER: "scip-typescript",
    QUESTBOARD_CODE_MAP_STORAGE_ROOT: "/tmp/qb-scip",
    QUESTBOARD_SCIP_TYPESCRIPT_EXECUTABLE: "/opt/tools/scip-typescript",
    QUESTBOARD_SCIP_EXECUTABLE: "/opt/tools/scip",
  });

  assert.deepEqual(config, {
    provider: "scip-typescript",
    executable: "/opt/tools/scip-typescript",
    scipExecutable: "/opt/tools/scip",
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
