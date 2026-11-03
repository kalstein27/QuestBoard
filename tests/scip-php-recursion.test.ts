import assert from "node:assert/strict";
import test from "node:test";
import { normalizeScipGraph, parseScipJsonIndex, type ScipPhpLexicalScope } from "../src/adapters/code-intelligence/scip-normalizer.js";
import { queryCodeGraph } from "../src/application/code-map-query.js";
const symbol="scip-php composer example/app 1.0 src/Worker.php/Domain\\Worker#repeat().";
const line="public function repeat() { $this->repeat(); }";
test("C3: recursion is a real self calls relation, without inventing self containment",()=>{
  const occurrence=line.lastIndexOf("repeat");
  const scopes=new Map<string,ScipPhpLexicalScope[]>([
    ["src/Worker.php",[
      {type:"method",name:"repeat",className:"Domain\\Worker",
        range:[1,0,1,line.length],nameRange:[1,16,1,22],
        calls:[{className:"Domain\\Worker",name:"repeat",
          nameRange:[1,occurrence,1,occurrence+6]}]},
    ]],
  ]);
  const graph=normalizeScipGraph({
    projectId:"php-recursion",rootPath:"/tmp/php-recursion",
    indexedAt:"2026-11-03T00:00:00Z",providerId:"scip-php",
    phpLexicalScopes:scopes,
    index:parseScipJsonIndex({documents:[{
      relativePath:"src/Worker.php",language:"php",
      symbols:[{symbol,kind:"Method",displayName:"repeat"}],
      occurrences:[{symbol,symbolRoles:1,range:[1,16,22]},
        {symbol,symbolRoles:0,range:[1,occurrence,occurrence+6]}],
    }]}),
    sourceTextByPath:new Map([["src/Worker.php","<?php\n"+line]]),
  });
  const node=graph.nodes.find(n=>n.name==="repeat")!;
  const calls=graph.relations.filter(r=>r.kind==="calls" && r.from===node.id && r.to===node.id);
  assert.equal(calls.length,1);
  assert.equal(calls[0]?.evidence?.length,1);
  assert.equal(graph.relations.filter(r=>r.from===node.id && r.to===node.id && r.kind!=="calls").length,0);
  const queried=queryCodeGraph(graph,"scip-php",{operation:"relations",nodeId:node.id,semantic:"callers"});
  assert.equal(queried.operation,"relations");
  assert.equal(queried.entries.length,1);
});
