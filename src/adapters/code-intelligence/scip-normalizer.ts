import { createHash } from "node:crypto";
import {
  CODE_GRAPH_SCHEMA_VERSION,
  assertValidCodeGraphSnapshot,
  type CodeGraphSnapshot,
  type CodeNode,
  type CodeNodeKind,
  type CodeRelation,
  type CodeRelationKind,
} from "../../application/code-intelligence.js";

const SCIP_ROLE_DEFINITION = 1;
const SCIP_ROLE_IMPORT = 2;
const SCIP_ROLE_WRITE = 4;
const SCIP_ROLE_READ = 8;

interface ScipRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

interface ScipOccurrence {
  symbol: string;
  symbolRoles: number;
  range?: ScipRange;
  enclosingRange?: ScipRange;
}

interface ScipRelationship {
  symbol: string;
  isReference: boolean;
  isImplementation: boolean;
  isTypeDefinition: boolean;
  isDefinition: boolean;
}

interface ScipSymbolInformation {
  symbol: string;
  displayName?: string;
  kind?: string | number;
  signature?: string;
  enclosingSymbol?: string;
  documentation: string[];
  relationships: ScipRelationship[];
}

interface ScipDocument {
  relativePath: string;
  language?: string;
  occurrences: ScipOccurrence[];
  symbols: ScipSymbolInformation[];
}

export interface ScipJsonIndex {
  documents: ScipDocument[];
  externalSymbols: ScipSymbolInformation[];
}

