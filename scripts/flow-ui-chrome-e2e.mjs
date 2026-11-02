// Real Chrome UI regression against disposable SQLite + isolated web server.
// No existing QuestBoard data, browser profile, or managed MCP is touched.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQuestBoardHttpServer } from "../dist/src/server/http-api.js";
import { QuestBoardService } from "../dist/src/application/quest-board-service.js";
import { SqliteQuestBoardRepository } from "../dist/src/storage/sqlite/sqlite-quest-board-repository.js";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener("message", event => {
      const msg = JSON.parse(event.data);
      const callback = this.pending.get(msg.id);
      if (!callback) return;
      this.pending.delete(msg.id);
      if (msg.error) callback.reject(new Error(JSON.stringify(msg.error)));
      else callback.resolve(msg.result);
    });
  }
  call(method, params={}) {
    const id=++this.seq;
    return new Promise((resolve,reject)=>{
      this.pending.set(id,{resolve,reject});
      this.ws.send(JSON.stringify({id,method,params}));
    });
  }
  async eval(code) {
    const result=await this.call("Runtime.evaluate",{expression:code,awaitPromise:true,returnByValue:true});
    if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
    return result.result?.value;
  }
  async wait(code,label) {
    for(let i=0;i<170;i++) {
      if(await this.eval(code).catch(()=>false))return;
      await sleep(75);
    }
    throw Error("Chrome Flow test timeout: "+label);
  }
  mouse(type,x,y,buttons=0) {
    return this.call("Input.dispatchMouseEvent",{type,x,y,button:type==="mouseMoved"?"none":"left",buttons,clickCount:type==="mouseMoved"?0:1});
  }
  async click(selector) {
    const xy=await this.eval("(()=>{const e=document.querySelector("+JSON.stringify(selector)+");if(!e)throw Error('Missing '+"
      +JSON.stringify(selector)+");const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,hit:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===e}})()");
    await this.mouse("mouseMoved",xy.x,xy.y);
    await sleep(160); // CSS hover reveals desktop item actions.
    const hit=await this.eval("(()=>{const e=document.querySelector("+JSON.stringify(selector)+");const r=e.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===e;})()");
    assert.equal(hit,true,"target hit intercepted: "+selector);
    await this.mouse("mousePressed",xy.x,xy.y,1);
    await this.mouse("mouseReleased",xy.x,xy.y);
  }
}

