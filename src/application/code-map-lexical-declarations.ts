// Conservative syntax-only declarations for languages without an installed SCIP provider.
// These are source-position facts, not AST semantic resolution or inferred call edges.
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { CodeFileInventoryEntry } from "./code-map-hierarchy.js";
import type { CodeGraphSnapshot, CodeNode, CodeRelation } from "./code-intelligence.js";
import { inferCodeLanguageFromPath } from "./code-map-hierarchy.js";

const MAX_SOURCE_BYTES = 512 * 1024;
const PROVENANCE = [{ providerId: "questboard:lexical-declarations", fidelity: "syntax" as const,
  freshness: "fresh" as const }];
type Declaration = { name: string; kind: CodeNode["kind"]; line: number; column: number };

function sourceDeclarations(source: string, language: string): Declaration[] {
  const result: Declaration[] = [];
  let blockComment = false;
  let stringDelimiter: string | undefined;
  let hereDoc: string | undefined;
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const original = lines[index]!;
    const line = original.trim();
    if (hereDoc) {
      if (line === hereDoc) hereDoc = undefined;
      continue;
    }
    if (stringDelimiter) {
      if (line.includes(stringDelimiter)) stringDelimiter = undefined;
      continue;
    }
    if (blockComment) {
      if (line.includes(language === "powershell" ? "#>" : "*/")) blockComment = false;
      continue;
    }
    if (language === "shellscript") {
      const start = line.match(/<<-?\s*['"]?([A-Za-z_][\w]*)['"]?/);
      if (start) { hereDoc = start[1]; continue; }
    }
    const commentStart = language === "powershell" ? line.indexOf("<#") : line.indexOf("/*");
    if (commentStart >= 0) {
      if (!line.includes(language === "powershell" ? "#>" : "*/", commentStart + 2)) blockComment = true;
      continue;
    }
    if (line.startsWith("//") || line.startsWith("#") || line.startsWith("*")) continue;
    if (language === "swift" && line.includes('"""')) {
      if (line.indexOf('"""') === line.lastIndexOf('"""')) stringDelimiter = '"""';
      continue;
    }
    const powershellHereString = language === "powershell" ? line.match(/@(["'])\s*$/) : null;
    if (powershellHereString) {
      stringDelimiter = powershellHereString[1] === "'" ? "'@" : '"@';
      continue;
    }
    if (language === "csharp" && line.includes('"""')) {
      if (line.indexOf('"""') === line.lastIndexOf('"""')) stringDelimiter = '"""';
      continue;
    }
    if (language === "csharp" && line.includes('@"')) {
      // Skip C# verbatim string bodies rather than treating their contents as declarations.
      const rest = line.slice(line.indexOf('@"') + 2);
      if (!rest.includes('"')) stringDelimiter = '"';
      continue;
    }
    let match: RegExpMatchArray | null = null;
    let kind: CodeNode["kind"] = "function";
    if (language === "powershell") {
      match = line.match(/^(?:function|filter)\s+([A-Za-z_][\w:-]*)\s*(?:\{|$)/i);
    } else if (language === "shellscript") {
      match = line.match(/^(?:function\s+)?([A-Za-z_][\w]*)\s*\(\s*\)\s*\{/);
      if (!match) match = line.match(/^function\s+([A-Za-z_][\w]*)\s*\{/);
    } else if (language === "swift") {
      match = line.match(/^(?:(?:public|private|fileprivate|internal|open|final|static|override|mutating|nonmutating|class|indirect|convenience|required)\s+)*(class|struct|protocol|enum|func)\s+([A-Za-z_][\w]*)\b/);
      if (match) kind = match[1] === "func" ? "function" : match[1] === "protocol" ? "interface" : match[1] === "enum" ? "enum" : "class";
    } else if (language === "csharp") {
      match = line.match(/^(?:(?:public|private|protected|internal|static|sealed|partial|abstract|readonly|unsafe|new|file)\s+)*(class|struct|interface|enum|record)\s+([A-Za-z_][\w]*)\b/);
      if (match) kind = match[1] === "interface" ? "interface" : match[1] === "enum" ? "enum" : "class";
    }
    if (!match) continue;
    const name = language === "swift" || language === "csharp" ? match[2]! : match[1]!;
    // Skip declarations with quote-delimited/ambiguous tokens.
    const col = original.indexOf(name);
    if (col < 0) continue;
    result.push({ name, kind, line: index + 1, column: col + 1 });
  }
  return result;
}

export async function addConservativeSourceDeclarations(
  graph: CodeGraphSnapshot, inventory: readonly CodeFileInventoryEntry[], rootPath: string,
): Promise<CodeGraphSnapshot> {
  const root = resolve(rootPath);
  const fileNodes = new Map(graph.nodes.filter((node) => node.kind === "file" && node.location?.path)
    .map((node) => [node.location!.path, node] as const));
  const nodes: CodeNode[] = [];
  const relations: CodeRelation[] = [];
  const existing = new Set(graph.nodes.map((node) => node.id));
  for (const entry of inventory) {
    const language = inferCodeLanguageFromPath(entry.path);
    if (!language || !["swift", "powershell", "shellscript", "csharp"].includes(language)) continue;
    if (entry.path.startsWith("/") || entry.path.split("/").includes("..")) continue;
    const file = fileNodes.get(entry.path);
    if (!file) continue;
    const path = resolve(root, entry.path);
    if (!path.startsWith(root + sep)) continue;
    let contents: string;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) continue;
      contents = await readFile(path, "utf8");
      if (contents.includes("\0")) continue;
    } catch { continue; } // A disappearing or unreadable source remains file-only.
    for (const decl of sourceDeclarations(contents, language)) {
      const identity = ["syntax-declaration", entry.path, decl.kind, decl.name, decl.line, decl.column].join(":");
      const id = "code:node:" + createHash("sha256").update(identity).digest("hex").slice(0, 24);
      if (existing.has(id)) continue;
      existing.add(id);
      nodes.push({ id, kind: decl.kind, name: decl.name, canonicalIdentity: identity, language,
        location: { path: entry.path, startLine: decl.line, startColumn: decl.column },
        signature: "Conservative lexical declaration; not AST or SCIP semantic coverage",
        provenance: PROVENANCE });
      const relIdentity = file.id + ":contains:" + id;
      relations.push({ id: "code:relation:" + createHash("sha256").update(relIdentity).digest("hex").slice(0, 24),
        from: file.id, to: id, kind: "contains", confidence: 1, provenance: PROVENANCE,
        evidence: [{ location: { path: entry.path, startLine: decl.line, startColumn: decl.column },
          label: "Source declaration token (syntax only)" }] });
    }
  }
  return nodes.length ? { ...graph, nodes: [...graph.nodes, ...nodes],
    relations: [...graph.relations, ...relations] } : graph;
}
