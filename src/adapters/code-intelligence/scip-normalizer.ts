import { createHash } from "node:crypto";
import ts from "typescript";
import {
  CODE_GRAPH_SCHEMA_VERSION,
  assertValidCodeGraphSnapshot,
  normalizeCodeLanguage,
  type CodeFidelityLevel,
  type CodeGraphSnapshot,
  type CodeNode,
  type CodeNodeKind,
  type CodeSourceLocation,
  type CodeRelation,
  type CodeRelationKind,
} from "../../application/code-intelligence.js";
import { inferCodeLanguageFromPath } from "../../application/code-map-hierarchy.js";

const SCIP_ROLE_DEFINITION = 1;
const SCIP_ROLE_IMPORT = 2;
const SCIP_ROLE_WRITE = 4;
const SCIP_ROLE_READ = 8;
const MAX_SOURCE_REGISTRATIONS_PER_DOCUMENT = 100;
const MAX_REGISTRATION_SOURCE_LENGTH = 3_000_000;
const MAX_REGISTRATION_CALL_SITES_PER_DOCUMENT = 8_000;
const MAX_REGISTRATION_INLINE_CALLBACKS_PER_DOCUMENT = 512;
const MAX_REGISTRATION_CALLBACK_DEPTH = 2;
const SOURCE_REGISTRATION_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

interface ScipRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

/** PHP Parser 5 lexical functions/methods, with anonymous nested scopes acting as ownership barriers. */
export interface ScipPhpTypedMethodCall {
  className: string;
  name: string;
  nameRange: readonly [number, number, number, number];
  evidenceSource?: "native" | "docblock";
}

export interface ScipPhpUnresolvedMethodCall {
  name: string;
  nameRange: readonly [number, number, number, number];
}

export interface ScipPhpTypedPropertyAccess {
  className: string;
  name: string;
  nameRange: readonly [number, number, number, number];
  kind: "reads" | "writes";
  evidenceSource?: "native" | "docblock";
}

export interface ScipPhpLexicalScope {
  type: "function" | "method" | "anonymous" | "class" | "file";
  range: readonly [number, number, number, number];
  name?: string;
  nameRange?: readonly [number, number, number, number];
  /** Fully qualified class, resolved by PHP Parser NameResolver. */
  className?: string;
  /** PHP Parser verified declaration flags, never inferred from a SCIP method name. */
  isStatic?: boolean;
  isConcretePublic?: boolean;
  /** Directly owned AST method calls with a statically proved receiver type. */
  calls?: readonly ScipPhpTypedMethodCall[];
  unresolvedCalls?: readonly ScipPhpUnresolvedMethodCall[];
  ancestors?: readonly { className: string; relation: "extends" | "implements" | "trait" }[];
  propertyDefinitions?: readonly { name: string; nameRange: readonly [number, number, number, number] }[];
  constantDefinitions?: readonly {
    name: string;
    nameRange: readonly [number, number, number, number];
    kind: "constant" | "enum_case";
  }[];
  /** Explicit @method tokens belonging to this class's PHPDoc, never inferred from names. */
  docMethods?: readonly { name: string; nameRange: readonly [number, number, number, number]; isStatic: boolean }[];
  propertyAccesses?: readonly ScipPhpTypedPropertyAccess[];
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
  /** SCIP enum: 1 = UTF8 byte offsets, 2 = UTF16 code units. */
  positionEncoding?: number | string;
}

