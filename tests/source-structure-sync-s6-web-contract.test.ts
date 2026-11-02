import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const html = readFileSync(resolve("web/index.html"), "utf8");
const js = readFileSync(resolve("web/app.js"), "utf8");
const css = readFileSync(resolve("web/styles.css"), "utf8");

test("S6 Source Structure selection and preview have an independent Code dialog", () => {
  assert.match(html, /id="source-structure-open"[^>]*>Source → Flow/);
  assert.match(html, /id="source-structure-dialog"/);
  assert.match(html, /id="source-structure-path"/);
  assert.match(html, /id="source-structure-candidates"/);
  assert.match(html, /id="source-structure-preview"/);
  assert.match(html, /id="source-structure-next"/);
  assert.match(html, /id="source-structure-prev"/);
  assert.match(html, /id="code-map-sync-dialog"/);
  assert.match(js, /sourceAction\.classList\.toggle\("hidden", state\.viewMode !== "code-map" \|\| !map\.indexed\)/);
  assert.match(css, /\.source-structure-choice:focus-within/);
});
test("S6 refuses to activate the unauthenticated Apply path", () => {
  assert.match(html, /id="source-structure-apply"[^>]*disabled aria-disabled="true"/);
  assert.match(html, /Applying changes requires server-verified project permission/);
  assert.match(js, /lockedApply\.disabled = true/);
  assert.match(js, /No Apply event handler by design/);
  assert.doesNotMatch(js, /sourceStructureEndpoint\("apply"\)/);
  assert.match(js, /sourceStructureEndpoint\("preview"\)/);
  assert.match(js, /sourceStructureEndpoint\("candidates"\)/);
});
test("S6 pins pages and invalidates stale selection/preview on lifecycle transitions", () => {
  assert.match(js, /function resetSourceStructure\(/);
  assert.match(js, /resetCodeMapExplorerState\(\);\s*resetSourceStructure\(\);/);
  assert.match(js, /async function loadCodeMap\(\) \{[\s\S]*?resetSourceStructure\(\);/);
  assert.match(js, /async function refreshCodeMap\(\) \{[\s\S]*?resetSourceStructure\(\);/);
  assert.match(js, /const sequence = \+\+current\.requestVersion/);
  assert.match(js, /sequence !== current\.requestVersion/);
  assert.match(js, /expectedSnapshotId: page\.snapshotId/);
  assert.match(js, /expectedSourceIndexedAt: page\.sourceIndexedAt/);
  assert.match(js, /search\.set\("expectedSnapshotId", priorPage\.snapshotId\)/);
  assert.match(js, /current\.selected = new Set\(\)/);
  assert.match(js, /current\.preview = null/);
});
test("S6 preview makes evidence gaps and protected states visible, never fabricating relations", () => {
  for (const status of ["Create", "Unchanged", "Evidence changed", "Stale", "Detached", "Blocked"]) {
    assert.ok(js.includes(status), status);
  }
  assert.match(js, /omittedEligibleRelationCount/);
  assert.match(js, /noSelectedRelationsReason/);
  assert.match(js, /evidenceTruncated/);
  assert.match(js, /Evidence IDs:/);
  assert.match(js, /No evidence-backed relations within the selection/);
  assert.match(js, /Only this page is eligible/);
  assert.match(css, /\.source-structure-lock/);
});
