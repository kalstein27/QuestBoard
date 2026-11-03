import assert from "node:assert/strict";
import test from "node:test";
import { queryCodeGraph } from "../src/application/code-map-query.js";
import { queryCodeSourceSubsystems } from "../src/application/code-map-subsystem-read.js";
import { projectCodeArchitecture } from "../src/application/code-map-projection.js";
import { CODE_GRAPH_SCHEMA_VERSION, type CodeGraphSnapshot } from "../src/application/code-intelligence.js";

function graph(count=8): CodeGraphSnapshot {
  const nodes=Array.from({length:count},(_,i)=>({
    id:"n"+i,kind:"method" as const,name:"method"+i,
    canonicalIdentity:"scip:src/mod"+i+"/Service.php#method"+i+"().",
    language:"php",location:{path:"src/mod"+i+"/Service.php",startLine:i+1},
  }));
  return {
    schemaVersion:CODE_GRAPH_SCHEMA_VERSION,projectId:"trace-page",
    rootPath:"/tmp/trace-page",indexedAt:"2026-11-03T00:00:00Z",
    nodes, relations: Array.from({length:count-1},(_,i)=>({
      id:"r"+i,kind:"calls" as const,from:nodes[i]!.id,to:nodes[i+1]!.id,confidence:1,
      evidence:[{location:{path:nodes[i]!.location.path,startLine:i+10},
        receiverClass:"Domain\\Repository"+i,label:"AST proven class"}],
    })),
  };
}

test("B1: compact call trace pages use exact snapshot pinning with stable offsets",()=>{
  const g=graph();
  const page0=queryCodeGraph(g,"scip-php",{
    operation:"call_trace",nodeId:"n0",direction:"outgoing",depth:4,limit:2,
    compact:true,offset:0,
  });
  assert.equal(page0.operation,"call_trace");
  assert.equal(page0.compact,true);
  assert.equal(page0.offset,0);
  assert.equal(page0.hasMore,true);
  assert.equal(page0.nextOffset,2);
  assert.equal(page0.nodes.length,0);
  assert.equal(page0.relations.length,0);
  assert.deepEqual(page0.compactRelations?.map(r=>r.from),["n0","n1"]);
  assert.equal(page0.compactRelations?.[0]?.evidence[0]?.receiverClass,"Domain\\Repository0");
  assert.ok(JSON.stringify(page0).length < JSON.stringify({
    ...page0,compact:false,compactNodes:undefined,compactRelations:undefined,
    nodes:g.nodes,relations:g.relations,
  }).length);
  const page1=queryCodeGraph(g,"scip-php",{
    operation:"call_trace",nodeId:"n0",direction:"outgoing",depth:4,limit:2,
    compact:true,offset:2,expectedSnapshotId:"exact-snapshot",expectedSourceIndexedAt:g.indexedAt,
  });
  assert.equal(page1.operation,"call_trace");
  assert.deepEqual(page1.compactRelations?.map(r=>r.from),["n2","n3"]);
  assert.equal(page1.hasMore,false);
  const legacy=queryCodeGraph(g,"scip-php",{
    operation:"call_trace",nodeId:"n0",direction:"outgoing",depth:4,limit:2,
  });
  assert.equal(legacy.operation,"call_trace");
  assert.equal(legacy.relations.length,1, "legacy node cap remains unchanged");
  assert.equal(legacy.compact,undefined);
});

test("B1: continuation refuses unpinned and changed snapshots and bad offsets",()=>{
  const g=graph();
  const base={operation:"call_trace" as const,nodeId:"n0",direction:"outgoing" as const,depth:3,limit:2,compact:true};
  assert.throws(()=>queryCodeGraph(g,"scip-php",{...base,offset:2}),/requires expectedSnapshotId/);
  assert.throws(()=>queryCodeGraph(g,"scip-php",{
    ...base,offset:2,expectedSnapshotId:"stable",expectedSourceIndexedAt:"yesterday",
  }),/indexedAt changed/);
  assert.throws(()=>queryCodeGraph(g,"scip-php",{...base,offset:-1}),/offset must be/);
});

test("B2: 24 subsystem page can omit notableNodes without changing page identity or counts",()=>{
  const nodes=Array.from({length:24},(_,i)=>({
    id:"sub"+i,kind:"function" as const,name:"entry"+i,
    canonicalIdentity:"scip:src/mod"+i+"/worker.ts#entry"+i,
    language:"typescript",location:{path:"src/mod"+String(i).padStart(2,"0")+"/worker.ts",startLine:1},
  }));
  const g:CodeGraphSnapshot={
    schemaVersion:CODE_GRAPH_SCHEMA_VERSION,projectId:"subsystem-24",
    rootPath:"/tmp/subsystem-24",indexedAt:"2026-11-03T00:00:00Z",
    nodes,relations:nodes.slice(1).map((node,i)=>({
      id:"edge"+i,kind:"calls" as const,from:nodes[i]!.id,to:node.id,confidence:1,
      evidence:[{location:{path:nodes[i]!.location.path,startLine:i+2}}],
    })),
  };
  const compat=projectCodeArchitecture(g);
  const full=queryCodeSourceSubsystems(g,compat,{
    operation:"list_subsystems",limit:24,includeNotableNodes:true,
  });
  const compact=queryCodeSourceSubsystems(g,compat,{
    operation:"list_subsystems",limit:24,includeNotableNodes:false,
  });
  const defaultPage=queryCodeSourceSubsystems(g,compat,{
    operation:"list_subsystems",limit:24,
  });
  assert.equal(compact.operation,"list_subsystems");
  assert.equal(full.operation,"list_subsystems");
  assert.equal(defaultPage.operation,"list_subsystems");
  assert.equal(compact.nodes.length,24);
  assert.equal(full.nodes.length,12,"legacy full-detail page cap remains stable");
  assert.equal(defaultPage.nodes.length,12);
  assert.equal(compact.candidateCount,full.candidateCount);
  assert.deepEqual(compact.nodes.slice(0,full.nodes.length).map(n=>n.id),full.nodes.map(n=>n.id));
  assert.ok(full.nodes.some(n=>n.notableNodes.length>0));
  assert.ok(compact.nodes.every(n=>n.notableNodes.length===0));
  assert.ok(defaultPage.nodes.some(n=>n.notableNodes.length>0));
  assert.ok(compact.nodes.some(n=>n.notableNodesOmitted));
  assert.ok(JSON.stringify(compact).length<JSON.stringify(full).length);
});
