import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const html = readFileSync(resolve("web/index.html"), "utf8");
const app = readFileSync(resolve("web/app.js"), "utf8");
const css = readFileSync(resolve("web/styles.css"), "utf8");

test("workspace navigation is owned by the sidebar without a duplicate topbar switch", () => {
  assert.match(html, /id="workspace-nav"/);
  assert.match(html, /data-board-view="quest"/);
  assert.match(html, /data-board-view="investigation"/);
  assert.match(html, /data-board-view="code-map"/);
  assert.doesNotMatch(html, /id="view-switch"/);
  assert.match(app, /el\["workspace-nav"\]\.querySelectorAll\("\[data-board-view\]"\)/);
  assert.doesNotMatch(app, /el\["view-switch"\]/);
});

test("topbar actions are contextual to the active workspace", () => {
  assert.match(html, /id="workspace-context"/);
  assert.match(html, /id="new-task-button"/);
  assert.match(html, /id="investigation-add-node"/);
  assert.match(html, /id="code-map-sync"/);
  assert.match(html, /id="code-map-refresh"/);
  assert.match(app, /new-task-button"\]\.classList\.toggle\("hidden", !quest\)/);
  assert.match(app, /investigation-add-node"\]\.classList\.toggle\("hidden", !investigation\)/);
  assert.match(app, /code-map-refresh"\]\.classList\.toggle\("hidden", !codeMap\)/);
});

test("workspace navigation keeps role copy on desktop and collapses cleanly on mobile", () => {
  assert.match(css, /\.workspace-nav-button\.active/);
  assert.match(css, /\.workspace-nav-description/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.workspace-nav/);
});
