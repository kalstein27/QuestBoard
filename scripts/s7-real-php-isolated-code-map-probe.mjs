// S7 real BookStack SCIP/PHP through QuestBoard's actual P1+P2 isolated
// process pipelines. Read-only public checkout; project-root generated SCIP is
// removed by ScipPhpProvider, and persistent snapshots are stored in new /tmp.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { createConfiguredCodeMapRuntime } from "../dist/src/server/code-map-config.js";
import { createIsolatedCodeMapRefreshExecutor } from "../dist/src/server/code-map-isolated-refresh.js";
import { createIsolatedCodeMapReadExecutor } from "../dist/src/server/code-map-isolated-read.js";

const requestedRoot=resolve(process.argv[2]??"/tmp/questboard-s7-bookstack-20261030");
if(!requestedRoot.startsWith("/tmp/questboard-s7-bookstack-"))
  throw Error("Unexpected non-isolated PHP fixture path");
// macOS resolves /tmp to /private/tmp; the real daemon/child requires its
// canonical rootPath to match exactly, rather than following that symlink.
const root=realpathSync.native(requestedRoot);
const projectId="s7-bookstack-real-isolated-php";
const required=[".git","composer.json","composer.lock","vendor/autoload.php","vendor/bin/scip-php"];
if(!root.startsWith("/private/tmp/questboard-s7-bookstack-")||realpathSync.native(root)!==root
  ||required.some(path=>!existsSync(join(root,path)))||existsSync(join(root,"index.scip")))
  throw Error("S7 real isolate benchmark requires a fresh disposable BookStack checkout");
