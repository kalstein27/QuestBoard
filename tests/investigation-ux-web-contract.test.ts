import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const html = readFileSync(resolve("web/index.html"), "utf8");
const app = readFileSync(resolve("web/app.js"), "utf8");
const css = readFileSync(resolve("web/styles.css"), "utf8");

test("Investigation exposes node selection, inspector, and fit-to-content controls", () => {
  assert.match(html, /id="investigation-fit"[^>]*>Fit</);
  assert.match(html, /id="investigation-inspector"/);
  assert.match(html, /id="investigation-inspector-title"/);
  assert.match(html, /id="investigation-inspector-body"/);
  assert.match(app, /selectedInvestigationNodeId/);
  assert.match(app, /function selectInvestigationNode\(nodeId\)/);
  assert.match(app, /function renderInvestigationInspector\(\)/);
  assert.match(app, /function focusInvestigationNode\(nodeId\)/);
  assert.match(app, /function fitInvestigationContent\(\)/);
  assert.match(app, /contentWidth/);
  assert.match(app, /contentHeight/);
});

test("Investigation inspector preserves node data ownership and only changes viewport on focus or fit", () => {
  assert.match(app, /editInvestigationNodeFromPrompt\(graphNode\)/);
  assert.match(app, /persistInvestigationViewport\(\)/);
  assert.match(app, /applyInvestigationViewport\(\)/);
  assert.doesNotMatch(app, /fitInvestigationContent[\s\S]{0,1600}persistInvestigationPosition/);
  assert.match(app, /state\.investigationItemTaskLinks\.filter/);
  assert.match(app, /state\.investigationItemLinks\.filter/);
});

test("Investigation inspector stays lightweight on desktop and becomes a bottom sheet on mobile", () => {
  assert.match(css, /\.investigation-graph-node\.selected/);
  assert.match(css, /\.investigation-inspector \{/);
  assert.match(css, /width: 292px/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.investigation-inspector \{[\s\S]*top: auto; left: 8px; right: 8px; bottom: 8px/);
  assert.match(css, /\.investigation-item-title \{[^}]*font-size: 11px/);
  assert.match(css, /\.investigation-item-description \{[^}]*font-size: 10px/);
});
