import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const app = readFileSync(resolve("web/app.js"), "utf8");
const css = readFileSync(resolve("web/styles.css"), "utf8");

test("Code Map Web distinguishes persistent manual wiring and stale state from provider-derived graph chrome", () => {
  assert.match(app, /codeMapManualRelationsPanel/);
  assert.match(app, /Manual wiring/);
  assert.match(app, /"Manual"/);
  assert.match(app, /"Stale"/);
  assert.match(app, /relation\.rationale/);
  assert.match(app, /relation\.staleReason/);
  assert.match(css, /\.code-map-manual-panel/);
  assert.match(css, /\.code-map-manual-badge\.stale/);
});
