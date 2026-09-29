import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

const html = readFileSync(resolve("web/index.html"), "utf8");
const app = readFileSync(resolve("web/app.js"), "utf8");
const css = readFileSync(resolve("web/styles.css"), "utf8");

test("Code Map defaults to a technical source explorer instead of the architecture projection", () => {
  assert.match(html, />Source explorer</);
  assert.match(html, /id="code-map-search"/);
  assert.match(html, /id="code-map-kind-filter"/);
  assert.match(html, /id="code-map-language-filter"/);
  assert.match(html, /id="code-map-back"/);
  assert.match(app, /renderCodeMapSourceTree\(map\)/);
  assert.match(app, /graph\.nodes\.filter\(\(item\) => item\.kind === "file"\)/);
  assert.match(app, /codeMapContainsChildren\(graph\)/);
  assert.match(app, /if \(!expanded\) return shell/);
  assert.match(app, /row\.dataset\.codeMapNodeId = item\.id/);
  assert.match(css, /\.code-map-tree-row/);
});

test("Code Map tree expansion is page-bounded even with thousands of direct children", () => {
  const sandbox: any = {
    window: { addEventListener() {} },
    location: { search: "" },
    localStorage: { getItem() { return null; }, setItem() {} },
    URLSearchParams,
  };
  runInNewContext(`${app}\n;globalThis.__firstPage = codeMapTreePage(Array.from({ length: 5000 }, (_, index) => index));\n;globalThis.__secondPage = codeMapTreePage(Array.from({ length: 5000 }, (_, index) => index), 160);`, sandbox);
  assert.equal(sandbox.__firstPage.visible.length, 80);
  assert.equal(sandbox.__firstPage.remaining, 4920);
  assert.equal(sandbox.__secondPage.visible.length, 160);
  assert.equal(sandbox.__secondPage.remaining, 4840);
  assert.match(app, /const CODE_MAP_TREE_PAGE_SIZE = 80/);
  assert.match(app, /entries\.slice\(0, limit\)/);
  assert.match(app, /Load \$\{nextCount\} more · \$\{page\.remaining\} remaining/);
  assert.match(app, /appendCodeMapTreeChildren\(shell, key, codeMapDirectoryEntries\(directory\), depth \+ 1, childrenByNode\)/);
  assert.match(app, /children\.map\(\(value\) => \(\{ type: "node", value \}\)\)/);
});

test("Code Map search uses the same bounded raw query surface for symbol, path, kind, and language", () => {
  assert.match(app, /code-map\/query/);
  assert.match(app, /operation: "find_nodes"/);
  assert.match(app, /codeMapQuery\(\{ \.\.\.base, query \}\)/);
  assert.match(app, /codeMapQuery\(\{ \.\.\.base, path: query \}\)/);
  assert.match(app, /kind \? \{ kinds: \[kind\] \}/);
  assert.match(app, /language \? \{ language \}/);
  assert.match(app, /limit: 50/);
});

test("selected raw nodes load bounded identity, hierarchy, and relation queries into the technical inspector", () => {
  assert.match(html, /id="code-map-inspector"/);
  assert.match(app, /operation: "get_node", nodeId/);
  assert.match(app, /operation: "hierarchy", nodeId, direction: "parents", depth: 4, limit: 20/);
  assert.match(app, /operation: "hierarchy", nodeId, direction: "children", depth: 1, limit: 60/);
  assert.match(app, /operation: "relations", nodeId, direction: "both", limit: 100/);
  assert.match(app, /codeMapBreadcrumb/);
  assert.match(app, /codeMapRelationSections/);
  assert.match(app, /button\.dataset\.codeMapRelationId = relation\.id/);
  assert.match(app, /selectCodeMapDetail\("node", target\.id\)/);
});

test("technical inspector keeps source identity and provider/manual provenance visible", () => {
  assert.match(app, /Defined at/);
  assert.match(app, /Advanced identity & provenance/);
  assert.match(app, /\["Node ID", item\.id\]/);
  assert.match(app, /\["Canonical", item\.canonicalIdentity\]/);
  assert.match(app, /entry\.providerId === "manual"/);
  assert.match(app, /codeMapManualInspectorSection/);
  assert.match(app, /createCodeMapManualRelationFromSelection/);
  assert.match(css, /\.code-map-provenance-badge\.manual/);
  assert.match(css, /\.code-map-manual-inspector-row\.stale/);
});

test("coverage gaps stay first-class and architecture remains only an optional compatibility lens", () => {
  assert.match(app, /codeMapProviderPanel/);
  assert.match(app, /Language coverage/);
  assert.match(app, /codeMapArchitectureLens/);
  assert.match(app, /Architecture lens/);
  assert.match(app, /document\.createElement\("details"\)/);
  assert.match(css, /\.code-map-architecture-lens/);
});

