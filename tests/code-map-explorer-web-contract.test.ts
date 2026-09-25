import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const html = readFileSync(resolve("web/index.html"), "utf8");
const app = readFileSync(resolve("web/app.js"), "utf8");
const css = readFileSync(resolve("web/styles.css"), "utf8");

test("Code Map explorer uses a selectable detail inspector instead of raw ids in default chrome", () => {
  assert.match(html, /id="code-map-inspector"/);
  assert.match(html, /id="code-map-inspector-title"/);
  assert.match(app, /selectedCodeMapDetail/);
  assert.match(app, /function selectCodeMapDetail\(type, id\)/);
  assert.match(app, /function renderCodeMapInspector\(\)/);
  assert.match(app, /Inspect →/);
  assert.doesNotMatch(app, /View symbols/);
  assert.doesNotMatch(app, /View source evidence/);
});

test("Code Map inspector resolves normalized graph members and relation source evidence", () => {
  assert.match(app, /state\.codeMap\.graph/);
  assert.match(app, /graph\?\.nodes\?\.find/);
  assert.match(app, /graph\?\.relations\?\.find/);
  assert.match(app, /member\.location/);
  assert.match(app, /entry\.evidence/);
  assert.match(app, /codeMapLocationRow/);
});

test("Code Map indexing failure preserves a visible last-good snapshot state", () => {
  assert.match(app, /codeMapIndexError/);
  assert.match(app, /last-good snapshot/);
  assert.match(app, /Showing the last good snapshot/);
  assert.match(css, /\.code-map-banner\.warning/);
});

test("Code Map inspector is a desktop side panel and mobile bottom sheet", () => {
  assert.match(css, /\.code-map-inspector \{/);
  assert.match(css, /width: 330px/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.code-map-inspector \{ top: auto; left: 8px; right: 8px; bottom: 8px/);
});
