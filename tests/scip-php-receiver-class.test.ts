import assert from "node:assert/strict";
import test from "node:test";
import { normalizeScipGraph, parseScipJsonIndex, type ScipPhpLexicalScope } from "../src/adapters/code-intelligence/scip-normalizer.js";
import { queryCodeGraph } from "../src/application/code-map-query.js";

const prefix = "scip-php composer example/app 1.0.0 ";
const repo = prefix + "src/Repository.php/Domain\\Repository#";
const save = repo + "save().";
const order = prefix + "src/OrderRepository.php/Domain\\OrderRepository#";
const coupon = prefix + "src/CouponRepository.php/Domain\\CouponRepository#";
const caller = prefix + "src/CheckoutService.php/Domain\\CheckoutService#";
const run = caller + "complete().";
const callText = [
  "<?php", "class CheckoutService {",
  "public static function complete(): void {",
  "  OrderRepository::save($order);",
  "  CouponRepository::save($coupon);",
  "  $dynamic::save($unknown);",
  "}",
  "}",
].join("\n");
const methodRange = [2, 27, 2, 35] as const;
const calls = [
  { className: "Domain\\OrderRepository", name: "save", nameRange: [3, 19, 3, 23] as const, evidenceSource: "native" as const },
  { className: "Domain\\CouponRepository", name: "save", nameRange: [4, 20, 4, 24] as const, evidenceSource: "native" as const },
];
function graph() {
  const scopes = new Map<string, ScipPhpLexicalScope[]>([
    ["src/Repository.php", [
      { type: "class", className: "Domain\\Repository", range: [1, 0, 5, 1],
        nameRange: [1, 6, 1, 16], ancestors: [] },
      { type: "method", className: "Domain\\Repository", name: "save",
        range: [2, 0, 2, 70], nameRange: [2, 25, 2, 29],
        isStatic: true, isConcretePublic: true },
    ]],
    ["src/OrderRepository.php", [
      { type: "class", className: "Domain\\OrderRepository", range: [1, 0, 2, 1],
        nameRange: [1, 6, 1, 21],
        ancestors: [{ className: "Domain\\Repository", relation: "extends" }] },
    ]],
    ["src/CouponRepository.php", [
      { type: "class", className: "Domain\\CouponRepository", range: [1, 0, 2, 1],
        nameRange: [1, 6, 1, 22],
        ancestors: [{ className: "Domain\\Repository", relation: "extends" }] },
    ]],
    ["src/CheckoutService.php", [
      { type: "class", className: "Domain\\CheckoutService", range: [1, 0, 7, 1],
        nameRange: [1, 6, 1, 21], ancestors: [] },
      { type: "method", className: "Domain\\CheckoutService", name: "complete",
        range: [2, 0, 6, 1], nameRange: methodRange, calls,
        isStatic: true, isConcretePublic: true },
    ]],
  ]);
  const parse = (symbols: Array<{symbol:string;kind:string;displayName:string}>, occurrences: Array<{symbol:string;symbolRoles:number;range:number[]}>, relativePath:string) => ({
    relativePath, language:"php",symbols,occurrences,
  });
  const index = parseScipJsonIndex({ documents: [
    parse([{symbol:repo,kind:"Class",displayName:"Repository"},{symbol:save,kind:"Method",displayName:"save"}],
      [{symbol:repo,symbolRoles:1,range:[1,6,16]},{symbol:save,symbolRoles:1,range:[2,25,29]}],
      "src/Repository.php"),
    parse([{symbol:order,kind:"Class",displayName:"OrderRepository"}],
      [{symbol:order,symbolRoles:1,range:[1,6,21]}], "src/OrderRepository.php"),
    parse([{symbol:coupon,kind:"Class",displayName:"CouponRepository"}],
      [{symbol:coupon,symbolRoles:1,range:[1,6,22]}], "src/CouponRepository.php"),
    parse([{symbol:caller,kind:"Class",displayName:"CheckoutService"},{symbol:run,kind:"Method",displayName:"complete"}],
      [{symbol:caller,symbolRoles:1,range:[1,6,21]},
       {symbol:run,symbolRoles:1,range:[2,27,35]},
       {symbol:save,symbolRoles:0,range:[3,19,23]},
       {symbol:save,symbolRoles:0,range:[4,20,24]},
       {symbol:save,symbolRoles:0,range:[5,12,16]}],
      "src/CheckoutService.php"),
  ] });
  return normalizeScipGraph({
    projectId:"php-receiver",rootPath:"/tmp/php-receiver",
    indexedAt:"2026-11-03T00:00:00Z", providerId:"scip-php",index,
    phpLexicalScopes:scopes,
    sourceTextByPath:new Map([["src/CheckoutService.php",callText]]),
  });
}

test("A1: distinct proven child receivers survive aggregation to a single parent method", () => {
  const result = graph();
  const method = result.nodes.find(node=>node.name==="save")!;
  const rel = result.relations.find(r=>r.to===method.id && r.kind==="calls")!;
  assert.ok(rel);
  assert.deepEqual(rel.evidence?.map(e=>e.receiverClass), [
    "Domain\\OrderRepository","Domain\\CouponRepository",undefined,
  ]);
  assert.equal(rel.evidence?.length,3);
  assert.ok(rel.evidence?.[0]?.label?.includes("receiverClass: Domain\\OrderRepository"));
  assert.equal(result.nodes.some(n=>n.name==="OrderRepository::save"), false);
  const query = queryCodeGraph(result,"scip-php",{
    operation:"relations",semantic:"callers",nodeId:method.id,
    receiverClass:"OrderRepository",
  });
  assert.equal(query.operation,"relations");
  assert.equal(query.entries.length,1);
  assert.equal(query.entries[0]?.relation.evidence?.length,1);
  assert.equal(query.entries[0]?.relation.evidence?.[0]?.receiverClass,"Domain\\OrderRepository");
  const trace = queryCodeGraph(result,"scip-php",{
    operation:"call_trace",nodeId:result.nodes.find(n=>n.name==="complete")!.id,
    direction:"outgoing",depth:1,limit:10,
  });
  assert.equal(trace.operation,"call_trace");
  assert.equal(trace.relations.filter(r=>r.kind==="calls")[0]?.evidence?.filter(e=>e.receiverClass).length,2);
});

test("A1: ambiguous or unsupported receiver classes cannot become invented calls", () => {
  const result=graph();
  const saveNode=result.nodes.find(n=>n.name==="save")!;
  assert.equal(result.relations.filter(r=>r.kind==="calls" && r.to===saveNode.id).length,1);
  assert.throws(()=>queryCodeGraph(result,"scip-php",{
    operation:"relations",nodeId:saveNode.id,receiverClass:"OrderRepository",
  }),/receiverClass/);
  const noMatch=queryCodeGraph(result,"scip-php",{
    operation:"relations",semantic:"callers",nodeId:saveNode.id,receiverClass:"OtherRepository",
  });
  assert.equal(noMatch.operation,"relations");
  assert.equal(noMatch.entries.length,0);
});