test("Code Map indexing failure preserves a visible last-good raw source snapshot state", () => {
  assert.match(app, /codeMapIndexError/);
  assert.match(app, /last-good snapshot/);
  assert.match(app, /Showing the last good snapshot/);
  assert.match(css, /\.code-map-banner\.warning/);
  assert.match(app, /map\.freshness === "stale"/);
  assert.match(app, /Existing results remain available/);
  assert.match(app, /Refresh \/ Re-index/);
});

test("Code Map inspector remains a desktop side panel and mobile bottom sheet", () => {
  assert.match(css, /\.code-map-inspector \{/);
  assert.match(css, /width: 330px/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.code-map-inspector \{ top: auto; left: 8px; right: 8px; bottom: 8px/);
});

test("Phase 4 exposes durable CodeScope Task context from both Code and Quest surfaces", () => {
  assert.match(app, /Related Tasks/);
  assert.match(app, /createTaskForCodeScope/);
  assert.match(app, /\/code-scope-tasks/);
  assert.match(app, /Code scopes/);
  assert.match(app, /attachTaskCodeScope/);
  assert.match(app, /detachTaskCodeScope/);
  assert.match(app, /No CodeScope attached\. This Task remains valid without one\./);
  assert.match(app, /codeScopeBindings/);
  assert.match(app, /nearestWorkGroup/);
  assert.match(app, /parentByChild/);
  assert.match(app, /Work Group/);
  assert.match(app, /descendantTaskIds\(task\.id\)/);
  assert.match(app, /uniqueScopeCount/);
  assert.match(app, /descendant binding/);
  assert.match(css, /\.code-scope-task-row/);
  assert.match(css, /\.code-scope-task-group/);
  assert.match(css, /\.task-code-scope-row\.stale/);
});

test("Phase 5 Flow Code lens is derived from canonical bindings and stays hard bounded for large groups", () => {
  const sandbox: any = {
    window: { addEventListener() {} },
    location: { search: "" },
    localStorage: { getItem() { return null; }, setItem() {} },
    URLSearchParams,
  };
  runInNewContext(`${app}\n;
    const __bindings = Array.from({ length: 5000 }, (_, index) => ({
      taskId: 'task-' + index,
      codeNodeId: 'node-' + index,
      codeCanonicalIdentity: 'symbol:' + index,
      state: 'active',
      kind: 'targets',
      codeNode: { id: 'node-' + index, name: 'symbol' + index, kind: 'function' },
    }));
    state.codeMap = { codeScopeBindings: __bindings };
    globalThis.__flowLens = flowCodeScopeLensForTaskIds(new Set(__bindings.map((binding) => binding.taskId)), 40);
  `, sandbox);
  assert.equal(sandbox.__flowLens.total, 5000);
  assert.equal(sandbox.__flowLens.entries.length, 40);
  assert.equal(sandbox.__flowLens.truncated, true);
  assert.match(app, /const FLOW_CODE_LENS_SCOPE_LIMIT = 40/);
  assert.match(app, /const FLOW_CODE_LENS_INLINE_LIMIT = 6/);
  assert.match(app, /flowWorkGroupTaskIds/);
  assert.match(app, /flowCodeScopeLensForTaskIds/);
  assert.match(app, /flowWorkGroupCodeLens/);
  assert.doesNotMatch(app, /flowCodeGraphCopy|investigationCodeGraph/);
});

test("Phase 5 provides bounded Group↔Flow↔Code navigation without merging the three topologies", () => {
  assert.match(html, /id="investigation-code-lens"[^>]*>Show code</);
  assert.match(app, /relatedFlowContextForCodeScope/);
  assert.match(app, /codeMapRelatedFlowSection/);
  assert.match(app, /Show in Flow/);
  assert.match(app, /jumpToCodeScope/);
  assert.match(app, /Open Code/);
  assert.match(app, /flowCodeFocus/);
  assert.match(app, /code-focus-related/);
  assert.match(css, /\.flow-code-lens/);
  assert.match(css, /\.flow-code-scope-list[^}]*overflow-x: auto/);
  assert.match(css, /@media \(max-width: 1024px\) and \(min-width: 721px\)[\s\S]*\.flow-code-lens \{ max-height: 82px/);
});

test("Phase 6 exposes conservative relink and ephemeral Agent Follow controls", () => {
  assert.match(html, /id="agent-focus-control"/);
  assert.match(html, />Follow</);
  assert.match(html, />Free</);
  assert.match(html, />Return to agent</);
  assert.match(app, /refreshAgentFocus/);
  assert.match(app, /agentFocusMode/);
  assert.match(app, /applyLatestAgentFocus/);
  assert.match(app, /1500/);
  assert.match(app, /relinkTaskCodeScope/);
  assert.match(app, /binding\.state !== "relinkable"/);
  assert.match(css, /\.code-scope-state\.relinkable/);
  assert.match(css, /\.agent-focus-control/);
  assert.match(css, /@media \(max-width: 1024px\)[^\n]*\.agent-focus-status/);
});