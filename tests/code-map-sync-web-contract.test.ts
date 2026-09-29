import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const html = readFileSync(resolve("web/index.html"), "utf8");
const app = readFileSync(resolve("web/app.js"), "utf8");
const css = readFileSync(resolve("web/styles.css"), "utf8");

test("Code Map Web exposes preview-first Flow sync UX", () => {
  assert.match(html, /id="code-map-sync"[^>]*>Sync to Flow</);
  assert.match(html, /id="code-map-sync-dialog"/);
  assert.match(html, /id="code-map-sync-recreate-detached"/);
  assert.match(html, /id="code-map-sync-open-investigation"[^>]*>Open Flow</);

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
  assert.match(app, /Code synced to Flow/);
});

test("Code Map Web surfaces binding badges and Flow focus without raw provenance chrome", () => {
  assert.match(app, /codeMapBindingBadges/);
  assert.match(app, /"Code"/);
  assert.match(app, /"Stale"/);
  assert.match(app, /focusCodeMapSyncNodes/);
  assert.match(css, /\.code-map-binding-badge/);
  assert.match(css, /\.investigation-graph-node\.code-map-sync-focus/);

  assert.doesNotMatch(html, /sourceRelationIds|memberNodeIds|codeRelationId/);
});

test("Code Map Web surfaces provider coverage gaps and only prepares approval-gated install requests", () => {
  assert.match(app, /codeMapProviderPanel/);
  assert.match(app, /Install provider…/);
  assert.match(app, /code-map\/providers\/\$\{encodeURIComponent\(providerId\)\}\/install-request/);
  assert.match(app, /Installation has not run/);
  assert.match(app, /requires explicit approval in the trusted external host/);
  assert.match(css, /\.code-map-provider-panel/);
  assert.match(css, /\.code-map-provider-gap/);
});
