// Read-only comparison of native SCIP, PHP AST and actual Code Map call evidence.
// Never indexes, writes snapshots, touches QuestBoard DB or invents call targets.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BundledScipIndexReader } from "../dist/src/adapters/code-intelligence/scip-provider.js";
import { extractPhpLexicalScopes } from "../dist/src/adapters/code-intelligence/php-lexical-scopes.js";
import { normalizeScipGraph } from "../dist/src/adapters/code-intelligence/scip-normalizer.js";
import { FileSystemCodeFileInventory } from "../dist/src/adapters/code-intelligence/file-inventory.js";

const root = resolve(process.argv[2] ?? "");
if (!root.startsWith("/tmp/questboard-s7-bookstack-")
  || !existsSync(join(root, ".git")) || !existsSync(join(root, "composer.lock"))
  || !existsSync(join(root, "vendor", "autoload.php"))) {
  throw Error("Only a disposable installed BookStack fixture is permitted");
}
const artifacts = [];
for (const entry of readdirSync(tmpdir()).filter(name => name.startsWith("questboard-s7-php-scip-"))) {
  const directory = join(tmpdir(), entry);
  for (const sub of readdirSync(directory)) {
    const candidate = join(directory, sub, "index.scip");
    if (existsSync(candidate) && statSync(candidate).size > 1_000_000) artifacts.push(candidate);
  }
}
if (!artifacts.length) throw Error("No retained isolated native SCIP index");
const artifact = artifacts.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
const index = await new BundledScipIndexReader().read(artifact);
const paths = index.documents.map(doc => doc.relativePath);
const scopes = await extractPhpLexicalScopes(root, paths);
const sourceTextByPath = new Map(paths.map(path => [path, readFileSync(join(root, path), "utf8")]));
const graph = normalizeScipGraph({
  projectId: "s7-php-call-audit", rootPath: root, indexedAt: "2026-11-04T00:00:00Z",
  providerId: "scip-php", index, phpLexicalScopes: scopes, sourceTextByPath,
});
const pos = (path, range) => `${path}:${range[0] + 1}:${range[1] + 1}`;
const norm = name => name.replace(/^\\+/, "").toLowerCase();
const key = (className, method) => `${norm(className)}::${method.toLowerCase()}`;
const nodeAt = new Map();
for (const node of graph.nodes) {
  const loc = node.location;
  if (loc?.startLine && loc.startColumn) {
    const id = `${loc.path}:${loc.startLine}:${loc.startColumn}`;
    const values = nodeAt.get(id) ?? [];
    values.push(node);
    nodeAt.set(id, values);
  }
}
const methods = new Map();
const ancestors = new Map();
const owners = new Map();
for (const [path, list] of scopes) {
  for (const scope of list) {
    if (scope.type === "class" && scope.className) {
      ancestors.set(norm(scope.className), (scope.ancestors ?? []).map(x => norm(x.className)));
    }
    if (scope.nameRange && (scope.type === "method" || scope.type === "function")) {
      const matches = (nodeAt.get(pos(path, scope.nameRange)) ?? []).filter(node =>
        node.name.toLowerCase() === scope.name?.toLowerCase()
        && ["method", "function", "constructor"].includes(node.kind));
      if (matches.length === 1) {
        owners.set(`${path}:${scope.range.join(":")}`, matches[0].id);
        if (scope.type === "method" && scope.className) {
          const k = key(scope.className, scope.name);
          const old = methods.get(k);
          methods.set(k, old === undefined ? matches[0].id : old === matches[0].id ? old : null);
        }
      }
    } else if (scope.type === "anonymous") {
      const matches = (nodeAt.get(pos(path, scope.range)) ?? []).filter(node =>
        node.name === `closure@${scope.range[0] + 1}:${scope.range[1] + 1}`);
      if (matches.length === 1) owners.set(`${path}:${scope.range.join(":")}`, matches[0].id);
    }
  }
}
function targetFor(className, method) {
  let frontier = [norm(className)];
  const visited = new Set();
  for (let depth = 0; depth < 24 && frontier.length; depth++) {
    const next = [];
    const found = new Set();
    for (const name of frontier) {
      if (visited.has(name)) continue;
      visited.add(name);
      const k = key(name, method);
      if (methods.has(k)) {
        const value = methods.get(k);
        if (!value) return null;
        found.add(value);
      } else next.push(...(ancestors.get(name) ?? []));
    }
    if (found.size > 1) return null;
    if (found.size === 1) return [...found][0];
    frontier = next;
  }
  return null;
}
const edgesBySite = new Map();
for (const edge of graph.relations.filter(r => r.kind === "calls")) {
  for (const item of edge.evidence ?? []) {
    const loc = item.location;
    if (!loc?.startLine || !loc.startColumn) continue;
    const id = `${loc.path}:${loc.startLine}:${loc.startColumn}`;
    const list = edgesBySite.get(id) ?? [];
    list.push({ from: edge.from, to: edge.to });
    edgesBySite.set(id, list);
  }
}
const counts = { indexedPhp: index.documents.length, graphCalls: graph.relations.filter(r => r.kind === "calls").length,
  typedSites: 0, nativePositionPresent: 0, graphCallAtPosition: 0,
  alreadyConnected: 0, noVerifiedTarget: 0, ownerUnverified: 0,
  otherCallAtPosition: 0, nativePositionWithoutCall: 0, uniquelyVerifiableMissing: 0 };
