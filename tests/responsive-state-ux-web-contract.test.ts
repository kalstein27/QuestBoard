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
  assert.match(app, /checkpointDetails\.append\(node\("summary", "checkpoint-details-summary", "Checkpoint"\)\)/);
  assert.match(app, /clearGuardrail\?\.checked\) payload\.guardrail = null/);
  assert.match(app, /clearBlocked\?\.checked\) payload\.blocked = null/);
  assert.match(html, /id="task-goal"/);
});

test("Task drawer keeps history and evidence out of default chrome without adding a new dashboard", () => {
  assert.match(app, /document\.createElement\("details"\)/);
  assert.match(app, /"Details & tools"/);
  assert.match(app, /body\.append\(continuitySection, details\)/);
  assert.match(css, /\.checkpoint-field textarea \{ width: 100%; min-width: 0/);
  assert.match(css, /\.drawer-details-content \{ min-width: 0; \}/);
});

test("New Task keeps Goal primary and advanced project-management fields collapsed", () => {
  assert.match(html, /id="task-title"/);
  assert.match(html, /id="task-goal"/);
  assert.match(html, /<details id="task-more" class="task-more">/);
  assert.match(html, /<summary>More options<\/summary>/);
  assert.match(app, /el\["task-more"\]\.open = Boolean\(task\)/);
});

test("workspace chrome uses Quest, Flow, and Code terminology", () => {
  assert.match(html, /data-board-view="investigation"[\s\S]*?<strong>Flow<\/strong>/);
  assert.match(html, /data-board-view="code-map"[\s\S]*?<strong>Code<\/strong>/);
  assert.match(app, /codeMap \? "Code" : investigation \? "Flow" : "Quest"/);
});

test("Quest hides reviewed Done tasks locally while keeping unseen completions visible until reviewed", () => {
  assert.match(html, /id="hide-completed-toggle"[\s\S]*Hide completed/);
  assert.match(app, /questboard\.hideCompleted/);
  assert.match(app, /questboard\.seenDoneTasks\.\$\{projectId\}/);
  assert.match(app, /seenDoneTasksInitialized\.\$\{projectId\}/);
  assert.match(app, /state\.tasks\.filter\(\(task\) => task\.status === "done"\)\.map\(\(task\) => task\.id\)/);
  assert.match(app, /task\.id === state\.selectedTaskId \|\| !state\.seenDoneTaskIds\.has\(task\.id\)/);
  assert.match(app, /selectedTask\?\.status === "done"\) markDoneTaskSeen\(selectedTask\.id\)/);
  assert.match(app, /task-card-unseen-done/);
  assert.match(css, /\.quest-done-filter/);
});

test("coarse pointer Flow keeps Item titles primary and reveals row actions on focus", () => {
  assert.match(css, /@media \(pointer: coarse\)/);
  assert.match(css, /\.investigation-item-title \{[\s\S]*display: block/);
  assert.match(css, /\.investigation-item-actions \{ display: none; pointer-events: auto; \}/);
  assert.match(css, /\.investigation-item:focus-within \.investigation-item-actions \{ display: flex; \}/);
  assert.match(css, /@media \(pointer: coarse\)[\s\S]*\.investigation-item:focus-within \.investigation-item-actions \{ display: flex; opacity: 1; \}/);
  assert.match(app, /wrapper\.tabIndex = 0/);
  assert.match(css, /\.graph-add-button[\s\S]*opacity: 1/);
});

test("Flow default placement uses measured Node heights and preserves saved positions", () => {
  assert.match(app, /function investigationDefaultColumnCount\(\)[\s\S]*clientWidth[\s\S]*return clamp\([\s\S]*1, 4\)/);
  assert.match(app, /function layoutUnsavedInvestigationGraphNodes\(cards\)/);
  assert.match(app, /state\.boardPositions\.has\(key\)\) return/);
  assert.match(app, /card\.offsetHeight \+ gap/);
  assert.match(app, /columnBottoms\[candidate\] < columnBottoms\[column\]/);
  assert.match(app, /layoutUnsavedInvestigationGraphNodes\(graphNodes\)[\s\S]*syncInvestigationCanvasBounds\(\)[\s\S]*drawInvestigationEdges\(\)/);
});

test("Flow canvas bounds follow measured laid-out extents", () => {
  assert.match(app, /function syncInvestigationCanvasBounds\(\)/);
  assert.match(app, /maxX = Math\.max\(maxX, position\.x \+ card\.offsetWidth\)/);
  assert.match(app, /maxY = Math\.max\(maxY, position\.y \+ card\.offsetHeight\)/);
  assert.match(app, /Math\.ceil\(maxY \+ 80\)/);
});

test("Flow edges route orthogonally around Node obstacles with directional arrowheads", () => {
  assert.match(app, /function routeInvestigationEdge\(sourceAnchor, targetAnchor, obstacles, allRects\)/);
  assert.match(app, /function orthogonalRouteClear\(points, obstacles\)/);
  assert.match(app, /investigationEdgeRect\(card, 12\)/);
  assert.match(app, /path\.setAttribute\("d", investigationEdgePath\(points\)\)/);
  assert.match(app, /path\.setAttribute\("marker-end", "url\(#investigation-flow-arrow\)"\)/);
  assert.match(app, /investigationArrowDefs\(\)/);
  assert.match(css, /\.investigation-flow-line \{[^}]*stroke-linejoin: round/);
});

test("Flow grid shares the transformed canvas coordinate system with Nodes and edges", () => {
  assert.match(css, /\.investigation-canvas::before \{/);
  assert.match(css, /\.investigation-canvas::before[\s\S]*background-size: 24px 24px/);
  assert.doesNotMatch(css, /\.investigation-board[\s\S]{0,260}background-image: radial-gradient/);
  assert.doesNotMatch(app, /investigation-board"\]\.style\.backgroundSize/);
  assert.doesNotMatch(app, /investigation-board"\]\.style\.backgroundPosition/);
});

test("Flow viewport performs a device-aware initial fit before reusing persisted pan and zoom", () => {
  assert.match(app, /investigationViewportMeta: loadInvestigationViewportMeta\(\)/);
  assert.match(app, /function shouldAutoFitInvestigationViewport\(\)/);
  assert.match(app, /meta\.projectId !== state\.projectId/);
  assert.match(app, /widthDelta > 0\.2 \|\| heightDelta > 0\.3/);
  assert.match(app, /if \(shouldAutoFitInvestigationViewport\(\)\) fitInvestigationContent\(\)/);
  assert.match(app, /questboard\.investigationViewportMeta/);
});

test("Code Map gives sync the primary hierarchy only after indexing", () => {
  assert.match(app, /action\.classList\.toggle\("primary", !map\.indexed\)/);
  assert.match(app, /syncAction\.classList\.toggle\("primary", Boolean\(map\.indexed && map\.projection\)\)/);
});

test("workspace views support direct visual-E2E deep links without changing stored preference", () => {
  assert.match(app, /new URLSearchParams\(globalThis\.location\?\.search \?\? ""\)\.get\("view"\)/);
  assert.match(app, /\["quest", "investigation", "code-map"\]\.includes\(requested\)/);
});
