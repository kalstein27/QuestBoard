import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const html = readFileSync(resolve("web/index.html"), "utf8");
const app = readFileSync(resolve("web/app.js"), "utf8");
const css = readFileSync(resolve("web/styles.css"), "utf8");

test("Code Map Web exposes preview-first Extract / Sync UX", () => {
  assert.match(html, /id="code-map-sync"[^>]*>Extract \/ Sync</);
  assert.match(html, /id="code-map-sync-dialog"/);
  assert.match(html, /id="code-map-sync-recreate-detached"/);
  assert.match(html, /id="code-map-sync-open-investigation"[^>]*>Open Investigation</);

  assert.match(app, /syncAction\.classList\.toggle\("hidden", state\.viewMode !== "code-map" \|\| !map\.indexed \|\| !map\.projection\)/);
  assert.match(app, /openCodeMapSyncPreview/);
  assert.match(app, /Building sync preview/);
  assert.match(app, /New nodes/);
  assert.match(app, /New relations/);
  assert.match(app, /Evidence changed/);
  assert.match(app, /Detached \/ blocked/);
  assert.match(app, /stale binding/);
  assert.match(app, /detached target/);
});

test("Code Map Web apply uses preview fingerprint and explicit detached confirmation", () => {
  assert.match(app, /expectedProjectionFingerprint: preview\.projectionFingerprint/);
  assert.match(app, /recreateDetached/);
  assert.match(app, /detached > 0 && !el\["code-map-sync-recreate-detached"\]\.checked/);
  assert.match(app, /Code Map synced to Investigation/);
});

test("Code Map Web surfaces binding badges and Investigation focus without raw provenance chrome", () => {
  assert.match(app, /codeMapBindingBadges/);
  assert.match(app, /"Code Map"/);
  assert.match(app, /"Stale"/);
  assert.match(app, /focusCodeMapSyncNodes/);
  assert.match(css, /\.code-map-binding-badge/);
  assert.match(css, /\.investigation-graph-node\.code-map-sync-focus/);

  assert.doesNotMatch(html, /sourceRelationIds|memberNodeIds|codeRelationId/);
});