const directory=mkdtempSync(join(tmpdir(),"questboard-flow-ui-"));
const repository=new SqliteQuestBoardRepository(join(directory,"isolated.sqlite"));
const service=new QuestBoardService(repository);
const actor={id:"human:flow-ui-fixture",provider:"human"};
const project=service.createProject({name:"Flow Chrome fixture"},actor);
service.createFlowWorkGroup({projectId:project.id,title:"Draggable group",x:620,y:90,width:570,height:420},actor);
const compact=service.createInvestigationNode({projectId:project.id,title:"Short"},actor);
const rich=service.createInvestigationNode({projectId:project.id,title:"Long graph node title that needs to wrap into multiple lines",description:"Node details should remain visible and contribute to the card height."},actor);
service.createInvestigationItem({nodeId:rich.id,title:"First very long item title that should wrap instead of being cropped off at the right edge",description:"Item details must be displayed and included in card height."},actor);
service.createInvestigationItem({nodeId:rich.id,title:"Second item content with another long title and a description",description:"More card content means a taller Flow node."},actor);
let server,chrome,ws;
try {
  server=createQuestBoardHttpServer(service,{webRoot:join(process.cwd(),"web")});
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve)});
  chrome=spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",[
    "--headless=new","--disable-gpu","--disable-extensions","--disable-background-networking",
    "--no-first-run","--no-proxy-server","--disable-sync","--remote-allow-origins=*",
    "--remote-debugging-port=0","--window-size=1440,960",
    "--user-data-dir="+join(directory,"chrome"),"about:blank",
  ],{detached:true,stdio:"ignore"});
  let port;
  for(let i=0;i<170;i++){
    const f=join(directory,"chrome","DevToolsActivePort");
    if(existsSync(f)){port=Number(readFileSync(f,"utf8").split("\n")[0]);break}
    await sleep(75);
  }
  if(!port)throw Error("Chrome CDP port missing");
  const targets=await(await fetch("http://127.0.0.1:"+port+"/json/list")).json();
  ws=new WebSocket(targets.find(t=>t.type==="page").webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true})});
  const cdp=new CDP(ws);
  await cdp.call("Page.enable");await cdp.call("Runtime.enable");
  await cdp.call("Page.navigate",{url:"http://127.0.0.1:"+server.address().port+"/?view=investigation"});
  await cdp.wait("state.viewMode==='investigation' && document.querySelectorAll('.investigation-graph-node').length===2 && document.querySelector('.flow-work-group-actions button')","Flow fixture render");
  await sleep(200);
  const result=await cdp.eval("(()=>{const c=[...document.querySelectorAll('.investigation-graph-node')];"+
    "const rich=c.find(e=>e.textContent.includes('First very long item'));const small=c.find(e=>e!==rich);"+
    "const title=rich.querySelector('.investigation-item-title');"+
    "const b=document.querySelector('.flow-work-group-actions button[title=\"Edit visual group\"]');"+
    "const r=b.getBoundingClientRect();return {richHeight:rich.offsetHeight,smallHeight:small.offsetHeight,"+
    "richWidth:rich.offsetWidth,smallWidth:small.offsetWidth,nodeLayer:getComputedStyle(document.querySelector('.investigation-nodes')).pointerEvents,"+
    "descriptionDisplay:getComputedStyle(rich.querySelector('.investigation-item-description')).display,"+
    "itemWhiteSpace:getComputedStyle(title).whiteSpace,itemHeight:title.offsetHeight,"+
    "itemLineHeight:parseFloat(getComputedStyle(title).lineHeight),"+
    "groupButtonHit:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===b};})()");
  assert.ok(result.richHeight>result.smallHeight+60,"rich card did not grow with its content");
  assert.ok(result.richWidth<=330 && result.smallWidth>=270,"card width was not bounded");
  assert.equal(result.descriptionDisplay,"block");
  assert.equal(result.itemWhiteSpace,"normal");
  assert.ok(result.itemHeight>result.itemLineHeight*1.75,"item title did not wrap");
  assert.equal(result.nodeLayer,"none");
  assert.equal(result.groupButtonHit,true,"work group button intercepted by node layer");

  await cdp.eval("window.__flowPrompts=[];window.prompt=(text)=>{window.__flowPrompts.push(text);return null;}");
  await cdp.click(".flow-work-group-actions button[title='Edit visual group']");
  assert.ok((await cdp.eval("window.__flowPrompts")).some(s=>s.includes("Flow group title")));
  await cdp.click(".investigation-graph-node .investigation-item-actions button[title='Edit item']");
  assert.ok((await cdp.eval("window.__flowPrompts")).some(s=>s.includes("Item title")));
  await cdp.click(".investigation-graph-node .graph-add-button[title='Add item']");
  assert.ok((await cdp.eval("window.__flowPrompts")).some(s=>s.includes("Item title")));
  await cdp.click(".investigation-graph-node .investigation-node-head button[title='Edit node']");
  assert.ok((await cdp.eval("window.__flowPrompts")).some(s=>s.includes("Node title")));

  const drag=await cdp.eval("(()=>{const c=[...document.querySelectorAll('.investigation-graph-node')].find(e=>e.textContent.includes('First very long item'));"+
    "const r=c.querySelector('.investigation-item-title').getBoundingClientRect();return {x:r.left+25,y:r.top+7,left:parseFloat(c.style.left)};})()");
  await cdp.mouse("mouseMoved",drag.x,drag.y);
  await cdp.mouse("mousePressed",drag.x,drag.y,1);
  await cdp.mouse("mouseMoved",drag.x+95,drag.y+54,1);
  await cdp.mouse("mouseReleased",drag.x+95,drag.y+54);
  const moved=await cdp.eval("(()=>{const c=[...document.querySelectorAll('.investigation-graph-node')].find(e=>e.textContent.includes('First very long item'));"+
    "return {left:parseFloat(c.style.left),selection:getSelection().toString()};})()");
  assert.ok(moved.left>drag.left+10,"drag from item title did not move the card");
  assert.equal(moved.selection,"","drag selected text");

  await cdp.call("Emulation.setTouchEmulationEnabled",{enabled:true,maxTouchPoints:1});
  await cdp.wait("matchMedia('(pointer: coarse)').matches","touch pointer emulation");
  await sleep(200); // Wait for the CSS opacity transition before asserting its settled value.
  const touch=await cdp.eval("(()=>{const s=getComputedStyle(document.querySelector('.investigation-item-actions'));"+
    "return {visibility:s.visibility,pointerEvents:s.pointerEvents,opacity:s.opacity};})()");
  assert.equal(touch.visibility,"visible");
  assert.equal(touch.pointerEvents,"auto");
  assert.equal(touch.opacity,"1");
  console.log(JSON.stringify({status:"FLOW_UI_CHROME_PASS",result,moved,touch,disposableFixture:true},null,2));
} finally {
  if(ws)try{ws.close()}catch{}
  if(chrome?.pid)try{process.kill(-chrome.pid,"SIGKILL")}catch{try{chrome.kill("SIGKILL")}catch{}}
  if(server)await new Promise(resolve=>server.close(resolve));
  repository.close();
  rmSync(directory,{recursive:true,force:true});
}
