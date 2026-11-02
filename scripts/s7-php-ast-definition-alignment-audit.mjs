// Read-only SCIP definition location check before PHP AST scope association.
import {readdirSync,statSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {BundledScipIndexReader} from "../dist/src/adapters/code-intelligence/scip-provider.js";
const root="/tmp/questboard-s7-bookstack-20261030";
const all=readdirSync(tmpdir()).filter(x=>x.startsWith("questboard-s7-php-scip-")).map(x=>join(tmpdir(),x)).sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs);
let chosen;
for(const a of all){for(const b of readdirSync(a)){const p=join(a,b,"index.scip");try{if(statSync(p).size>1000000){chosen=p;break}}catch{}}if(chosen)break}
if(!chosen)throw Error("No SCIP artifact");
const index=await new BundledScipIndexReader().read(chosen);
for(const d of index.documents.slice(0,4)){
 const src=readFileSync(join(root,d.relativePath),"utf8").split("\n");
 console.log(JSON.stringify({file:d.relativePath,defs:d.occurrences.filter(o=>(o.symbolRoles&1)!==0).slice(0,12).map(o=>({symbol:o.symbol.slice(-110),range:o.range,source:(src[o.range?.startLine??0]??"").slice(0,150)}))},null,2));
}
