import assert from "node:assert/strict";
import test from "node:test";
import { queryCodeGraph } from "../src/application/code-map-query.js";
import { normalizeScipGraph, parseScipJsonIndex, type ScipPhpLexicalScope } from "../src/adapters/code-intelligence/scip-normalizer.js";

const pre = "scip-php composer example/app 1.0 ";
const klass = pre + "src/OrderStatus.php/Domain\\OrderStatus#";
const constant = klass + "PAID.";
const enm = pre + "src/PaymentState.php/Domain\\PaymentState#";
const enumCase = enm + "Paid.";
const caller = pre + "src/Checkout.php/Domain\\Checkout#";
const check = caller + "check().";
const ext = "scip-php composer php/system 1.0 External#Symbol.";

function graph(mismatch=false) {
  const scopes = new Map<string, ScipPhpLexicalScope[]>([
    ["src/OrderStatus.php",[{
      type:"class",className:"Domain\\OrderStatus",
      range:[0,0,2,1],nameRange:[0,6,0,17],ancestors:[],
      constantDefinitions:[{
        name:"PAID",nameRange:[1,mismatch?18:15,1,mismatch?22:19],kind:"constant",
      }],
    }]],
    ["src/PaymentState.php",[{
      type:"class",className:"Domain\\PaymentState",
      range:[0,0,2,1],nameRange:[0,6,0,18],ancestors:[],
      constantDefinitions:[{
        name:"Paid",nameRange:[1,7,1,11],kind:"enum_case",
      }],
    }]],
    ["src/Checkout.php",[
      {type:"class",className:"Domain\\Checkout",
        range:[0,0,5,1],nameRange:[0,6,0,14],ancestors:[]},
      {type:"method",className:"Domain\\Checkout",name:"check",
        range:[1,0,5,1],nameRange:[1,15,1,20]},
    ]],
  ]);
  const documents = [
    {
      relativePath:"src/OrderStatus.php",language:"php",
      symbols:[{symbol:klass,displayName:"OrderStatus",kind:"Class"},
        {symbol:constant,displayName:"PAID",kind:0}],
      occurrences:[{symbol:klass,symbolRoles:1,range:[0,6,17]},
        {symbol:constant,symbolRoles:1,range:[1,15,19]}],
    },
    {
      relativePath:"src/PaymentState.php",language:"php",
      symbols:[{symbol:enm,displayName:"PaymentState",kind:"Enum"},
        {symbol:enumCase,displayName:"Paid",kind:0}],
      occurrences:[{symbol:enm,symbolRoles:1,range:[0,6,18]},
        {symbol:enumCase,symbolRoles:1,range:[1,7,11]}],
    },
    {
      relativePath:"src/Checkout.php",language:"php",
      symbols:[{symbol:caller,displayName:"Checkout",kind:"Class"},
        {symbol:check,displayName:"check",kind:"Method"}],
      occurrences:[{symbol:caller,symbolRoles:1,range:[0,6,14]},
        {symbol:check,symbolRoles:1,range:[1,15,20]},
        {symbol:constant,symbolRoles:0,range:[2,23,27]},
        {symbol:enumCase,symbolRoles:0,range:[3,22,26]},
        {symbol:ext,symbolRoles:0,range:[4,17,23]}],
    },
  ];
  return normalizeScipGraph({
    projectId:"php-constants",rootPath:"/tmp/php-constants",
    indexedAt:"2026-11-03T00:00:00Z",providerId:"scip-php",
    phpLexicalScopes:scopes,index:parseScipJsonIndex({
      documents,externalSymbols:[{symbol:ext,kind:0,displayName:"Symbol"}],
    }),
  });
}

test("A3: AST-proven constant and enum case become filterable kinds and referenced_by reads",()=>{
  const g=graph();
  for(const [name,kind] of [["PAID","variable"],["Paid","property"]] as const) {
    const node=g.nodes.find(n=>n.name===name)!;
    assert.equal(node.kind,kind);
    const found=queryCodeGraph(g,"scip-php",{
      operation:"find_nodes",query:name,kinds:[kind],
    });
    assert.equal(found.operation,"find_nodes");
    assert.ok(found.nodes.some(n=>n.id===node.id));
    const refs=queryCodeGraph(g,"scip-php",{
      operation:"relations",semantic:"referenced_by",nodeId:node.id,
    });
    assert.equal(refs.operation,"relations");
    assert.equal(refs.entries.length,1);
    assert.equal(refs.entries[0]!.relation.kind,"reads");
    const parent=g.nodes.find(n=>n.kind==="class" || n.kind==="enum" && n.name!=="check");
    assert.ok(g.relations.some(r=>r.kind==="contains" && r.to===node.id));
  }
  assert.ok(g.relations.some(r=>r.kind==="depends_on" && g.nodes.some(n=>n.id===r.to && n.name==="Symbol")),
    "external unknown reference stays depends_on");
});

test("A3: unmatched AST constant definition does not promote or relabel a SCIP node",()=>{
  const g=graph(true);
  const node=g.nodes.find(n=>n.name==="PAID")!;
  assert.equal(node.kind,"unknown");
  assert.equal(g.relations.some(r=>r.kind==="reads" && r.to===node.id),false);
});