export interface NormalizeScipGraphInput {
  projectId: string;
  rootPath: string;
  indexedAt: string;
  index: ScipJsonIndex;
  sourceTextByPath?: ReadonlyMap<string, string>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function field(object: Record<string, unknown>, camel: string, snake: string): unknown {
  return object[camel] ?? object[snake];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parsePackedRange(value: unknown): ScipRange | undefined {
  if (!Array.isArray(value) || (value.length !== 3 && value.length !== 4)) return undefined;
  const startLine = numberValue(value[0]);
  const startCharacter = numberValue(value[1]);
  const third = numberValue(value[2]);
  const fourth = value.length === 4 ? numberValue(value[3]) : undefined;
  if (startLine === undefined || startCharacter === undefined || third === undefined) return undefined;
  if (value.length === 3) {
    return { startLine, startCharacter, endLine: startLine, endCharacter: third };
  }
  if (fourth === undefined) return undefined;
  return { startLine, startCharacter, endLine: third, endCharacter: fourth };
}

function parseTypedRange(
  object: Record<string, unknown>,
  singleCamel: string,
  singleSnake: string,
  multiCamel: string,
  multiSnake: string,
): ScipRange | undefined {
  const single = record(field(object, singleCamel, singleSnake));
  if (single) {
    const startLine = numberValue(field(single, "startLine", "start_line"));
    const startCharacter = numberValue(field(single, "startCharacter", "start_character"));
    const endCharacter = numberValue(field(single, "endCharacter", "end_character"));
    if (startLine !== undefined && startCharacter !== undefined && endCharacter !== undefined) {
      return { startLine, startCharacter, endLine: startLine, endCharacter };
    }
  }
  const multi = record(field(object, multiCamel, multiSnake));
  if (multi) {
    const startLine = numberValue(field(multi, "startLine", "start_line"));
    const startCharacter = numberValue(field(multi, "startCharacter", "start_character"));
    const endLine = numberValue(field(multi, "endLine", "end_line"));
    const endCharacter = numberValue(field(multi, "endCharacter", "end_character"));
    if (startLine !== undefined && startCharacter !== undefined && endLine !== undefined && endCharacter !== undefined) {
      return { startLine, startCharacter, endLine, endCharacter };
    }
  }
  return undefined;
}

function parseOccurrence(value: unknown): ScipOccurrence | undefined {
  const object = record(value);
  if (!object) return undefined;
  const symbol = stringValue(object.symbol);
  if (!symbol) return undefined;
  const symbolRoles = numberValue(field(object, "symbolRoles", "symbol_roles")) ?? 0;
  const range = parseTypedRange(object, "singleLineRange", "single_line_range", "multiLineRange", "multi_line_range")
    ?? parsePackedRange(object.range);
  const enclosingRange = parseTypedRange(
    object,
    "singleLineEnclosingRange",
    "single_line_enclosing_range",
    "multiLineEnclosingRange",
    "multi_line_enclosing_range",
  ) ?? parsePackedRange(field(object, "enclosingRange", "enclosing_range"));
  return { symbol, symbolRoles, ...(range ? { range } : {}), ...(enclosingRange ? { enclosingRange } : {}) };
}

function parseRelationship(value: unknown): ScipRelationship | undefined {
  const object = record(value);
  if (!object) return undefined;
  const symbol = stringValue(object.symbol);
  if (!symbol) return undefined;
  return {
    symbol,
    isReference: booleanValue(field(object, "isReference", "is_reference")),
    isImplementation: booleanValue(field(object, "isImplementation", "is_implementation")),
    isTypeDefinition: booleanValue(field(object, "isTypeDefinition", "is_type_definition")),
    isDefinition: booleanValue(field(object, "isDefinition", "is_definition")),
  };
}

function parseSymbolInformation(value: unknown): ScipSymbolInformation | undefined {
  const object = record(value);
  if (!object) return undefined;
  const symbol = stringValue(object.symbol);
  if (!symbol) return undefined;
  const kind = field(object, "kind", "kind");
  const signatureObject = record(field(object, "signatureDocumentation", "signature_documentation"));
  const signature = signatureObject ? stringValue(signatureObject.text) : undefined;
  const displayName = stringValue(field(object, "displayName", "display_name"));
  const enclosingSymbol = stringValue(field(object, "enclosingSymbol", "enclosing_symbol"));
  const documentation = array(object.documentation)
    .map(stringValue)
    .filter((item): item is string => Boolean(item));
  return {
    symbol,
    ...(displayName ? { displayName } : {}),
    ...((typeof kind === "string" || typeof kind === "number") ? { kind } : {}),
    ...(signature ? { signature } : {}),
    ...(enclosingSymbol ? { enclosingSymbol } : {}),
    documentation,
    relationships: array(object.relationships).map(parseRelationship).filter((item): item is ScipRelationship => Boolean(item)),
  };
}

function parseDocument(value: unknown): ScipDocument | undefined {
  const object = record(value);
  if (!object) return undefined;
  const relativePath = stringValue(field(object, "relativePath", "relative_path"));
  if (!relativePath) return undefined;
  const language = stringValue(object.language);
  return {
    relativePath,
    ...(language ? { language } : {}),
    occurrences: array(object.occurrences).map(parseOccurrence).filter((item): item is ScipOccurrence => Boolean(item)),
    symbols: array(object.symbols).map(parseSymbolInformation).filter((item): item is ScipSymbolInformation => Boolean(item)),
  };
}

export function parseScipJsonIndex(value: unknown): ScipJsonIndex {
  const object = record(value);
  if (!object) throw new Error("SCIP JSON must be an object");
  const documents = array(object.documents).map(parseDocument).filter((item): item is ScipDocument => Boolean(item));
  const externalSymbols = array(field(object, "externalSymbols", "external_symbols"))
    .map(parseSymbolInformation)
    .filter((item): item is ScipSymbolInformation => Boolean(item));
  return { documents, externalSymbols };
}

function stableId(namespace: "node" | "relation", value: string): string {
  return `code:${namespace}:${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

const NUMERIC_KINDS = new Map<number, CodeNodeKind>([
  [7, "class"], [9, "constructor"], [11, "enum"], [15, "property"], [16, "file"],
  [17, "function"], [21, "interface"], [26, "method"], [29, "module"], [30, "namespace"],
  [35, "package"], [41, "property"], [49, "type"], [54, "type"], [55, "type"], [61, "variable"],
  [66, "method"], [67, "method"], [68, "method"], [69, "method"], [70, "method"], [71, "method"],
  [80, "method"], [81, "property"], [82, "variable"],
]);

function documentationSignatureLine(info: ScipSymbolInformation | undefined): string | undefined {
  for (const block of info?.documentation ?? []) {
    const lines = block.split(/\r?\n/);
    let insideFence = false;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.startsWith("```")) {
        insideFence = !insideFence;
        continue;
      }
      if (insideFence && line) return line;
    }
  }
  return undefined;
}

function documentedKind(line: string | undefined, symbol: string): CodeNodeKind | undefined {
  if (!line) return undefined;
  if (/^module\b/.test(line)) return "module";
  if (/^namespace\b/.test(line)) return "namespace";
  if (/^class\b/.test(line)) return "class";
  if (/^interface\b/.test(line)) return "interface";
  if (/^enum\b/.test(line)) return "enum";
  if (/^type\b/.test(line)) return "type";
  if (/^function\b/.test(line)) return "function";
  if (/^constructor\s*\(/.test(line)) return "constructor";
  if (/^\(method\)\s+/.test(line)) return "method";
  if (/^(?:get|set)\s+/.test(line)) return "property";
  if (/^\(property\)\s+/.test(line)) return "property";
  if (/^(?:var|let|const)\b/.test(line)) return "variable";
  if (/^\(parameter\)\s+/.test(line)) return "variable";
  if (/^[A-Za-z_$][\w$]*\s*:\s*/.test(line) && /\.\[[^\]]+\]$/.test(symbol)) return "type";
  return undefined;
}

