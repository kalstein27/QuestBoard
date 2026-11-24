// S7 read-only native SCIP PHP coverage gap audit for the disposable BookStack checkout.
// Proves exactly which first-party PHP files are in/out of the native index.
import { existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FileSystemCodeFileInventory } from "../dist/src/adapters/code-intelligence/file-inventory.js";
import { BundledScipIndexReader } from "../dist/src/adapters/code-intelligence/scip-provider.js";
import { extractPhpLexicalScopes } from "../dist/src/adapters/code-intelligence/php-lexical-scopes.js";

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
// File role and AST capabilities are orthogonal: PHP configuration/data can
// contain executable expressions, and syntax-only never implies SCIP semantics.
function sourceRole(path) {
  if (path.startsWith("lang/") || path.startsWith("resources/")) return "translation_or_resource";
  if (path.startsWith("app/Config/")) return "configuration";
  if (/^(?:database\/migrations\/|routes\/|bootstrap\/|dev\/|public\/)/.test(path)) return "execution_entry_or_migration";
  return "unclassified";
}
const unindexedScopes=await extractPhpLexicalScopes(root,unindexed);
const roles={};
const ast={};
const subfolders=new Map();
for(const path of unindexed){
  const role=sourceRole(path);
  const record=roles[role]??={files:0,namedScopes:0,anonymousScopes:0,anonymousClasses:0,
    typedCallSites:0,unresolvedCallSites:0,filesWithStructure:0,examples:[]};
  record.files++;
  if(record.examples.length<5)record.examples.push(path);
  const firstTwo=path.split("/").slice(0,2).join("/");
  subfolders.set(firstTwo,(subfolders.get(firstTwo)??0)+1);
  const scopes=unindexedScopes.get(path)??[];
  let hasStructure=false;
  for(const scope of scopes){
    if(scope.type!=="file")hasStructure=true;
    if(scope.nameRange)record.namedScopes++;
    if(scope.type==="anonymous")record.anonymousScopes++;
    if(scope.type==="anonymous_class")record.anonymousClasses++;
    record.typedCallSites+=scope.calls?.length??0;
    record.unresolvedCallSites+=scope.unresolvedCalls?.length??0;
  }
  if(hasStructure)record.filesWithStructure++;
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
  unindexedSourceRoleSummary:roles,
  unindexedSubfolders:[...subfolders].sort((a,b)=>b[1]-a[1]).map(([path,count])=>({path,count})),
  astParsedUnindexedFiles:unindexedScopes.size,
  boundaries:"Directory role is a heuristic; AST scopes are syntax evidence only; only native SCIP counts as semantic indexed. No call edges inferred.",
  unindexedExamples:unindexed.slice(0,12),
},null,2));
