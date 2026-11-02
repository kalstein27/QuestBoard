// S7 read-only native SCIP PHP coverage gap audit for the disposable BookStack checkout.
// Proves exactly which first-party PHP files are in/out of the native index.
import { existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FileSystemCodeFileInventory } from "../dist/src/adapters/code-intelligence/file-inventory.js";
import { BundledScipIndexReader } from "../dist/src/adapters/code-intelligence/scip-provider.js";

const root = resolve(process.argv[2] ?? "/tmp/questboard-s7-bookstack-20261030");
if (!root.startsWith("/tmp/questboard-s7-bookstack-")
    || !existsSync(join(root, ".git")) || !existsSync(join(root, "composer.lock"))) {
  throw new Error("S7 native PHP coverage audit only accepts a disposable Composer BookStack checkout");
}
const all = await new FileSystemCodeFileInventory().listFiles(root);
const phpFiles = new Set(all.filter(file => file.path.endsWith(".php")).map(file => file.path));
const roots = readdirSync(tmpdir())
  .filter(name => name.startsWith("questboard-s7-php-scip-"))
  .map(name => join(tmpdir(), name))
  .sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs);
const artifacts = [];
for (const base of roots) {
  for (const directory of readdirSync(base)) {
    const path=join(base,directory,"index.scip");
    if(existsSync(path)&&statSync(path).size>1_000_000)artifacts.push(path);
  }
}
if(!artifacts.length)throw Error("No retained native SCIP PHP artifact in isolated /tmp");
const artifact=artifacts.sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs)[0];
const index=await new BundledScipIndexReader().read(artifact);
const indexedPaths=new Set(index.documents
  .map(doc=>doc.relativePath.replaceAll("\\","/").replace(/^\.\//,""))
  .filter(path=>path.endsWith(".php")));
const indexedInSource=[...indexedPaths].filter(path=>phpFiles.has(path));
const unindexed=[...phpFiles].filter(path=>!indexedPaths.has(path));
const nativeOutsideSource=[...indexedPaths].filter(path=>!phpFiles.has(path));
function byFolder(paths){
  const counts=new Map();
  for(const path of paths){const folder=path.split("/")[0];counts.set(folder,(counts.get(folder)??0)+1)}
  return [...counts].sort((a,b)=>b[1]-a[1]).map(([name,count])=>({name,count}));
}
console.log(JSON.stringify({
  status:"native_scip_php_scope_audited",
  nativeIndexBytes:statSync(artifact).size,
  fileInventory:all.length,
  firstPartyPhp:phpFiles.size,
  nativePhpDocuments:indexedPaths.size,
  indexedFirstPartyPhp:indexedInSource.length,
  unindexedFirstPartyPhp:unindexed.length,
  nativeOutsideFirstPartyCount:nativeOutsideSource.length,
  nativeOutsideFirstPartyFolders:byFolder(nativeOutsideSource),
  indexedFolders:byFolder(indexedInSource),
  unindexedFolders:byFolder(unindexed),
  unindexedExamples:unindexed.slice(0,12),
},null,2));
