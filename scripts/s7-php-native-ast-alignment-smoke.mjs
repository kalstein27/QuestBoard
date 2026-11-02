import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BundledScipIndexReader } from "../dist/src/adapters/code-intelligence/scip-provider.js";
import { extractPhpLexicalScopes } from "../dist/src/adapters/code-intelligence/php-lexical-scopes.js";
const root = "/private/tmp/questboard-s7-bookstack-20261030";
const candidates = readdirSync(tmpdir()).filter(s=>s.startsWith("questboard-s7-php-scip-"))
  .map(s=>join(tmpdir(),s)).sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs);
let file;
for(const candidate of candidates){for(const sub of readdirSync(candidate)){const path=join(candidate,sub,"index.scip");try{if(statSync(path).size>1000000){file=path;break}}catch{}}if(file)break}
if(!file)throw Error("Missing native BookStack SCIP index");
const index=await new BundledScipIndexReader().read(file);
const paths=index.documents.slice(0,70).map(doc=>doc.relativePath);
const scopes=await extractPhpLexicalScopes(root,paths);
let named=0, exact=0, noMatchExamples=[], matches=[];
for(const doc of index.documents.slice(0,70)){
 const items=scopes.get(doc.relativePath)??[];
 for(const scope of items){
  if(!scope.nameRange)continue;
  named++;
  const defs=doc.occurrences.filter(o=>(o.symbolRoles&1)&&o.range
    &&o.range.startLine===scope.nameRange[0]
    &&o.range.startCharacter===scope.nameRange[1]);
  if(defs.length){exact++;if(matches.length<5)matches.push({
    path:doc.relativePath,name:scope.name,scopeRange:scope.range,
    native:defs.map(d=>({symbol:d.symbol.slice(-90),range:d.range})),
  });}
  else if(noMatchExamples.length<5)noMatchExamples.push({path:doc.relativePath,name:scope.name,nameRange:scope.nameRange});
 }
}
console.log(JSON.stringify({documents:paths.length,parsed:scopes.size,named,exact,matchFraction:named?exact/named:0,matches,noMatchExamples},null,2));