const outputRoot=mkdtempSync(join(tmpdir(),"questboard-s7-real-php-isolated-"));
const env={
  HOME:process.env.HOME,PATH:process.env.PATH,
  QUESTBOARD_CODE_MAP:"1",
  QUESTBOARD_CODE_MAP_PROVIDERS:"scip-php",
  QUESTBOARD_CODE_MAP_STORAGE_ROOT:outputRoot,
  QUESTBOARD_SCIP_PHP_EXECUTABLE:join(root,"vendor","bin","scip-php"),
};
const reader={
  listCodeMapManualRelations:()=>[],
  getProject:id=>id===projectId?{id,rootPath:root}:undefined,
};
const runtime=createConfiguredCodeMapRuntime(env,reader);
assert.ok(runtime.service);
const service=runtime.service;
const processMax=()=>+(process.resourceUsage().maxRSS/1024).toFixed(1);
const mb=bytes=>+(bytes/1048576).toFixed(1);
const baselineRss=mb(process.memoryUsage().rss);
let parentPeakRssMiB=baselineRss,childPeakRssMiB,readPeakRssMiB;
let treePeakRssMiB=0,treePeakProcessCount=0,treeSampleCount=0,treePhpObserved=false;
function sampleProcessTree(){
  try{
    const records=execFileSync("/bin/ps",["-axo","pid=,ppid=,rss=,comm="],{encoding:"utf8",timeout:1500})
      .trim().split("\n").map(row=>row.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/))
      .filter(Boolean).map(match=>({
        pid:Number(match[1]),ppid:Number(match[2]),rss:Number(match[3]),command:match[4],
      }))
      // Ignore the sampler's own transient /bin/ps child.
      .filter(entry=>!/(?:^|\/)ps$/.test(entry.command));
    const descendants=new Set([process.pid]);
    for(let pass=0;pass<5;pass++){
      let grown=false;
      for(const {pid,ppid} of records)if(descendants.has(ppid)&&!descendants.has(pid)){
        descendants.add(pid);grown=true;
      }
      if(!grown)break;
    }
    const sumKiB=records.reduce((total,{pid,rss})=>total+(descendants.has(pid)?rss:0),0);
    treePeakRssMiB=Math.max(treePeakRssMiB,mb(sumKiB*1024));
    treePeakProcessCount=Math.max(treePeakProcessCount,descendants.size);
    if(records.some(entry=>descendants.has(entry.pid)&&/(?:^|\/)php(?:-fpm)?$/.test(entry.command)))
      treePhpObserved=true;
    treeSampleCount++;
  }catch{
    // Resource sampling is observational only; never alter index/read results.
  }
}
const t0=performance.now();
const timer=setInterval(()=>{
  parentPeakRssMiB=Math.max(parentPeakRssMiB,mb(process.memoryUsage().rss));
  sampleProcessTree();
},150);
timer.unref();
sampleProcessTree();
let status="failed",failure,receipt,read,summary,webRead,sourceStructure;
try{
  service.setIsolatedRefreshExecutor(createIsolatedCodeMapRefreshExecutor(env,{
    timeoutMs:180_000,
    maxOldSpaceMiB:512,
    onProcessMetrics:metrics=>{childPeakRssMiB=metrics.childMaxRssMiB;},
  }));
  service.setIsolatedReadExecutor(createIsolatedCodeMapReadExecutor(env,{
    timeoutMs:45_000,
    maxOldSpaceMiB:512,
    onProcessMetrics:metrics=>{readPeakRssMiB=Math.max(readPeakRssMiB??0,metrics.childMaxRssMiB);},
  }));
  const first=service.startRefresh({projectId,rootPath:root});
  const completed=await new Promise((resolve,reject)=>{
    const expires=Date.now()+180_000;
    const tick=()=>{
      const receipt=service.refreshJob(projectId);
      if(receipt?.state==="succeeded"||receipt?.state==="failed")return resolve(receipt);
      if(Date.now()>expires)return reject(new Error("Timed out polling isolated PHP refresh"));
      setTimeout(tick,75);
    };
    tick();
  });
  receipt={
    jobId:first.jobId,state:completed.state,
    nodeCount:completed.nodeCount,
    relationCount:completed.relationCount,
    error:completed.error,
  };
  if(completed.state!=="succeeded")throw Error("Isolated PHP refresh failed: "+JSON.stringify(completed.error));
  // Does not deserialize full graph in parent. The child query receives a
  // bounded DTO and a separate maximum RSS sample.
  summary=await service.snapshotReadSummary(projectId);
  const query=await service.queryAsync(projectId,{
    operation:"find_nodes",query:"LoginController",limit:5,
  });
  const web=await service.webBootstrapAsync(projectId);
  assert.equal(web.indexed,true);
  assert.equal(web.nodeCount,completed.nodeCount);
  assert.ok(!("graph" in web), "bounded Web bootstrap must never return raw graph");
  assert.ok(web.projection && web.nodeKinds.includes("file"));
  const investigationPreviewSource=await service.investigationPreviewSourceAsync(projectId);
  assert.equal(investigationPreviewSource.projection.projectId,projectId);
  assert.equal(investigationPreviewSource.projection.sourceIndexedAt,web.indexedAt);
  assert.ok(investigationPreviewSource.projection.nodes.length<=6);
  const rootTree=await service.sourceTreePageAsync(projectId,{
    limit:12,expectedSnapshotId:web.snapshotIdentity.snapshotId,
  });
  assert.equal(rootTree.snapshotId,web.snapshotIdentity.snapshotId);
  assert.ok(rootTree.entries.length>0 && rootTree.entries.length<=12);
  await assert.rejects(service.sourceTreePageAsync(projectId,{
    expectedSnapshotId:"outdated-s7-snapshot",limit:12,
  }),/snapshot changed|snapshot/i);
  const sourcePage=await service.querySourceSubsystemsAsync(projectId,{
    operation:"list_subsystems",limit:12,
  });
  if(sourcePage.operation!=="list_subsystems"||!sourcePage.nodes.length
    ||!sourcePage.snapshotId)throw Error("Real PHP Source Structure requires a pinned nonempty subsystem page");
  const selected=sourcePage.nodes.slice(0,2).map(node=>node.id);
  const flow=await service.sourceStructurePreviewGraphAsync(projectId,{
    projectId,selectionKey:"s7-real-read-only",
    selectedSubsystemIds:selected,
    offset:0,limit:12,
    expectedSourceIndexedAt:sourcePage.sourceIndexedAt,
    expectedSnapshotId:sourcePage.snapshotId,
  });
  assert.equal(flow.snapshotId,sourcePage.snapshotId);
  assert.ok(flow.nodes.length>0 && flow.nodes.length<=12 && flow.relations.length<=24);
  sourceStructure={
    selectedSubsystemCount:selected.length,
    derivedNodes:flow.nodes.length,derivedRelations:flow.relations.length,
    snapshotPinned:flow.snapshotId===sourcePage.snapshotId,
  };
  webRead={
    bounded:true,returnedRawGraph:false,
    projectionNodes:web.projection.nodes.length,rootTreeEntries:rootTree.entries.length,
    candidateCount:rootTree.candidateCount,
    investigationPreviewProjectionNodes:investigationPreviewSource.projection.nodes.length,
  };
  read={
    status:query.operation,
    returnedCount:query.operation==="find_nodes"?query.nodes.length:null,
    nodeKinds:query.operation==="find_nodes"?query.nodes.map(node=>node.kind):[],
  };
  assert.equal(summary.indexed,true);
  assert.equal(summary.nodeCount,completed.nodeCount);
  const phpCoverage=summary.providerCapabilities?.languages.find(entry=>entry.language==="php");
  assert.ok(phpCoverage, "PHP semantic coverage must be visible in the bounded status response");
  assert.ok(phpCoverage.eligibleFileCount>=phpCoverage.indexedFileCount,
    "Never claim native SCIP indexed more first-party PHP files than were eligible");
  assert.equal(phpCoverage.semanticCoverage,"partial",
    "Unindexed first-party PHP must remain visible as partial, not complete coverage");
  status="isolated_php_index_and_bounded_read_pass";
}catch(error){failure=String(error?.stack??error).slice(-2400);}
finally{
  clearInterval(timer);
  parentPeakRssMiB=Math.max(parentPeakRssMiB,mb(process.memoryUsage().rss));
}
console.log(JSON.stringify({
  status,root,outputRoot,receipt,
  readSummary:summary?{indexed:summary.indexed,indexedAt:summary.indexedAt,nodeCount:summary.nodeCount,relationCount:summary.relationCount,
    providerHealth:summary.providerCapabilities?.health,
    phpCoverage:summary.providerCapabilities?.languages.find(entry=>entry.language==="php"),
  }:null,
  boundedQuery:read,webRead,sourceStructure,
  memory:{
    parentBaselineRssMiB:baselineRss,
    parentPeakRssMiB,
    parentResourceMaxRssMiB:processMax(),
    indexChildPeakRssMiB:childPeakRssMiB,
    readChildPeakRssMiB:readPeakRssMiB,
    observedTreePeakRssMiB:treePeakRssMiB,
    observedTreePeakProcessCount:treePeakProcessCount,
    observedTreeSampleCount:treeSampleCount,
    phpChildObservedInTree:treePhpObserved,
    treeSamplingMethod:"150ms ps(pid,ppid,rss,comm) excluding sampler ps; parent and observed descendants, non-atomic samples",
    caveat:"Node child peaks are per-process; nested PHP indexer peak RSS is NOT included. Main parent peak excludes child memory. Never claim these separately sampled peaks are simultaneous.",
  },
  generatedIndexCleaned:!existsSync(join(root,"index.scip")),
  elapsedMs:+(performance.now()-t0).toFixed(1),
  error:failure,
},null,2));
if(status!=="isolated_php_index_and_bounded_read_pass")process.exitCode=1;
