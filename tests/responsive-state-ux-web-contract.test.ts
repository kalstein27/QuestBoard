import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const html = readFileSync(resolve("web/index.html"), "utf8");
const app = readFileSync(resolve("web/app.js"), "utf8");
const css = readFileSync(resolve("web/styles.css"), "utf8");

test("board state UX includes explicit loading, empty, and retryable error surfaces", () => {
  assert.match(html, /id="board-loading"/);
  assert.match(html, /id="board-empty"/);
  assert.match(html, /id="project-empty"/);
  assert.match(html, /id="board-error"/);
  assert.match(html, /id="board-error-retry"/);
  assert.match(app, /boardError/);
  assert.match(app, /board-error-retry/);
});

test("responsive layout protects iPad and narrow-screen scrolling", () => {
  assert.match(css, /@media \(max-width: 1024px\) and \(min-width: 721px\)/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.kanban-board[\s\S]*overflow-x: auto/);
  assert.match(css, /\.code-map-content[\s\S]*-webkit-overflow-scrolling: touch/);
  assert.match(css, /\.drawer-body[\s\S]*-webkit-overflow-scrolling: touch/);
});

test("Task drawer puts Goal, Now, and Next first with an explicit checkpoint control", () => {
  assert.match(app, /continuitySection\.append\(node\("h3", "section-title continuity-title", "Current"\)\)/);
  assert.match(app, /currentItem\("Goal", task\.goal/);
  assert.match(app, /currentItem\("Now", task\.now/);
  assert.match(app, /currentItem\("Next", task\.next/);
  assert.match(app, /"Save checkpoint"/);
  assert.match(app, /clearGuardrail\?\.checked\) payload\.guardrail = null/);
  assert.match(app, /clearBlocked\?\.checked\) payload\.blocked = null/);
  assert.match(html, /id="task-goal"/);
});

test("Task drawer keeps history and evidence out of default chrome without adding a new dashboard", () => {
  assert.match(app, /document\.createElement\("details"\)/);
  assert.match(app, /"Task details & history"/);
  assert.match(app, /body\.append\(continuitySection, details\)/);
  assert.match(css, /\.checkpoint-field textarea \{ width: 100%; min-width: 0/);
  assert.match(css, /\.drawer-details-content \{ min-width: 0; \}/);
});

test("coarse pointer devices keep Investigation actions discoverable", () => {
  assert.match(css, /@media \(pointer: coarse\)/);
  assert.match(css, /\.investigation-item-actions[\s\S]*opacity: 1/);
  assert.match(css, /\.graph-add-button[\s\S]*opacity: 1/);
});

test("Code Map gives sync the primary hierarchy only after indexing", () => {
  assert.match(app, /action\.classList\.toggle\("primary", !map\.indexed\)/);
  assert.match(app, /syncAction\.classList\.toggle\("primary", Boolean\(map\.indexed && map\.projection\)\)/);
});

test("workspace views support direct visual-E2E deep links without changing stored preference", () => {
  assert.match(app, /new URLSearchParams\(globalThis\.location\?\.search \?\? ""\)\.get\("view"\)/);
  assert.match(app, /\["quest", "investigation", "code-map"\]\.includes\(requested\)/);
});
