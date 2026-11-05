// Dependency-free real Chrome CDP UI smoke for the S7 P2 Code Map surfaces.
// Runs only on a disposable SQLite database and synthetic source snapshot.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { createConfiguredCodeMapRuntime } from "../dist/src/server/code-map-config.js";
import { createIsolatedCodeMapReadExecutor } from "../dist/src/server/code-map-isolated-read.js";
import { createQuestBoardHttpServer } from "../dist/src/server/http-api.js";
import { SqliteQuestBoardRepository } from "../dist/src/storage/sqlite/sqlite-quest-board-repository.js";
import { QuestBoardService } from "../dist/src/application/quest-board-service.js";
import { SourceStructureFlowSyncService } from "../dist/src/application/source-structure-flow-sync.js";
import { CodeMapInvestigationSyncService } from "../dist/src/application/code-map-investigation-sync.js";
import { CodeScopeBindingService } from "../dist/src/application/code-scope-binding.js";
import { computeCodeMapSnapshotIdentity } from "../dist/src/application/code-map-snapshot-identity.js";
import { CODE_GRAPH_SCHEMA_VERSION } from "../dist/src/application/code-intelligence.js";

const actor = { id: "human:chrome-fixture", provider: "test" };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = text => createHash("sha256").update(text).digest("hex");
const chromeBinary = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
class CDP {
  constructor(socket) {
    this.socket = socket;
    this.next = 0;
    this.pending = new Map();
    socket.addEventListener("message", event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message.id) return;
      const callback = this.pending.get(message.id);
      if (!callback) return;
      this.pending.delete(message.id);
      if (message.error) callback.reject(new Error(JSON.stringify(message.error)));
      else callback.resolve(message.result);
    });
  }
  async call(method, params = {}) {
    const id = ++this.next;
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(code) {
    const result = await this.call("Runtime.evaluate", {
      expression: code, returnByValue: true, awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(
      `Chrome evaluate: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result?.value;
  }
  async wait(expression, label, timeout = 15_000) {
    const since = performance.now();
    let last;
    while (performance.now() - since < timeout) {
      // Chrome may navigate before the external app.js lexical globals exist.
      // Treat only that initial page-loading race as pending, not an E2E pass.
      try { last = await this.eval(expression); }
      catch (error) {
        if (!/state is not defined|Cannot read properties of undefined/.test(error.message))
          throw error;
        last = false;
      }
      if (last) return last;
      await sleep(75);
    }
    throw new Error(`Chrome UI step ${label} did not complete; last=${JSON.stringify(last)}`);
  }
}
function graph(projectId, rootPath) {
  const method = (id, path, kind = "method") => ({
    id: "code:node:" + id, kind, name: id,
    canonicalIdentity: `php:synthetic:${path}#${id}`,
    language: "php", location: { path, startLine: 1 },
  });
  const paths = [
    "src/Application/Handler.php", "src/Service/Loader.php", "src/Storage/Writer.php",
    "src/server/http-api.ts", "src/application/quest-board-service.ts",
  ];
  const files = paths.map((path, i) => ({
    id: `code:node:file:${i}`, kind: "file", name: path.split("/").at(-1),
    canonicalIdentity: `file:${path}`, language: path.endsWith(".php") ? "php" : "typescript",
    location: { path },
  }));
  const methods = [
    method("handle", paths[0]), method("load", paths[1]), method("save", paths[2]),
    method("handleRequest", paths[3], "function"),
    method("createTask", paths[4]),
  ];
  const contains = methods.map((node, i) => ({
    id: `code:relation:contains:${i}`, kind: "contains",
    from: files[i].id, to: node.id, confidence: 1,
  }));
  const calls = [
    { id: "code:relation:call-1", from: methods[0].id, to: methods[1].id, kind: "calls", confidence: .99 },
    { id: "code:relation:call-2", from: methods[1].id, to: methods[2].id, kind: "calls", confidence: .96 },
    { id: "code:relation:call-3", from: methods[3].id, to: methods[4].id, kind: "calls", confidence: 1 },
  ];
  return { schemaVersion: CODE_GRAPH_SCHEMA_VERSION, projectId, rootPath,
    indexedAt: "2026-11-01T00:00:00.000Z",
    nodes: [...files, ...methods], relations: [...contains, ...calls] };
}
const directory = mkdtempSync(join(tmpdir(),"questboard-s7-chrome-"));
const sourceRoot = join(directory, "source");
const storage = join(directory, "snapshots");
const profile = join(directory, "chrome-profile");
mkdirSync(join(sourceRoot,"src"),{recursive:true});
writeFileSync(join(sourceRoot,"composer.json"), '{"name":"test/s7-browser"}\n');
writeFileSync(join(sourceRoot,"src","Seed.php"), "<?php class Seed {}\n");
const rootPath = realpathSync.native(sourceRoot);
const repository = new SqliteQuestBoardRepository(join(directory, "isolated.sqlite"));
const tasks = new QuestBoardService(repository);
const project = tasks.createProject({ name: "S7 Chrome isolated fixture", rootPath }, actor);
const env = { HOME: process.env.HOME, PATH: process.env.PATH,
  QUESTBOARD_CODE_MAP:"1", QUESTBOARD_CODE_MAP_PROVIDERS:"scip-php",
  QUESTBOARD_CODE_MAP_STORAGE_ROOT:storage };
let server, chrome, ws, browserErrors = [];
try {
  const seed = createConfiguredCodeMapRuntime(env,repository).service;
  assert.ok(seed);
  await seed.refresh({ projectId:project.id, rootPath });
  const snapshotPath = join(storage,"snapshots",hash(project.id),"snapshot.json");
  const prior = JSON.parse(readFileSync(snapshotPath,"utf8"));
  const raw = graph(project.id,rootPath);
  const identity = computeCodeMapSnapshotIdentity({
    projectId:project.id, rootIdentity:prior.rootIdentity,
    providerConfigFingerprint:prior.providerConfigFingerprint,
    sourceManifestFingerprint:prior.sourceManifestFingerprint, graph:raw,
  });
  const tempPath = join(dirname(snapshotPath),"s7-chrome-"+randomUUID()+".tmp");
  writeFileSync(tempPath,JSON.stringify({ ...prior, ...identity, graph:raw, persistedAt:new Date().toISOString() }));
  renameSync(tempPath,snapshotPath);
  const codeMap = createConfiguredCodeMapRuntime(env,repository).service;
  assert.ok(codeMap);
  codeMap.setIsolatedReadExecutor(createIsolatedCodeMapReadExecutor(env));
  codeMap.getCached=()=>{throw new Error("S7 browser daemon must never hydrate the raw graph")};
  const sourceSync = new SourceStructureFlowSyncService(repository, {
    read:()=>{throw new Error("S7 browser parent source must not load raw graph")},
  });
  const sync = new CodeMapInvestigationSyncService(codeMap,repository);
  const binding = new CodeScopeBindingService(codeMap,repository,tasks);
  server = createQuestBoardHttpServer(tasks, {
    webRoot:join(process.cwd(),"web"),codeMapService:codeMap,
    sourceStructureFlowSyncService:sourceSync,
    codeMapInvestigationSyncService:sync,codeScopeBindingService:binding,
  });
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve)});
  const port=server.address().port;
  const url=`http://127.0.0.1:${port}/?view=code-map`;
  chrome=spawn(chromeBinary,[
    "--headless=new","--disable-gpu","--disable-extensions","--disable-background-networking",
    "--no-first-run","--no-default-browser-check","--no-proxy-server","--disable-sync",
    "--remote-allow-origins=*","--remote-debugging-port=0",
    `--user-data-dir=${profile}`,"about:blank",
  ],{detached:true,stdio:["ignore","ignore","pipe"]});
  chrome.stderr.on("data",chunk=>{if(browserErrors.join("").length<6000)browserErrors.push(String(chunk).slice(0,1200))});
  const since=performance.now();
  let activePort;
  while(performance.now()-since<13_000) {
    const path=join(profile,"DevToolsActivePort");
    if(existsSync(path)) { activePort=Number(readFileSync(path,"utf8").split("\n")[0]); break; }
    if(chrome.exitCode!==null) break;
    await sleep(80);
  }
  if(!activePort)throw new Error("Chrome headless CDP did not start: "+browserErrors.join("").slice(-2000));
  const targets=await (await fetch(`http://127.0.0.1:${activePort}/json/list`)).json();
  const target=targets.find(t=>t.type==="page");
  assert.ok(target?.webSocketDebuggerUrl,"Chrome page debugger required");
  ws=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{
    ws.addEventListener("open",resolve,{once:true});
    ws.addEventListener("error",reject,{once:true});
  });
  const cdp=new CDP(ws);
  await cdp.call("Page.enable");
  await cdp.call("Runtime.enable");
  await cdp.call("Page.navigate",{url});
  const ready=await cdp.wait("state.projectId && state.codeMap?.boundedSourceTree && state.codeMapLazyTreePages?.has('')", "Code Map bounded bootstrap");
  assert.ok(ready);
  const browserVersion=await cdp.eval("navigator.userAgent");
  assert.match(browserVersion,/Chrome/);
  assert.equal(await cdp.eval("state.codeMap.graph === null"),true);
  await cdp.wait("state.codeMapSubsystems?.nodes?.length > 0 && state.codeMapSubsystems?.relations?.length > 0",
    "Source subsystem architecture loaded");
  assert.ok(await cdp.eval("document.querySelector('.code-map-architecture-summary')?.textContent.includes('Source architecture')"));
  await cdp.eval("document.querySelector('.code-map-subsystem-focus').click()");
  await cdp.wait("state.codeMapSubsystemSelected !== null", "subsystem selection");
  await cdp.eval("document.querySelector('.code-map-subsystem-focus[aria-pressed=true]').click()");
  await cdp.wait("state.codeMapSubsystemSelected === null", "show all subsystem relations");
  await cdp.eval("document.querySelector('.code-map-subsystem-relation').click()");
  await cdp.wait("document.querySelector('.code-map-subsystem-evidence-link') !== null",
    "real raw source evidence from aggregate relation");
  const evidenceOwnerId = await cdp.eval("document.querySelector('.code-map-subsystem-evidence-link').dataset.codeMapNodeId");
  assert.ok(evidenceOwnerId.startsWith("code:node:"));
  await cdp.eval("document.querySelector('.code-map-subsystem-evidence-link').click()");
  await cdp.wait(`state.codeMapInspectorData?.node?.id === ${JSON.stringify(evidenceOwnerId)}`,
    "subsystem evidence owner opens raw Inspector");
  assert.ok(await cdp.eval("document.querySelectorAll('.code-map-tree-directory').length > 0"));
  await cdp.eval("document.querySelector('.code-map-tree-directory .code-map-tree-label').click()");
  await cdp.wait("state.codeMapLazyTreePages.has('src')","expand src directory");
  await cdp.eval("Array.from(document.querySelectorAll('.code-map-tree-directory .code-map-tree-label')).find(e=>e.textContent.includes('Application')).click()");
  await cdp.wait("state.codeMapLazyTreePages.has('src/Application')","expand Application directory");
  await cdp.wait("document.querySelector('.code-map-node-file .code-map-tree-label') !== null","file row");
  await cdp.eval("document.querySelector('.code-map-node-file .code-map-tree-label').click()");
  await cdp.wait("state.codeMapInspectorData !== null && !!document.querySelector('#code-map-inspector-body')?.textContent","native inspector");
  await cdp.eval("const q=document.getElementById('code-map-search');q.value='handle';q.dispatchEvent(new Event('input',{bubbles:true}))");
  await cdp.wait("state.codeMapSearchResults?.some(n=>n.name.toLowerCase().includes('handle'))","symbol search result");
  await cdp.eval("document.getElementById('source-structure-open').click()");
  await cdp.wait("document.getElementById('source-structure-dialog').open && state.sourceStructure.page?.nodes?.length>0","Source Structure candidates");
  await cdp.eval("document.querySelector('#source-structure-candidates input[type=checkbox]').click()");
  await cdp.eval("document.getElementById('source-structure-preview').click()");
  await cdp.wait("state.sourceStructure.preview && document.querySelectorAll('#source-structure-result .code-map-sync-row').length>0","Source Structure preview");
  assert.equal(await cdp.eval("document.getElementById('source-structure-apply').disabled"),true,
    "unauthenticated Source Structure apply remains disabled");
  await cdp.eval("document.getElementById('source-structure-close').click()");
  await cdp.wait("!document.getElementById('source-structure-dialog').open","Source Structure close");
  await cdp.eval("document.getElementById('code-map-sync').click()");
  await cdp.wait("document.getElementById('code-map-sync-dialog').open && state.codeMapSyncPreview && document.querySelectorAll('#code-map-sync-body .code-map-sync-row').length>0","Code to Flow preview");
  assert.equal(await cdp.eval("document.getElementById('code-map-sync-apply').disabled"),false);
  await cdp.eval("document.getElementById('code-map-sync-apply').click()");
  await cdp.wait("state.codeMapSyncResult && state.codeMapSyncResult.counts.createdNodes>0","Code to Flow Apply");
  assert.ok(repository.listInvestigationNodes(project.id).length>0);
  assert.equal(await cdp.eval("state.codeMap.graph === null"),true);
  await cdp.wait("!state.codeMapSyncLoading && !state.codeMapLoading","Code to Flow apply render settled");
  await cdp.eval("document.getElementById('code-map-sync-dialog').close();document.querySelector('[data-board-view=code-map]').click()");
  await cdp.wait("state.viewMode==='code-map' && state.codeMap.indexed && !state.codeMapLoading",
    "return to Code Map before explicit browser cancellation");
  // Hold exactly one browser fetch to verify a real user click propagates
  // AbortController cancellation rather than merely hiding the dialog.
  await cdp.eval(`window.__s7OriginalFetch=window.fetch;
    window.__s7BrowserCancelObserved=false;
    window.fetch=(resource, options={})=>{
      if(String(resource).includes('source-structure/flow-sync/candidates'))
        return new Promise((resolve,reject)=>{
          options.signal?.addEventListener('abort',()=>{
            window.__s7BrowserCancelObserved=true;
            reject(new DOMException('Cancelled by user','AbortError'));
          },{once:true});
        });
      return window.__s7OriginalFetch(resource,options);
    };
    document.getElementById('source-structure-open').click();`);
  await cdp.wait("state.sourceStructure.readAbort && state.sourceStructure.loading","source dialog request started");
  await cdp.eval("document.getElementById('source-structure-close').click()");
  await cdp.wait("window.__s7BrowserCancelObserved && !state.sourceStructure.loading",
    "explicit close cancels pending browser fetch");
  await cdp.eval("window.fetch=window.__s7OriginalFetch");
  await cdp.eval(`window.__s7SearchCancelObserved=false;
    window.fetch=(resource, options={})=>{
      if(String(resource).includes('/code-map/query'))
        return new Promise((resolve,reject)=>{
          options.signal?.addEventListener('abort',()=>{
            window.__s7SearchCancelObserved=true;
            reject(new DOMException('Superseded search','AbortError'));
          },{once:true});
        });
      return window.__s7OriginalFetch(resource,options);
    };
    const s7CancelQueryField=document.getElementById('code-map-search');
    s7CancelQueryField.value='handle';s7CancelQueryField.dispatchEvent(new Event('input',{bubbles:true}));`);
  await cdp.wait("state.codeMapSearchLoading && state.codeMapSearchAbort",
    "search request started");
  await cdp.eval(`const s7ReplacementQueryField=document.getElementById('code-map-search');
    s7ReplacementQueryField.value='save';s7ReplacementQueryField.dispatchEvent(new Event('input',{bubbles:true}));`);
  await cdp.wait("window.__s7SearchCancelObserved","superseded search aborts browser fetch");
  await cdp.eval("window.fetch=window.__s7OriginalFetch");
  console.log(JSON.stringify({
    status:"S7_CHROME_BROWSER_E2E_PASS",
    browser:browserVersion.match(/Chrome\/[^ ]+/)?.[0],
    project:project.name,
    folderNavigation:"root/src/Application/Handler.php",
    search:"handle",
    inspector:"native-node",
    sourceArchitecture:"subsystem selection, aggregate relation evidence, raw owner Inspector",
    sourceStructure:"selected-pin-preview, unauthenticated-Apply-locked",
    codeToFlow:"preview + isolated Apply",
    explicitDialogCancel:"AbortController observed",
    supersededSearchCancel:"AbortController observed",
    flowNodes:repository.listInvestigationNodes(project.id).length,
    daemonFullGraphHydrated:false,
    disposableFixture:true,
  },null,2));
} finally {
  if(ws)try{ws.close()}catch{}
  if(chrome?.pid)try{process.kill(-chrome.pid,"SIGKILL")}catch{try{chrome.kill("SIGKILL")}catch{}}
  if(server)await new Promise(resolve=>server.close(()=>resolve()));
  repository.close();
  rmSync(directory,{recursive:true,force:true});
}