export interface NormalizeScipGraphInput {
  projectId: string;
  rootPath: string;
  indexedAt: string;
  index: ScipJsonIndex;
  sourceTextByPath?: ReadonlyMap<string, string>;
  /** Optional first-party PHP file inventory. Installed dependency SCIP docs remain facts, not indexed first-party coverage. */
  phpEligibleFilePaths?: readonly string[];
  /** Verified PHP AST extents; SCIP PHP currently emits no enclosingRange. */
  phpLexicalScopes?: ReadonlyMap<string, readonly ScipPhpLexicalScope[]>;
  providerId?: string;
  fidelity?: CodeFidelityLevel;
  /** SHA-256 of the actual index.scip bytes; do not substitute a source hash. */
  indexArtifactSha256?: string | undefined;
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

function tupleRange(tuple: readonly [number, number, number, number]): ScipRange {
  return {
    startLine: tuple[0], startCharacter: tuple[1],
    endLine: tuple[2], endCharacter: tuple[3],
  };
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
  // The generated SCIP protobuf decoder encodes Language enum values as
  // numeric strings ("19" = PHP). Treating that as a programming-language
  // name makes semantic PHP documents invisible to coverage and file filters.
  // Prefer the verified PHP enum; other numeric enum values conservatively
  // fall back to their source filename extension, never a fake "19" language.
  const rawLanguage = object.language;
  const textualLanguage = stringValue(rawLanguage);
  const language = (rawLanguage === 19 || textualLanguage === "19")
    ? "php"
    : (typeof rawLanguage === "number" || /^\d+$/.test(textualLanguage ?? ""))
      ? inferCodeLanguageFromPath(relativePath)
      : textualLanguage;
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
  const positionEncoding = field(object, "positionEncoding", "position_encoding");
  return { documents, externalSymbols,
    ...((typeof positionEncoding === "number" || typeof positionEncoding === "string") ? { positionEncoding } : {}),
  };
}

function stableId(namespace: "node" | "relation", value: string): string {
  return `code:${namespace}:${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

const NUMERIC_KINDS = new Map<number, CodeNodeKind>([
  [7, "class"], [8, "variable"], [9, "constructor"], [11, "enum"],
  [12, "property"], [15, "property"], [16, "file"],
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
      case "property": case "field": case "staticproperty": case "enummember": case "enumcase": return "property";
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
  if (/\(\)\.\(\$[A-Za-z_][A-Za-z0-9_]*\)\.?$/.test(symbol)) return "variable";
  if (/#(?:\$[A-Za-z_][A-Za-z0-9_]*)\.?$/.test(symbol)) return "property";
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
  const phpParameter = symbol.match(/\(\)\.\((\$[A-Za-z_][A-Za-z0-9_]*)\)\.?$/);
  if (phpParameter) return phpParameter[1]!;
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

function nativeLocation(path: string, range: ScipRange): CodeSourceLocation {
  return {
    path,
    startLine: range.startLine + 1,
    startColumn: range.startCharacter + 1,
    endLine: range.endLine + 1,
    endColumn: range.endCharacter + 1,
  };
}

function lineStartOffsets(source: string): number[] {
  const offsets = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) offsets.push(index + 1);
  }
  return offsets;
}

function sourcePositionAtOffset(lineStarts: readonly number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const start = lineStarts[middle]!;
    const next = lineStarts[middle + 1] ?? Number.POSITIVE_INFINITY;
    if (offset < start) high = middle - 1;
    else if (offset >= next) low = middle + 1;
    else return { line: middle + 1, column: offset - start + 1 };
  }
  return { line: 1, column: Math.max(1, offset + 1) };
}

interface RegistrationCallSite {
  ownerId: string;
  kind: "calls" | "instantiates";
}

interface SourceRegistrations {
  nodes: CodeNode[];
  callSites: Map<string, RegistrationCallSite>;
  containments: Array<{ from: string; to: string; location: CodeSourceLocation }>;
}

function sourceRegistrationNodes(
  document: ScipDocument,
  source: string,
  providerId: string,
  semanticNodes: readonly CodeNode[],
): SourceRegistrations {
  const nodes: CodeNode[] = [];
  const callSites = new Map<string, RegistrationCallSite>();
  const containments: SourceRegistrations["containments"] = [];
  // Only JavaScript-family files have TypeScript-compatible syntax trees.
  // Large inputs remain searchable through semantic SCIP without an unbounded parse.
  if (!/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(document.relativePath)
    || source.length > MAX_REGISTRATION_SOURCE_LENGTH) return { nodes, callSites, containments };

  const semanticImplementationNames = new Set(
    semanticNodes
      .filter((node) =>
        node.location?.path === document.relativePath
        && ["class", "interface", "function", "method", "constructor", "type", "enum", "module"].includes(node.kind))
      .map((node) => node.name.toLocaleLowerCase()),
  );
  const lineStarts = lineStartOffsets(source);
  const sourceFile = ts.createSourceFile(
    document.relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    /\.[jt]sx$/i.test(document.relativePath) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const handlers: Array<{
    ownerId: string;
    callback: ts.ArrowFunction | ts.FunctionExpression;
    name: string;
    depth: number;
  }> = [];
  const visitRegistration = (syntaxNode: ts.Node): void => {
    if (nodes.length >= MAX_SOURCE_REGISTRATIONS_PER_DOCUMENT) return;
    if (ts.isCallExpression(syntaxNode)
      && (ts.isIdentifier(syntaxNode.expression) && syntaxNode.expression.text === "registerTool"
        || ts.isPropertyAccessExpression(syntaxNode.expression) && syntaxNode.expression.name.text === "registerTool")) {
      const nameArgument = syntaxNode.arguments[0];
      // Preserve the existing literal-only stable identity. Escaped text,
      // computed names and template literals are deliberately not inferred.
      if (nameArgument && ts.isStringLiteral(nameArgument)
        && SOURCE_REGISTRATION_NAME.test(nameArgument.text)
        && /^["'][^"'\\]*["']$/.test(nameArgument.getText(sourceFile))
        && !semanticImplementationNames.has(nameArgument.text.toLocaleLowerCase())) {
        const name = nameArgument.text;
        const nameOffset = nameArgument.getStart(sourceFile) + 1;
        const position = sourcePositionAtOffset(lineStarts, nameOffset);
        const canonicalIdentity = `source-registration:${document.relativePath}:registerTool:${name}:${position.line}`;
        const ownerId = stableId("node", canonicalIdentity);
        nodes.push({
          id: ownerId,
          kind: "function",
          name,
          canonicalIdentity,
          ...(document.language ? { language: document.language } : {}),
          location: {
            path: document.relativePath,
            startLine: position.line,
            startColumn: position.column,
            endLine: position.line,
            endColumn: position.column + name.length,
          },
          signature: `registerTool("${name}", ...)`,
          provenance: [{ providerId, fidelity: "syntax", freshness: "fresh" }],
        });
        const callback = syntaxNode.arguments[2];
        if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
          handlers.push({ ownerId, callback, name, depth: 0 });
        }
      }
    }
    ts.forEachChild(syntaxNode, visitRegistration);
  };
  visitRegistration(sourceFile);

  // Walk verified callback bodies without crossing lexical function boundaries.
  // Inline callback arguments have their own AST owner. A parent -> child
  // "contains" edge is source nesting, NEVER a transitive call assertion.
  let callbackCount = 0;
  for (let index = 0; index < handlers.length; index += 1) {
    const { ownerId, callback, name, depth } = handlers[index]!;
    const visitDirectCalls = (syntaxNode: ts.Node): void => {
      if (callSites.size >= MAX_REGISTRATION_CALL_SITES_PER_DOCUMENT) return;
      if (ts.isFunctionLike(syntaxNode) || ts.isClassDeclaration(syntaxNode) || ts.isClassExpression(syntaxNode)) return;
      if (ts.isCallExpression(syntaxNode)
        && depth < MAX_REGISTRATION_CALLBACK_DEPTH
        && callbackCount < MAX_REGISTRATION_INLINE_CALLBACKS_PER_DOCUMENT) {
        for (const argument of syntaxNode.arguments) {
          if (!ts.isArrowFunction(argument) && !ts.isFunctionExpression(argument)) continue;
          if (callbackCount >= MAX_REGISTRATION_INLINE_CALLBACKS_PER_DOCUMENT) break;
          const start = sourcePositionAtOffset(lineStarts, argument.getStart(sourceFile));
          const end = sourcePositionAtOffset(lineStarts, argument.getEnd());
          const canonicalIdentity =
            `source-registration-callback:${document.relativePath}:local ${name}:${start.line}:${start.column}`;
          const nestedOwnerId = stableId("node", canonicalIdentity);
          const location: CodeSourceLocation = {
            path: document.relativePath,
            startLine: start.line,
            startColumn: start.column,
            endLine: end.line,
            endColumn: end.column,
          };
          nodes.push({
            id: nestedOwnerId,
            kind: "function",
            name: `${name} inline callback`,
            canonicalIdentity,
            ...(document.language ? { language: document.language } : {}),
            location,
            lexicalExtent: location,
            signature: "inline callback argument (lexical scope only)",
            provenance: [{ providerId, fidelity: "syntax", freshness: "fresh" }],
          });
          containments.push({ from: ownerId, to: nestedOwnerId, location });
          handlers.push({ ownerId: nestedOwnerId, callback: argument, name, depth: depth + 1 });
          callbackCount += 1;
        }
      }
      if (ts.isCallExpression(syntaxNode) || ts.isNewExpression(syntaxNode)) {
        const callee = syntaxNode.expression;
        const token = ts.isIdentifier(callee) ? callee
          : ts.isPropertyAccessExpression(callee) ? callee.name : undefined;
        if (token) {
          const key = `${token.getStart(sourceFile)}:${token.getEnd()}`;
          callSites.set(key, { ownerId, kind: ts.isNewExpression(syntaxNode) ? "instantiates" : "calls" });
        }
      }
      ts.forEachChild(syntaxNode, visitDirectCalls);
    };
    visitDirectCalls(callback.body);
  }
  return { nodes, callSites, containments };
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

function isInstantiationOccurrence(source: string, lineStarts: readonly number[], range: ScipRange): boolean {
  const startLine = lineStarts[range.startLine];
  const endLine = lineStarts[range.endLine];
  if (startLine === undefined || endLine === undefined) return false;
  const startOffset = startLine + range.startCharacter;
  const endOffset = endLine + range.endCharacter;
  if (startOffset < 0 || endOffset < startOffset || endOffset > source.length) return false;
  let before = startOffset;
  while (before > 0 && /\s/.test(source[before - 1]!)) before -= 1;
  if (source.slice(Math.max(0, before - 3), before) !== "new") return false;
  const keywordStart = before - 3;
  if (keywordStart > 0 && /[A-Za-z0-9_$]/.test(source[keywordStart - 1]!)) return false;
  // PHP permits both new Order() and new Order; the lexical new keyword
  // and a resolved SCIP class symbol already prove instantiation.
  return true;
}

interface DefinitionRecord {
  symbol: string;
  document: ScipDocument;
  occurrence: ScipOccurrence;
  nodeId: string;
}

function scopedSymbolKey(document: ScipDocument, symbol: string): string {
  return symbol.startsWith("local ") ? `${document.relativePath}\0${symbol}` : symbol;
}

function canonicalScipIdentity(document: ScipDocument, symbol: string): string {
  if (symbol.startsWith("local ")) return `scip:${document.relativePath}:${symbol}`;
  // Composer root reference changes after install; omit it for project-local
  // PHP definition identities while preserving exact SCIP symbols for lookup.
  if (normalizeCodeLanguage(document.language) === "php") {
    const match = symbol.match(/^(scip-php\s+composer\s+\S+)\s+\S+\s+(.+)$/);
    if (match) return `scip:php-project:${document.relativePath}:${match[1]} ${match[2]}`;
  }
  return `scip:${symbol}`;
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
  evidence?: CodeRelation["evidence"],
  provenance?: CodeRelation["provenance"],
): void {
  // A verified self-call is recursion, not a malformed dependency. Preserve it
  // without allowing self-containment or self-structural relations.
  if (from === to && kind !== "calls") return;
  const identity = `${from}->${kind}->${to}`;
  const existing = output.get(identity);
  if (existing) {
    const byEvidence = new Map<string, NonNullable<CodeRelation["evidence"]>[number]>();
    for (const item of [...(existing.evidence ?? []), ...(evidence ?? [])]) {
      const key = JSON.stringify([item.location.path, item.location.startLine, item.location.startColumn,
        item.location.endLine, item.location.endColumn]);
      const previous = byEvidence.get(key);
      const labels = [previous?.label, item.label].filter((label): label is string => Boolean(label));
      byEvidence.set(key, { ...item,
        ...((item.receiverClass ?? previous?.receiverClass)
          ? { receiverClass: (item.receiverClass ?? previous?.receiverClass)! } : {}),
        ...(labels.length ? { label: [...new Set(labels.flatMap((label) => label.split(" | ")))].sort().join(" | ") } : {}),
      });
    }
    const mergedEvidence = [...byEvidence.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, item]) => item);
    const byProvider = new Map((existing.provenance ?? []).map((item) => [item.providerId, item]));
    for (const item of provenance ?? []) byProvider.set(item.providerId, item);
    output.set(identity, {
      ...existing,
      confidence: Math.max(existing.confidence, confidence),
      ...(mergedEvidence.length ? { evidence: mergedEvidence } : {}),
      ...(byProvider.size ? { provenance: [...byProvider.values()].sort((a, b) => a.providerId.localeCompare(b.providerId)) } : {}),
    });
    return;
  }
  output.set(identity, {
    id: stableId("relation", identity), from, to, kind, confidence,
    ...(evidence ? { evidence } : {}),
    ...(provenance ? { provenance } : {}),
  });
}

/** Decode SCIP UTF8-byte columns once into JS/AST UTF16 code units. */
function normalizeScipEncoding(index: ScipJsonIndex, sources: ReadonlyMap<string, string> | undefined): ScipJsonIndex {
  const encoding = index.positionEncoding;
  if (String(encoding ?? "") !== "1" && !String(encoding ?? "").toLowerCase().includes("utf8")) return index;
  return {
    ...index,
    positionEncoding: 2,
    documents: index.documents.map((document) => {
      const source = sources?.get(document.relativePath);
      if (!source) return document;
      const lines = source.split("\n");
      const cached = new Map<string, number>();
      const column = (line: number, byte: number): number => {
        const key = line + ":" + byte;
        const previous = cached.get(key);
        if (previous !== undefined) return previous;
        const text = lines[line];
        if (text === undefined) return byte;
        const raw = Buffer.from(text, "utf8");
        if (byte > raw.length) return byte;
        const decoded = raw.subarray(0, byte).toString("utf8");
        if (Buffer.byteLength(decoded, "utf8") !== byte) return byte;
        cached.set(key, decoded.length);
        return decoded.length;
      };
      const transform = (range: ScipRange | undefined): ScipRange | undefined => range ? {
        startLine: range.startLine, startCharacter: column(range.startLine, range.startCharacter),
        endLine: range.endLine, endCharacter: column(range.endLine, range.endCharacter),
      } : undefined;
      return { ...document, occurrences: document.occurrences.map((occurrence) => ({
        ...occurrence,
        ...(occurrence.range ? { range: transform(occurrence.range)! } : {}),
        ...(occurrence.enclosingRange ? { enclosingRange: transform(occurrence.enclosingRange)! } : {}),
      })) };
    }),
  };
}

export function normalizeScipGraph(input: NormalizeScipGraphInput): CodeGraphSnapshot {
  input = { ...input, index: normalizeScipEncoding(input.index, input.sourceTextByPath) };
  const providerId = input.providerId?.trim() || "scip-typescript";
  const fidelity = input.fidelity ?? "semantic-call";
  const infoBySymbol = new Map<string, ScipSymbolInformation>();
  for (const info of input.index.externalSymbols) infoBySymbol.set(info.symbol, info);
  for (const document of input.index.documents) {
    for (const info of document.symbols) infoBySymbol.set(scopedSymbolKey(document, info.symbol), info);
  }

  const semanticFileCountByLanguage = new Map<string, number>();
  for (const document of input.index.documents) {
    const language = normalizeCodeLanguage(document.language ?? inferCodeLanguageFromPath(document.relativePath));
    semanticFileCountByLanguage.set(language, (semanticFileCountByLanguage.get(language) ?? 0) + 1);
  }
  const eligiblePhpPaths = input.phpEligibleFilePaths
    ? new Set(input.phpEligibleFilePaths.map((path) => path.replaceAll("\\", "/").replace(/^\.\//, "")))
    : undefined;
  const nativeIndexedFirstPartyPhpPaths = eligiblePhpPaths
    ? new Set(input.index.documents
      .filter((document) => normalizeCodeLanguage(
        document.language ?? inferCodeLanguageFromPath(document.relativePath),
      ) === "php" && eligiblePhpPaths.has(document.relativePath.replaceAll("\\", "/").replace(/^\.\//, "")))
      .map((document) => document.relativePath.replaceAll("\\", "/").replace(/^\.\//, "")))
    : undefined;
  if (eligiblePhpPaths && !semanticFileCountByLanguage.has("php")) {
    semanticFileCountByLanguage.set("php", 0);
  }

  const definitions: DefinitionRecord[] = [];
  const nodeBySymbol = new Map<string, CodeNode>();
  for (const document of input.index.documents) {
    for (const occurrence of document.occurrences) {
      if ((occurrence.symbolRoles & SCIP_ROLE_DEFINITION) === 0 || !occurrence.range) continue;
      const symbolKey = scopedSymbolKey(document, occurrence.symbol);
      if (nodeBySymbol.has(symbolKey)) continue;
      const info = infoBySymbol.get(symbolKey);
      const canonicalIdentity = canonicalScipIdentity(document, occurrence.symbol);
      const nodeId = stableId("node", canonicalIdentity);
      const location = nativeLocation(document.relativePath, occurrence.range);
      const node: CodeNode = {
        id: nodeId,
        kind: normalizeKind(info, occurrence.symbol),
        name: info?.displayName
          ?? documentedDisplayName(documentationSignatureLine(info), occurrence.symbol)
          ?? fallbackDisplayName(occurrence.symbol),
        canonicalIdentity,
        ...(document.language ? { language: document.language } : {}),
        location,
        ...(occurrence.enclosingRange
          ? { lexicalExtent: nativeLocation(document.relativePath, occurrence.enclosingRange) } : {}),
        ...(info?.signature ? { signature: info.signature } : {}),
      };
      nodeBySymbol.set(symbolKey, node);
      definitions.push({ symbol: occurrence.symbol, document, occurrence, nodeId });
    }
  }

  const externalInfoBySymbol = new Map(input.index.externalSymbols.map((info) => [info.symbol, info]));
  const externalNodeBySymbol = new Map<string, CodeNode>();
  for (const document of input.index.documents) {
    for (const occurrence of document.occurrences) {
      if ((occurrence.symbolRoles & SCIP_ROLE_DEFINITION) !== 0) continue;
      if (nodeBySymbol.has(scopedSymbolKey(document, occurrence.symbol))) continue;
      if (externalNodeBySymbol.has(occurrence.symbol)) continue;
      if (occurrence.symbol.startsWith("local ")) continue;
      const info = externalInfoBySymbol.get(occurrence.symbol);
      const canonicalIdentity = `scip-external:${occurrence.symbol}`;
      externalNodeBySymbol.set(occurrence.symbol, {
        id: stableId("node", canonicalIdentity),
        kind: normalizeKind(info, occurrence.symbol),
        name: info?.displayName
          ?? documentedDisplayName(documentationSignatureLine(info), occurrence.symbol)
          ?? fallbackDisplayName(occurrence.symbol),
        canonicalIdentity,
        ...(info?.signature ? { signature: info.signature } : {}),
        provenance: [{ providerId, fidelity: "semantic-reference", freshness: "fresh" }],
      });
    }
  }

  const definitionsByDocument = new Map<ScipDocument, DefinitionRecord[]>();
  for (const definition of definitions) {
    const items = definitionsByDocument.get(definition.document) ?? [];
    items.push(definition);
    definitionsByDocument.set(definition.document, items);
  }

  const registrationNodes: CodeNode[] = [];
  const registrationCallsByDocument = new Map<ScipDocument, Map<string, RegistrationCallSite>>();
  const registrationContainments: SourceRegistrations["containments"] = [];
  for (const document of input.index.documents) {
    const source = input.sourceTextByPath?.get(document.relativePath);
    if (!source) continue;
    const registrations = sourceRegistrationNodes(
      document,
      source,
      providerId,
      [...nodeBySymbol.values()],
    );
    registrationNodes.push(...registrations.nodes);
    registrationCallsByDocument.set(document, registrations.callSites);
    registrationContainments.push(...registrations.containments);
  }

  // PHP SCIP gives reliable symbol and reference positions, but not the
  // enclosing lexical ranges that the generic SCIP ownership path uses.
  // Pair a named PHP AST function/method with a native SCIP definition ONLY
  // when the name token matches the same file and source position. Anonymous
  // scopes are barriers: never credit their calls to an outer method.
  const phpOwnersByDocument = new Map<ScipDocument, Array<{
    range: ScipRange; ownerId: string | undefined;
  }>>();
  const phpMethodsByQualifiedName = new Map<string, string | null>();
  const phpClassNodes = new Map<string, string | null>();
  const phpClassAncestors = new Map<string, readonly { className: string; relation: "extends" | "implements" | "trait" }[]>();
  const phpDocVirtualMethods = new Map<string, {
    className: string; methodName: string; classId: string; isStatic: boolean;
  }>();
  const phpConstantNodeIds = new Set<string>();
  const phpConstantOwners = new Map<string, string>();
  const phpConcreteMethodFlags = new Map<string, { isStatic: boolean; isConcretePublic: boolean }>();
  const phpUnresolvedSites = new Map<string, { name: string; document: ScipDocument; range: ScipRange }>();
  const siteKey = (document: ScipDocument, range: ScipRange, name: string): string =>
    [document.relativePath, range.startLine, range.startCharacter, name.toLowerCase()].join(":");
  const phpTypedCalls: Array<{ document: ScipDocument; ownerId: string; call: ScipPhpTypedMethodCall }> = [];
  const phpFileCalls: Array<{ document: ScipDocument; call: ScipPhpTypedMethodCall }> = [];
  const phpPropertiesByQualifiedName = new Map<string, string | null>();
  const phpTypedPropertyAccesses: Array<{
    document: ScipDocument; ownerId: string; access: ScipPhpTypedPropertyAccess;
  }> = [];
  const phpSyntheticFileNodes = new Map<string, CodeNode>();
  const resolvedPhpSites = new Set<string>();
  const qualifiedMethodKey = (className: string, methodName: string): string =>
    className.replace(/^\\+/, "").toLowerCase() + "::" + methodName.toLowerCase();
  if (input.phpLexicalScopes) {
    for (const document of input.index.documents) {
      const scopes = input.phpLexicalScopes.get(document.relativePath);
      if (!scopes?.length) continue;
      const documentDefinitions = definitionsByDocument.get(document) ?? [];
      const owners = scopes.map((scope) => {
        const extent = tupleRange(scope.range);
        if (scope.type === "file") {
          for (const call of scope.calls ?? []) phpFileCalls.push({ document, call });
          for (const call of scope.unresolvedCalls ?? []) {
            const range = tupleRange(call.nameRange);
            phpUnresolvedSites.set(siteKey(document, range, call.name), { name: call.name, document, range });
          }
          return null;
        }
        if (scope.type === "class" && scope.className && scope.nameRange) {
          const classKey = scope.className.toLowerCase();
          const token = tupleRange(scope.nameRange);
          const matches = documentDefinitions.filter((definition) => {
            const node = nodeBySymbol.get(scopedSymbolKey(document, definition.symbol));
            const position = definition.occurrence.range;
            return node && position && ["class", "interface", "type", "enum"].includes(node.kind)
              && position.startLine === token.startLine && position.startCharacter === token.startCharacter;
          });
          phpClassNodes.set(classKey, matches.length === 1 ? matches[0]!.nodeId : null);
          phpClassAncestors.set(classKey, scope.ancestors ?? []);
          const classId = matches.length === 1 ? matches[0]!.nodeId : undefined;
          if (classId) for (const constant of scope.constantDefinitions ?? []) {
            const location = tupleRange(constant.nameRange);
            const definitions = documentDefinitions.filter((definition) => {
              const node = nodeBySymbol.get(scopedSymbolKey(document, definition.symbol));
              const position = definition.occurrence.range;
              return node && position && node.name.toLowerCase() === constant.name.toLowerCase()
                && position.startLine === location.startLine
                && position.startCharacter === location.startCharacter;
            });
            if (definitions.length !== 1) continue;
            const id = definitions[0]!.nodeId;
            const node = nodeBySymbol.get(scopedSymbolKey(document, definitions[0]!.symbol));
            if (!node) continue;
            if (node.kind === "unknown") {
              node.kind = constant.kind === "constant" ? "variable" : "property";
            }
            phpConstantNodeIds.add(id);
            phpConstantOwners.set(id, classId);
          }
          if (classId) for (const declaration of scope.docMethods ?? []) {
            // Require one PHPDoc declaration and one SCIP definition at the
            // exact name token. A same-named method elsewhere is not evidence.
            if (scope.docMethods?.filter((entry) =>
              entry.name.toLowerCase() === declaration.name.toLowerCase()).length !== 1) continue;
            const position = tupleRange(declaration.nameRange);
            const virtual = documentDefinitions.filter((definition) => {
              const node = nodeBySymbol.get(scopedSymbolKey(document, definition.symbol));
              const range = definition.occurrence.range;
              return node?.kind === "method" && node.name.toLowerCase() === declaration.name.toLowerCase()
                && range?.startLine === position.startLine
                && range.startCharacter === position.startCharacter;
            });
            if (virtual.length !== 1) continue;
            const nodeId = virtual[0]!.nodeId;
            phpDocVirtualMethods.set(nodeId, {
              className: scope.className, methodName: declaration.name, classId, isStatic: declaration.isStatic,
            });
            const node = nodeBySymbol.get(scopedSymbolKey(document, virtual[0]!.symbol));
            if (node) node.signature = node.signature
              ? node.signature + " [PHPDoc @method virtual declaration]"
              : "PHPDoc @method virtual declaration (not an executable method)";
          }
          for (const property of scope.propertyDefinitions ?? []) {
            const token = tupleRange(property.nameRange);
            const matches = documentDefinitions.filter((definition) => {
              const node = nodeBySymbol.get(scopedSymbolKey(document, definition.symbol));
              const position = definition.occurrence.range;
              return node && position && ["property", "variable", "unknown"].includes(node.kind)
                && node.name.replace(/^\$/, "").toLowerCase() === property.name.toLowerCase()
                && position.startLine === token.startLine && position.startCharacter === token.startCharacter;
            });
            const qualified = qualifiedMethodKey(scope.className, property.name);
            const previous = phpPropertiesByQualifiedName.get(qualified);
            const current = matches.length === 1 ? matches[0]!.nodeId : null;
            phpPropertiesByQualifiedName.set(qualified,
              previous === undefined ? current : previous === current ? current : null);
          }
          return null;
        }
        if (scope.type === "anonymous" || !scope.nameRange || !scope.name) {
          for (const call of scope.unresolvedCalls ?? []) {
            const range = tupleRange(call.nameRange);
            if (rangeContains(extent, range)) phpUnresolvedSites.set(siteKey(document, range, call.name),
              { name: call.name, document, range });
          }
          return { range: extent, ownerId: undefined };
        }
        const nameRange = tupleRange(scope.nameRange);
        const candidates = documentDefinitions.filter((definition) => {
          const definitionRange = definition.occurrence.range;
          const node = nodeBySymbol.get(scopedSymbolKey(document, definition.symbol));
          return definitionRange && node
            && (node.kind === "method" || node.kind === "function" || node.kind === "constructor")
            && definitionRange.startLine === nameRange.startLine
            && definitionRange.startCharacter === nameRange.startCharacter
            && rangeContains(nameRange, definitionRange)
            && node.name.toLowerCase() === scope.name!.toLowerCase();
        });
        const ownerId = candidates.length === 1 ? candidates[0]!.nodeId : undefined;
        if (ownerId && scope.type === "method"
          && scope.isStatic !== undefined && scope.isConcretePublic !== undefined) {
          phpConcreteMethodFlags.set(ownerId, {
            isStatic: scope.isStatic, isConcretePublic: scope.isConcretePublic,
          });
        }
        if (ownerId && scope.type === "method" && scope.className) {
          const key = qualifiedMethodKey(scope.className, scope.name);
          const previous = phpMethodsByQualifiedName.get(key);
          phpMethodsByQualifiedName.set(key, previous === undefined ? ownerId : previous === ownerId ? ownerId : null);
        }
        if (ownerId && scope.propertyAccesses) {
          for (const access of scope.propertyAccesses) {
            if (rangeContains(extent, tupleRange(access.nameRange))) {
              phpTypedPropertyAccesses.push({ document, ownerId, access });
            }
          }
        }
        if (ownerId && scope.calls) {
          for (const call of scope.calls) {
            if (rangeContains(extent, tupleRange(call.nameRange))) {
              phpTypedCalls.push({ document, ownerId, call });
            }
          }
        }
        for (const call of scope.unresolvedCalls ?? []) {
          const range = tupleRange(call.nameRange);
          if (rangeContains(extent, range)) phpUnresolvedSites.set(siteKey(document, range, call.name),
            { name: call.name, document, range });
        }
        return { range: extent, ownerId };
      }).filter((scope): scope is { range: ScipRange; ownerId: string | undefined } => Boolean(scope))
        .sort((left, right) => rangeSpan(left.range) - rangeSpan(right.range));
      phpOwnersByDocument.set(document, owners);
    }
  }

  const relations = new Map<string, CodeRelation>();
  for (const [id, classId] of phpConstantOwners) {
    addRelation(relations, classId, id, "contains");
  }
  // PHPDoc methods are documentation members of the class, not file functions.
  for (const [nodeId, declaration] of phpDocVirtualMethods) {
    addRelation(relations, declaration.classId, nodeId, "contains", 1,
      undefined, [{ providerId: "questboard-php-ast", fidelity: "syntax", freshness: "fresh" }]);
  }
  for (const [className, ancestors] of phpClassAncestors) {
    const child = phpClassNodes.get(className);
    if (!child) continue;
    for (const ancestor of ancestors) {
      const parent = phpClassNodes.get(ancestor.className.toLowerCase());
      if (!parent || parent === child) continue;
      addRelation(relations, child, parent,
        ancestor.relation === "implements" ? "implements" : ancestor.relation === "extends" ? "extends" : "depends_on",
        1, undefined, [{ providerId: "questboard-php-ast", fidelity: "syntax", freshness: "fresh" }]);
      // A method explicitly declared on the child overrides an inherited method.
      for (const [qualified, methodId] of phpMethodsByQualifiedName) {
        if (!methodId || !qualified.startsWith(className + "::")) continue;
        const methodName = qualified.slice(className.length + 2);
        const ancestorMethod = phpMethodsByQualifiedName.get(ancestor.className.toLowerCase() + "::" + methodName);
        if (ancestorMethod && ancestorMethod !== methodId) addRelation(relations, methodId, ancestorMethod,
          "overrides", 1, undefined, [{ providerId: "questboard-php-ast", fidelity: "syntax", freshness: "fresh" }]);
      }
    }
  }
  for (const containment of registrationContainments) {
    addRelation(relations, containment.from, containment.to, "contains", 1,
      [{ location: containment.location, label: "AST verified inline callback lexical scope" }],
      [{ providerId, fidelity: "syntax", freshness: "fresh" }]);
  }
  // A PHPDoc facade may name an inherited executable method. Redirect calls
  // only when the AST hierarchy yields exactly one real SCIP method definition.
  const phpDocImplementationById = new Map<string, string>();
  for (const [virtualId, declaration] of phpDocVirtualMethods) {
    const implementation = verifiedPhpMethodTarget(declaration.className, declaration.methodName);
    const flags = implementation ? phpConcreteMethodFlags.get(implementation) : undefined;
    if (implementation && implementation !== virtualId && flags?.isConcretePublic
      && flags.isStatic === declaration.isStatic) {
      phpDocImplementationById.set(virtualId, implementation);
      addRelation(relations, virtualId, implementation, "depends_on", 1,
        undefined, [{ providerId: "questboard-php-ast", fidelity: "syntax", freshness: "fresh" }]);
    }
  }
  const nativeReferenceCounts = new Map<string, number>();
  for (const node of nodeBySymbol.values()) nativeReferenceCounts.set(node.canonicalIdentity, 0);
  for (const node of externalNodeBySymbol.values()) nativeReferenceCounts.set(node.canonicalIdentity, 0);
  // Count native references before owner/target/range filtering so a filtered
  // call is distinguishable from a provider that emitted no reference at all.
  for (const document of input.index.documents) {
    for (const occurrence of document.occurrences) {
      if ((occurrence.symbolRoles & SCIP_ROLE_DEFINITION) !== 0) continue;
      const targetNode = nodeBySymbol.get(scopedSymbolKey(document, occurrence.symbol))
        ?? externalNodeBySymbol.get(occurrence.symbol);
      if (targetNode) nativeReferenceCounts.set(targetNode.canonicalIdentity,
        (nativeReferenceCounts.get(targetNode.canonicalIdentity) ?? 0) + 1);
    }
  }

  // SCIP carries explicit lexical ownership on SymbolInformation. Preserve it
  // as real code containment before adding usage relationships. When an
  // indexer omits enclosingSymbol, use the narrowest enclosing definition
  // range in the same document as conservative structural evidence.
  const directlyContained = new Set<string>([...phpDocVirtualMethods.keys(), ...phpConstantNodeIds]);
  for (const document of input.index.documents) {
    for (const info of document.symbols) {
      if (!info.enclosingSymbol) continue;
      const child = nodeBySymbol.get(scopedSymbolKey(document, info.symbol))?.id;
      if (child && phpDocVirtualMethods.has(child)) continue;
      const parent = nodeBySymbol.get(scopedSymbolKey(document, info.enclosingSymbol))?.id;
      if (!child || !parent) continue;
      addRelation(relations, parent, child, "contains");
      directlyContained.add(child);
    }
  }

  for (const definition of definitions) {
    if (directlyContained.has(definition.nodeId) || !definition.occurrence.range) continue;
    const candidates = (definitionsByDocument.get(definition.document) ?? [])
      .filter((candidate) =>
        candidate.nodeId !== definition.nodeId
        && candidate.occurrence.enclosingRange
        && rangeContains(candidate.occurrence.enclosingRange, definition.occurrence.range!),
      )
      .sort((left, right) =>
        rangeSpan(left.occurrence.enclosingRange!) - rangeSpan(right.occurrence.enclosingRange!),
      );
    const parent = candidates[0];
    if (parent) addRelation(relations, parent.nodeId, definition.nodeId, "contains");
  }

  // SCIP resolves an inherited static call to the *declaring* method.
  // Preserve the exact AST-verified receiver separately per call-site evidence;
  // never manufacture child method symbols or collapse receivers into a label.
  const phpReceiverBySite = new Map<string, { className: string; target: string }>();
  const ambiguousPhpReceiverSites = new Set<string>();
  for (const { document, call } of phpTypedCalls) {
    const target = verifiedPhpMethodTarget(call.className, call.name);
    if (!target) continue;
    const key = siteKey(document, tupleRange(call.nameRange), call.name);
    const existing = phpReceiverBySite.get(key);
    if (existing && (existing.target !== target || existing.className !== call.className)) {
      ambiguousPhpReceiverSites.add(key);
    } else if (!existing) {
      phpReceiverBySite.set(key, { className: call.className, target });
    }
  }
  for (const key of ambiguousPhpReceiverSites) phpReceiverBySite.delete(key);

  for (const document of input.index.documents) {
    for (const info of document.symbols) {
      const from = nodeBySymbol.get(scopedSymbolKey(document, info.symbol))?.id;
      if (!from) continue;
      for (const relationship of info.relationships) {
        const to = nodeBySymbol.get(scopedSymbolKey(document, relationship.symbol))?.id;
        if (!to) continue;
        if (relationship.isImplementation) addRelation(relations, from, to, "implements");
        if (relationship.isTypeDefinition) addRelation(relations, from, to, "references_type");
        if (relationship.isReference && !relationship.isImplementation) addRelation(relations, from, to, "depends_on");
        if (relationship.isDefinition) addRelation(relations, from, to, "depends_on");
      }
    }
  }

  for (const document of input.index.documents) {
    const documentDefinitions = definitionsByDocument.get(document) ?? [];
    const source = input.sourceTextByPath?.get(document.relativePath);
    const lineStarts = source ? lineStartOffsets(source) : undefined;
    for (const occurrence of document.occurrences) {
      if ((occurrence.symbolRoles & SCIP_ROLE_DEFINITION) !== 0 || !occurrence.range) continue;
      const targetNode = nodeBySymbol.get(scopedSymbolKey(document, occurrence.symbol))
        ?? externalNodeBySymbol.get(occurrence.symbol);
      const target = targetNode?.id;
      if (!target) continue;
      const occurrenceStart = lineStarts?.[occurrence.range.startLine];
      const occurrenceEnd = lineStarts?.[occurrence.range.endLine];
      const registrationCall = occurrenceStart !== undefined && occurrenceEnd !== undefined
        ? registrationCallsByDocument.get(document)?.get(`${occurrenceStart + occurrence.range.startCharacter}:${occurrenceEnd + occurrence.range.endCharacter}`)
        : undefined;
      if (registrationCall) {
        addRelation(relations, registrationCall.ownerId, target, registrationCall.kind, 1, [{
          location: nativeLocation(document.relativePath, occurrence.range),
          label: "SCIP-resolved direct handler call",
        }], [{ providerId, fidelity: "semantic-call", freshness: "fresh" }]);
        continue;
      }
      const phpOwners = phpOwnersByDocument.get(document);
      const lexical = phpOwners?.find((scope) => rangeContains(scope.range, occurrence.range!));
      // If PHP AST knows this reference belongs to an anonymous function or
      // an unmatched function, fail closed rather than using an outer owner.
      const owner = lexical
        ? lexical.ownerId
        : phpOwners
          ? undefined
          : documentDefinitions
            .filter((definition) => definition.occurrence.enclosingRange
              && rangeContains(definition.occurrence.enclosingRange, occurrence.range!))
            .sort((left, right) => rangeSpan(left.occurrence.enclosingRange!) - rangeSpan(right.occurrence.enclosingRange!))[0]?.nodeId;
      if (!owner) continue;
      const baseRelationKind = source && lineStarts && isInstantiationOccurrence(source, lineStarts, occurrence.range)
        ? "instantiates"
        : source && lineStarts && isCallOccurrence(source, lineStarts, occurrence.range)
          ? "calls"
          : relationKindForRoles(occurrence.symbolRoles);
      const relationKind = phpConstantNodeIds.has(target) && baseRelationKind === "depends_on"
        ? "reads" : baseRelationKind;
      if (relationKind === "calls") {
        resolvedPhpSites.add(siteKey(document, occurrence.range, targetNode?.name ?? ""));
      }
      const resolvedTarget = relationKind === "calls"
        ? (phpDocImplementationById.get(target) ?? target) : target;
      const receiver = relationKind === "calls"
        ? phpReceiverBySite.get(siteKey(document, occurrence.range, targetNode?.name ?? ""))
        : undefined;
      const receiverClass = receiver?.target === resolvedTarget ? receiver.className : undefined;
      addRelation(relations, owner, resolvedTarget, relationKind, relationKind === "calls" || relationKind === "instantiates" ? 1 : 0.9,
        [{ location: nativeLocation(document.relativePath, occurrence.range),
          ...(receiverClass ? { receiverClass } : {}),
          label: (resolvedTarget === target ? "SCIP native reference occurrence"
            : "SCIP native call; PHPDoc facade resolved to verified executable method")
            + (receiverClass ? "; receiverClass: " + receiverClass : "") }],
        [{ providerId, fidelity, freshness: "fresh" }]);
    }
  }

  function verifiedPhpMethodTarget(className: string, methodName: string): string | undefined {
    let frontier = [className.toLowerCase()];
    const visited = new Set<string>();
    for (let depth = 0; depth < 24 && frontier.length; depth += 1) {
      const next: string[] = [];
      const candidates = new Set<string>();
      for (const current of frontier) {
        if (visited.has(current)) continue;
        visited.add(current);
        const direct = phpMethodsByQualifiedName.get(qualifiedMethodKey(current, methodName));
        if (direct) candidates.add(direct);
        // Ambiguous SCIP definitions cannot be recovered through their parents.
        else if (direct === null && phpMethodsByQualifiedName.has(qualifiedMethodKey(current, methodName))) return undefined;
        else next.push(...(phpClassAncestors.get(current) ?? []).map((entry) => entry.className.toLowerCase()));
      }
      if (candidates.size > 1) return undefined;
      if (candidates.size === 1) return [...candidates][0];
      frontier = next;
    }
    return undefined;
  }

  // Recover only AST-proven receiver calls whose exact target is a single
  // native SCIP method definition. Do not manufacture target nodes or treat
  // an unresolved/dynamic receiver as a semantic call.
  for (const { document, ownerId, call } of phpTypedCalls) {
    const target = verifiedPhpMethodTarget(call.className, call.name);
    const location = tupleRange(call.nameRange);
    if (!target) {
      phpUnresolvedSites.set(siteKey(document, location, call.name), { name: call.name, document, range: location });
      continue;
    }
    // Self calls are valid recursion evidence; the normalizer deduplicates
    // the SCIP and AST observations by exact source position.
    const innermost = phpOwnersByDocument.get(document)?.find((entry) => rangeContains(entry.range, location));
    if (!innermost || innermost.ownerId !== ownerId) continue;
    const competingNative = document.occurrences.some((occurrence) =>
      (occurrence.symbolRoles & SCIP_ROLE_DEFINITION) === 0 && occurrence.range
      && occurrence.range.startLine === location.startLine
      && occurrence.range.startCharacter === location.startCharacter
      && (() => {
        const native = nodeBySymbol.get(scopedSymbolKey(document, occurrence.symbol))?.id
          ?? externalNodeBySymbol.get(occurrence.symbol)?.id;
        return (native ? phpDocImplementationById.get(native) ?? native : undefined) !== target;
      })());
    if (competingNative) continue;
    resolvedPhpSites.add(siteKey(document, location, call.name));
    addRelation(relations, ownerId, target, "calls", 1, [{
      location: nativeLocation(document.relativePath, location),
      receiverClass: call.className,
      label: call.evidenceSource === "docblock"
        ? "PHP AST docblock-derived array element; SCIP-verified method definition; receiverClass: " + call.className
        : "PHP AST statically typed receiver; SCIP-verified method definition; receiverClass: " + call.className,
    }], [{ providerId: "questboard-php-ast", fidelity: "syntax", freshness: "fresh" }]);
  }

  // B2. Recover only type-proven property references whose exact target
  // matches one unambiguous SCIP property definition.
  for (const { document, ownerId, access } of phpTypedPropertyAccesses) {
    const target = phpPropertiesByQualifiedName.get(qualifiedMethodKey(access.className, access.name));
    if (!target || target === ownerId) continue;
    const location = tupleRange(access.nameRange);
    const owner = phpOwnersByDocument.get(document)?.find((scope) => rangeContains(scope.range, location));
    if (!owner || owner.ownerId !== ownerId) continue;
    addRelation(relations, ownerId, target, access.kind, 1,
      [{ location: nativeLocation(document.relativePath, location),
        label: access.evidenceSource === "docblock" ? "PHP AST docblock-derived property access"
          : "PHP AST type-proven property access" }],
      [{ providerId: "questboard-php-ast", fidelity: "syntax", freshness: "fresh" }]);
  }

  // A2. The file itself is the owner for executable PHP top-level statements.
  // Only exact SCIP-verified method targets become call relations.
  for (const { document, call } of phpFileCalls) {
    const location = tupleRange(call.nameRange);
    const target = verifiedPhpMethodTarget(call.className, call.name);
    if (!target) {
      phpUnresolvedSites.set(siteKey(document, location, call.name), { name: call.name, document, range: location });
      continue;
    }
    let fileNode = phpSyntheticFileNodes.get(document.relativePath);
    if (!fileNode) {
      const canonicalIdentity = "file:" + document.relativePath;
      fileNode = { id: stableId("node", canonicalIdentity), kind: "file", name: document.relativePath.split("/").at(-1)!,
        canonicalIdentity, language: "php", location: { path: document.relativePath },
        provenance: [{ providerId, fidelity: "syntax", freshness: "fresh" }] };
      phpSyntheticFileNodes.set(document.relativePath, fileNode);
    }
    resolvedPhpSites.add(siteKey(document, location, call.name));
    addRelation(relations, fileNode.id, target, "calls", 1,
      [{ location: nativeLocation(document.relativePath, location),
        receiverClass: call.className, label: "PHP AST file-level static call; receiverClass: " + call.className }],
      [{ providerId: "questboard-php-ast", fidelity: "syntax", freshness: "fresh" }]);
  }
  const unresolvedCounts = new Map<string, number>();
  for (const [key, site] of phpUnresolvedSites) {
    if (resolvedPhpSites.has(key)) continue;
    const name = site.name.toLowerCase();
    unresolvedCounts.set(name, (unresolvedCounts.get(name) ?? 0) + 1);
  }
  const snapshot: CodeGraphSnapshot = {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION,
    projectId: input.projectId,
    rootPath: input.rootPath,
    indexedAt: input.indexedAt,
    nodes: [...nodeBySymbol.values(), ...registrationNodes, ...externalNodeBySymbol.values(), ...phpSyntheticFileNodes.values()],
    relations: [...relations.values()],
    ...(providerId === "scip-php" ? {
      unresolvedPhpMethodCalls: [...unresolvedCounts].sort(([a], [b]) => a.localeCompare(b))
        .map(([name, count]) => ({ name, count })),
    } : {}),
    ...(input.indexArtifactSha256 ? {
      providerRuns: [{
        providerId,
        nativeArtifactSha256: input.indexArtifactSha256,
        indexedAt: input.indexedAt,
        fingerprint: createHash("sha256").update(JSON.stringify([providerId, input.indexArtifactSha256, input.indexedAt])).digest("hex"),
        nativeReferences: [...nativeReferenceCounts.entries()].sort(([a], [b]) => a.localeCompare(b))
          .map(([canonicalIdentity, referenceOccurrenceCount]) => ({ canonicalIdentity, referenceOccurrenceCount })),
      }],
    } : {}),
    coverage: {
      degraded: false,
      providers: [{
        providerId,
        status: "fresh",
        fidelity,
        languages: [...semanticFileCountByLanguage.keys()].sort(),
        nodeCount: nodeBySymbol.size + registrationNodes.length + externalNodeBySymbol.size,
        relationCount: relations.size,
      }],
      languages: [...semanticFileCountByLanguage.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([language, fileCount]) => ({
          language,
          fileCount: language === "php" && eligiblePhpPaths ? eligiblePhpPaths.size : fileCount,
          semanticEligibleFileCount: language === "php" && eligiblePhpPaths ? eligiblePhpPaths.size : fileCount,
          semanticIndexedFileCount: language === "php" && nativeIndexedFirstPartyPhpPaths
            ? nativeIndexedFirstPartyPhpPaths.size : fileCount,
          fidelity,
          providerIds: [providerId],
          degraded: false,
        })),
    },
  };
  assertValidCodeGraphSnapshot(snapshot);
  return snapshot;
}