const samples = [];
for (const document of index.documents) {
  const path = document.relativePath;
  const native = new Set(document.occurrences.filter(o => (o.symbolRoles & 1) === 0 && o.range)
    .map(o => `${path}:${o.range.startLine + 1}:${o.range.startCharacter + 1}`));
  for (const scope of scopes.get(path) ?? []) {
    for (const call of scope.calls ?? []) {
      counts.typedSites++;
      const site = pos(path, call.nameRange);
      const present = native.has(site);
      if (present) counts.nativePositionPresent++;
      const edges = edgesBySite.get(site) ?? [];
      if (edges.length) counts.graphCallAtPosition++;
      const owner = owners.get(`${path}:${scope.range.join(":")}`);
      const target = targetFor(call.className, call.name);
      if (target && owner && edges.some(edge => edge.to === target && edge.from === owner)) {
        counts.alreadyConnected++;
      } else if (!target) counts.noVerifiedTarget++;
      else if (!owner || scope.type === "file") counts.ownerUnverified++;
      else if (edges.length) counts.otherCallAtPosition++;
      else if (present) counts.nativePositionWithoutCall++;
      else {
        counts.uniquelyVerifiableMissing++;
        if (samples.length < 20) samples.push({ path, at: site.slice(path.length + 1), className: call.className,
          method: call.name, owner, target });
      }
    }
  }
}
const eligible = (await new FileSystemCodeFileInventory().listFiles(root))
  .filter(entry => entry.path.endsWith(".php")).map(entry => entry.path);
const indexed = new Set(paths);
const missing = eligible.filter(path => !indexed.has(path));
const unindexedScopes = await extractPhpLexicalScopes(root, missing);
const gaps = { files: missing.length, namedScopes: 0, anonymousScopes: 0,
  fileScopes: 0, typedSites: 0, unresolvedSites: 0, uniqueNativeTargets: 0,
  missingNativeTargets: 0, fileLevelUniqueTargets: 0, namedUniqueTargets: 0,
  anonymousUniqueTargets: 0, folders: {} };
const gapSamples = [];
for (const [path, list] of unindexedScopes) {
  const folder = path.split("/")[0];
  const group = gaps.folders[folder] ??= { files: 0, namedScopes: 0, anonymousScopes: 0,
    typedSites: 0, unresolvedSites: 0, uniqueNativeTargets: 0 };
  group.files++;
  for (const scope of list) {
    if (scope.nameRange) { gaps.namedScopes++; group.namedScopes++; }
    if (scope.type === "anonymous") { gaps.anonymousScopes++; group.anonymousScopes++; }
    if (scope.type === "file") gaps.fileScopes++;
    const typed = scope.calls ?? [];
    const unresolved = scope.unresolvedCalls?.length ?? 0;
    gaps.typedSites += typed.length;
    gaps.unresolvedSites += unresolved;
    group.typedSites += typed.length;
    group.unresolvedSites += unresolved;
    for (const call of typed) {
      const target = targetFor(call.className, call.name);
      if (!target) { gaps.missingNativeTargets++; continue; }
      gaps.uniqueNativeTargets++;
      group.uniqueNativeTargets++;
      if (scope.type === "file") gaps.fileLevelUniqueTargets++;
      if (scope.type === "anonymous") gaps.anonymousUniqueTargets++;
      if (scope.nameRange) gaps.namedUniqueTargets++;
      if (gapSamples.length < 12) gapSamples.push({ path, scope: scope.type,
        call: call.name, receiver: call.className, at: pos(path, call.nameRange).slice(path.length + 1) });
    }
  }
}
console.log(JSON.stringify({ status: "read_only_graph_call_evidence_audit", indexBytes: statSync(artifact).size,
  counts, samples, unindexed: gaps, unindexedExamples: gapSamples,
  caveat: "Unique native target is AST+indexed-SCIP declaration evidence only; unindexed files have no native SCIP owner evidence and are not semantic-indexed. Do not infer coverage completion or add edges automatically." }, null, 2));