// Diagnostic, read-only: compares native BookStack SCIP references against the
// QuestBoard graph's owner/range gates without executing the indexer again.
import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BundledScipIndexReader } from "../dist/src/adapters/code-intelligence/scip-provider.js";
const candidateRoots = readdirSync(tmpdir())
  .filter(name => name.startsWith("questboard-s7-php-scip-"))
  .map(name => join(tmpdir(), name))
  .filter(path => statSync(path).isDirectory())
  .sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs);
const indexFiles = [];
function search(dir, depth=0) {
  if(depth>3)return;
  for(const name of readdirSync(dir)) {
    const path = join(dir,name);
    const s = statSync(path);
    if(s.isFile()&&name==="index.scip") indexFiles.push(path);
    if(s.isDirectory()) search(path,depth+1);
  }
}
for(const dir of candidateRoots) search(dir);
if(!indexFiles.length)throw Error("No isolated SCIP PHP index found");
const file=indexFiles.sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs)[0];
const data=await new BundledScipIndexReader().read(file);
const counts={
  documents:data.documents.length, externalSymbols:data.externalSymbols.length,
  symbols:0, occurrences:0, definitions:0, references:0,
  referencesWithRange:0, referencesWithEnclosingRange:0,
  definitionsWithEnclosingRange:0,
  docsWithRefs:0,docsWithDefinitions:0,docsWithOwnerRanges:0,
  localReferences:0, globalReferences:0,
  symbolsWithEnclosingSymbol:0, roles:{}, languages:{},
  candidatesWithinOwnedRanges:0, referenceKinds:{},
};
const examples=[];
const contains=(outer,inner)=>outer.startLine<inner.startLine||(
  outer.startLine===inner.startLine&&outer.startCharacter<=inner.startCharacter)
  ? outer.endLine>inner.endLine||(outer.endLine===inner.endLine&&outer.endCharacter>=inner.endCharacter)
  : false;
for(const doc of data.documents){
  counts.languages[doc.language??"unset"]=(counts.languages[doc.language??"unset"]??0)+1;
  counts.symbols+=doc.symbols.length;
  counts.symbolsWithEnclosingSymbol+=doc.symbols.filter(s=>s.enclosingSymbol).length;
  counts.occurrences+=doc.occurrences.length;
  const defs=doc.occurrences.filter(o=>(o.symbolRoles&1)!==0);
  const refs=doc.occurrences.filter(o=>(o.symbolRoles&1)===0);
  counts.definitions+=defs.length;
  counts.references+=refs.length;
  counts.docsWithRefs+=refs.length>0?1:0;
  counts.docsWithDefinitions+=defs.length>0?1:0;
  counts.docsWithOwnerRanges+=defs.some(d=>d.enclosingRange)?1:0;
  counts.definitionsWithEnclosingRange+=defs.filter(d=>d.enclosingRange).length;
  counts.referencesWithRange+=refs.filter(o=>o.range).length;
  counts.referencesWithEnclosingRange+=refs.filter(o=>o.enclosingRange).length;
  counts.localReferences+=refs.filter(o=>o.symbol.startsWith("local ")).length;
  counts.globalReferences+=refs.filter(o=>!o.symbol.startsWith("local ")).length;
  for(const o of doc.occurrences)counts.roles[o.symbolRoles]=(counts.roles[o.symbolRoles]??0)+1;
  for(const o of refs){
    if(!o.range)continue;
    if(defs.some(d=>d.enclosingRange&&contains(d.enclosingRange,o.range)))counts.candidatesWithinOwnedRanges++;
  }
  if(examples.length<5&&refs.length){examples.push({
    path:doc.relativePath,def:defs.slice(0,2).map(d=>({
      roles:d.symbolRoles,range:d.range,enclosingRange:d.enclosingRange,
    })),ref:refs.slice(0,3).map(o=>({symbol:o.symbol.slice(0,110),roles:o.symbolRoles,range:o.range,enclosingRange:o.enclosingRange})),
  });}
}
console.log(JSON.stringify({fileBytes:statSync(file).size,counts,examples},null,2));