function normalizeKind(info: ScipSymbolInformation | undefined, symbol: string): CodeNodeKind {
  const kind = info?.kind;
  if (typeof kind === "number") {
    const normalized = NUMERIC_KINDS.get(kind);
    if (normalized) return normalized;
  }
  if (typeof kind === "string") {
    switch (kind.replace(/^Kind_/, "").replace(/^Unspecified/, "").toLowerCase()) {
      case "class": return "class";
      case "interface": return "interface";
      case "function": return "function";
      case "method": case "staticmethod": case "abstractmethod": case "methodspecification": return "method";
      case "constructor": return "constructor";
      case "property": case "field": case "staticproperty": return "property";
      case "variable": case "staticvariable": case "constant": return "variable";
      case "type": case "typealias": case "struct": case "trait": case "protocol": return "type";
      case "enum": return "enum";
      case "module": return "module";
      case "namespace": return "namespace";
      case "package": return "package";
      case "file": return "file";
    }
  }
  const fromDocumentation = documentedKind(documentationSignatureLine(info), symbol);
  if (fromDocumentation) return fromDocumentation;
  if (/\(\)\.?$/.test(symbol)) return "method";
  if (/#(?:[^/#.]+)#$/.test(symbol)) return "type";
  return "unknown";
}

function documentedDisplayName(line: string | undefined, symbol: string): string | undefined {
  if (!line) return undefined;
  const quotedModule = line.match(/^module\s+["']([^"']+)["']/);
  if (quotedModule?.[1]) return quotedModule[1];
  const declared = line.match(/^(?:interface|type|class|enum|namespace|function|var|let|const)\s+([^\s(<:]+)/);
  if (declared?.[1]) return declared[1];
  const annotated = line.match(/^\((?:property|method|parameter)\)\s+([^\s(:]+)/);
  if (annotated?.[1]) return annotated[1];
  const accessor = line.match(/^(?:get|set)\s+([^\s(:]+)/);
  if (accessor?.[1]) return accessor[1];
  if (/^constructor\s*\(/.test(line)) return "constructor";
  const generic = line.match(/^([A-Za-z_$][\w$]*)\s*:\s*/);
  if (generic?.[1] && /\.\[[^\]]+\]$/.test(symbol)) return generic[1];
  return undefined;
}

function fallbackDisplayName(symbol: string): string {
  if (symbol.startsWith("local ")) return symbol;
  const withoutMethodSuffix = symbol.replace(/\(.*\)\.?$/, "").replace(/[.#/]$/, "");
  const match = withoutMethodSuffix.match(/(?:^|[\s/#.])(`[^`]+`|[^\s/#.]+)$/);
  return match?.[1]?.replace(/^`|`$/g, "") ?? symbol;
}

function comparePosition(lineA: number, characterA: number, lineB: number, characterB: number): number {
  return lineA === lineB ? characterA - characterB : lineA - lineB;
}

function rangeContains(outer: ScipRange, inner: ScipRange): boolean {
  return comparePosition(outer.startLine, outer.startCharacter, inner.startLine, inner.startCharacter) <= 0
    && comparePosition(outer.endLine, outer.endCharacter, inner.endLine, inner.endCharacter) >= 0;
}

function rangeSpan(range: ScipRange): number {
  return (range.endLine - range.startLine) * 1_000_000 + range.endCharacter - range.startCharacter;
}

function lineStartOffsets(source: string): number[] {
  const offsets = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) offsets.push(index + 1);
  }
  return offsets;
}

function isCallOccurrence(source: string, lineStarts: readonly number[], range: ScipRange): boolean {
  const lineStart = lineStarts[range.endLine];
  if (lineStart === undefined) return false;
  let offset = lineStart + range.endCharacter;
  if (offset < 0 || offset > source.length) return false;

  while (offset < source.length && /\s/.test(source[offset]!)) offset += 1;
  if (source.startsWith("?.", offset)) {
    offset += 2;
    while (offset < source.length && /\s/.test(source[offset]!)) offset += 1;
  }
  return source[offset] === "(";
}

interface DefinitionRecord {
  symbol: string;
  document: ScipDocument;
  occurrence: ScipOccurrence;
  nodeId: string;
}

function relationKindForRoles(roles: number): CodeRelationKind {
  if ((roles & SCIP_ROLE_IMPORT) !== 0) return "imports";
  if ((roles & SCIP_ROLE_WRITE) !== 0) return "writes";
  if ((roles & SCIP_ROLE_READ) !== 0) return "reads";
  return "depends_on";
}

function addRelation(
  output: Map<string, CodeRelation>,
  from: string,
  to: string,
  kind: CodeRelationKind,
  confidence = 1,
): void {
  if (from === to) return;
  const identity = `${from}->${kind}->${to}`;
  if (output.has(identity)) return;
  output.set(identity, { id: stableId("relation", identity), from, to, kind, confidence });
}

export function normalizeScipGraph(input: NormalizeScipGraphInput): CodeGraphSnapshot {
  const infoBySymbol = new Map<string, ScipSymbolInformation>();
  for (const info of input.index.externalSymbols) infoBySymbol.set(info.symbol, info);
  for (const document of input.index.documents) {
    for (const info of document.symbols) infoBySymbol.set(info.symbol, info);
  }

  const definitions: DefinitionRecord[] = [];
  const nodeBySymbol = new Map<string, CodeNode>();
  for (const document of input.index.documents) {
    for (const occurrence of document.occurrences) {
      if ((occurrence.symbolRoles & SCIP_ROLE_DEFINITION) === 0 || !occurrence.range) continue;
      if (nodeBySymbol.has(occurrence.symbol)) continue;
      const info = infoBySymbol.get(occurrence.symbol);
      const canonicalIdentity = `scip:${occurrence.symbol}`;
      const nodeId = stableId("node", canonicalIdentity);
      const location = {
        path: document.relativePath,
        startLine: occurrence.range.startLine + 1,
        startColumn: occurrence.range.startCharacter + 1,
        endLine: occurrence.range.endLine + 1,
        endColumn: occurrence.range.endCharacter + 1,
      };
      const node: CodeNode = {
        id: nodeId,
        kind: normalizeKind(info, occurrence.symbol),
        name: info?.displayName
          ?? documentedDisplayName(documentationSignatureLine(info), occurrence.symbol)
          ?? fallbackDisplayName(occurrence.symbol),
        canonicalIdentity,
        ...(document.language ? { language: document.language } : {}),
        location,
        ...(info?.signature ? { signature: info.signature } : {}),
      };
      nodeBySymbol.set(occurrence.symbol, node);
      definitions.push({ symbol: occurrence.symbol, document, occurrence, nodeId });
    }
  }

  const definitionsByDocument = new Map<ScipDocument, DefinitionRecord[]>();
  for (const definition of definitions) {
    const items = definitionsByDocument.get(definition.document) ?? [];
    items.push(definition);
    definitionsByDocument.set(definition.document, items);
  }

  const relations = new Map<string, CodeRelation>();

  for (const [symbol, info] of infoBySymbol) {
    const from = nodeBySymbol.get(symbol)?.id;
    if (!from) continue;
    for (const relationship of info.relationships) {
      const to = nodeBySymbol.get(relationship.symbol)?.id;
      if (!to) continue;
      if (relationship.isImplementation) addRelation(relations, from, to, "implements");
      if (relationship.isTypeDefinition) addRelation(relations, from, to, "references_type");
      if (relationship.isReference && !relationship.isImplementation) addRelation(relations, from, to, "depends_on");
      if (relationship.isDefinition) addRelation(relations, from, to, "depends_on");
    }
  }

  for (const document of input.index.documents) {
    const documentDefinitions = definitionsByDocument.get(document) ?? [];
    const source = input.sourceTextByPath?.get(document.relativePath);
    const lineStarts = source ? lineStartOffsets(source) : undefined;
    for (const occurrence of document.occurrences) {
      if ((occurrence.symbolRoles & SCIP_ROLE_DEFINITION) !== 0 || !occurrence.range) continue;
      const target = nodeBySymbol.get(occurrence.symbol)?.id;
      if (!target) continue;
      const owners = documentDefinitions
        .filter((definition) => definition.occurrence.enclosingRange && rangeContains(definition.occurrence.enclosingRange, occurrence.range!))
        .sort((left, right) => rangeSpan(left.occurrence.enclosingRange!) - rangeSpan(right.occurrence.enclosingRange!));
      const owner = owners[0]?.nodeId;
      if (!owner) continue;
      const relationKind = source && lineStarts && isCallOccurrence(source, lineStarts, occurrence.range)
        ? "calls"
        : relationKindForRoles(occurrence.symbolRoles);
      addRelation(relations, owner, target, relationKind, relationKind === "calls" ? 1 : 0.9);
    }
  }

  const snapshot: CodeGraphSnapshot = {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId: input.projectId,
    rootPath: input.rootPath,
    indexedAt: input.indexedAt,
    nodes: [...nodeBySymbol.values()],
    relations: [...relations.values()],
  };
  assertValidCodeGraphSnapshot(snapshot);
  return snapshot;
}
