// Same-checkout AST vs native SCIP evidence audit. Read-only BookStack fixture only.
import { existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FileSystemCodeFileInventory } from "../dist/src/adapters/code-intelligence/file-inventory.js";
import { BundledScipIndexReader } from "../dist/src/adapters/code-intelligence/scip-provider.js";
import { extractPhpLexicalScopes } from "../dist/src/adapters/code-intelligence/php-lexical-scopes.js";

const root = resolve(process.argv[2] ?? "");
if (!root.startsWith("/tmp/questboard-s7-bookstack-")
    || !existsSync(join(root, ".git")) || !existsSync(join(root, "composer.lock"))
    || !existsSync(join(root, "vendor", "autoload.php"))) {
  throw Error("Only a disposable, Composer-installed BookStack checkout is allowed");
}
const inventory = await new FileSystemCodeFileInventory().listFiles(root);
const phpPaths = inventory.filter(item => item.path.endsWith(".php")).map(item => item.path);
const candidates = readdirSync(tmpdir()).filter(name => name.startsWith("questboard-s7-php-scip-"))
  .map(name => join(tmpdir(), name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
let artifact;
for (const candidate of candidates) {
  for (const child of readdirSync(candidate)) {
    const path = join(candidate, child, "index.scip");
    if (existsSync(path) && statSync(path).size > 1_000_000) { artifact = path; break; }
  }
  if (artifact) break;
}
if (!artifact) throw Error("No isolated native SCIP artifact exists");
const index = await new BundledScipIndexReader().read(artifact);
const documents = new Map(index.documents.map(doc => [doc.relativePath, doc]));
const scopes = await extractPhpLexicalScopes(root, phpPaths);
const counts = {
  indexedPhp: documents.size, firstPartyPhp: phpPaths.length, parsedPhp: scopes.size,
  astNamedScopesInIndexed: 0, astDefinitionStartMatches: 0, astDefinitionUnmatched: 0,
  astAnonymousScopesInIndexed: 0, astTypedCallSitesInIndexed: 0,
  astTypedCallSitesWithNativeReferenceStart: 0, astTypedCallSitesWithoutNativeReferenceStart: 0,
  astUnresolvedCallSitesInIndexed: 0, unindexedPhp: 0,
  unindexedNamedScopes: 0, unindexedAnonymousScopes: 0,
  unindexedTypedCallSites: 0, unindexedUnresolvedCallSites: 0,
};
const mismatchExamples = [];
const callMismatchExamples = [];
for (const path of phpPaths) {
  const doc = documents.get(path);
  const scoped = scopes.get(path) ?? [];
  if (!doc) counts.unindexedPhp++;
  const definitions = new Set((doc?.occurrences ?? [])
    .filter(o => (o.symbolRoles & 1) !== 0 && o.range)
    .map(o => o.range.startLine + ":" + o.range.startCharacter));
  const references = new Set((doc?.occurrences ?? [])
    .filter(o => (o.symbolRoles & 1) === 0 && o.range)
    .map(o => o.range.startLine + ":" + o.range.startCharacter));
  for (const scope of scoped) {
    const typed = scope.calls?.length ?? 0;
    const unresolved = scope.unresolvedCalls?.length ?? 0;
    if (!doc) {
      if (scope.nameRange) counts.unindexedNamedScopes++;
      if (scope.type === "anonymous") counts.unindexedAnonymousScopes++;
      counts.unindexedTypedCallSites += typed;
      counts.unindexedUnresolvedCallSites += unresolved;
      continue;
    }
    if (scope.nameRange) {
      counts.astNamedScopesInIndexed++;
      const key = scope.nameRange[0] + ":" + scope.nameRange[1];
      if (definitions.has(key)) counts.astDefinitionStartMatches++;
      else {
        counts.astDefinitionUnmatched++;
        if (mismatchExamples.length < 8) mismatchExamples.push({ path, name: scope.name, type: scope.type, at: key });
      }
    }
    if (scope.type === "anonymous") counts.astAnonymousScopesInIndexed++;
    counts.astTypedCallSitesInIndexed += typed;
    counts.astUnresolvedCallSitesInIndexed += unresolved;
    for (const call of scope.calls ?? []) {
      const key = call.nameRange[0] + ":" + call.nameRange[1];
      if (references.has(key)) counts.astTypedCallSitesWithNativeReferenceStart++;
      else {
        counts.astTypedCallSitesWithoutNativeReferenceStart++;
        if (callMismatchExamples.length < 8) callMismatchExamples.push({ path, className: call.className, name: call.name, at: key });
      }
    }
  }
}
if (scopes.size !== phpPaths.length || documents.size > phpPaths.length)
  throw Error("Incomplete AST extraction or incompatible SCIP source inventory");
console.log(JSON.stringify({
  status: "same_checkout_ast_scip_audited",
  comparison: "same BookStack checkout, AST parser vs native SCIP locations; call position match is not target identity proof",
  indexArtifactBytes: statSync(artifact).size, counts, mismatchExamples, callMismatchExamples,
}, null, 2));
