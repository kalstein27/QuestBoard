import assert from "node:assert/strict";
import test from "node:test";
import { resolveIsolatedCodeMapHeapMiB } from "../src/server/code-map-isolated-heap.js";

test("isolated workers keep the default and support shared and independent heap limits", () => {
  for (const kind of ["refresh", "read"] as const) {
    assert.equal(resolveIsolatedCodeMapHeapMiB({}, kind), 512);
    assert.equal(resolveIsolatedCodeMapHeapMiB({ QUESTBOARD_CODE_MAP_ISOLATED_HEAP_MIB: "1536" }, kind), 1536);
  }
  const env = {
    QUESTBOARD_CODE_MAP_ISOLATED_HEAP_MIB: "768",
    QUESTBOARD_CODE_MAP_ISOLATED_REFRESH_HEAP_MIB: "2048",
    QUESTBOARD_CODE_MAP_ISOLATED_READ_HEAP_MIB: "1024",
  };
  assert.equal(resolveIsolatedCodeMapHeapMiB(env, "refresh"), 2048);
  assert.equal(resolveIsolatedCodeMapHeapMiB(env, "read"), 1024);
  assert.equal(resolveIsolatedCodeMapHeapMiB(env, "refresh", 4096), 4096);
  assert.equal(resolveIsolatedCodeMapHeapMiB(env, "read", 64), 64);
  assert.equal(resolveIsolatedCodeMapHeapMiB({ QUESTBOARD_CODE_MAP_ISOLATED_REFRESH_HEAP_MIB: "2048" }, "read"), 512);
  assert.equal(resolveIsolatedCodeMapHeapMiB({ QUESTBOARD_CODE_MAP_ISOLATED_READ_HEAP_MIB: "1024" }, "refresh"), 512);
});

test("invalid worker limits fail explicitly instead of silently using 512 MiB", () => {
  for (const value of ["63", "4097", "512.5", "1e3", "0x400", "invalid"]) {
    assert.throws(() => resolveIsolatedCodeMapHeapMiB({ QUESTBOARD_CODE_MAP_ISOLATED_REFRESH_HEAP_MIB: value }, "refresh"), /REFRESH_HEAP_MIB/);
    assert.throws(() => resolveIsolatedCodeMapHeapMiB({ QUESTBOARD_CODE_MAP_ISOLATED_READ_HEAP_MIB: value }, "read"), /READ_HEAP_MIB/);
    assert.throws(() => resolveIsolatedCodeMapHeapMiB({ QUESTBOARD_CODE_MAP_ISOLATED_HEAP_MIB: value }, "read"), /ISOLATED_HEAP_MIB/);
  }
  assert.throws(() => resolveIsolatedCodeMapHeapMiB({}, "refresh", 0), /maxOldSpaceMiB/);
});