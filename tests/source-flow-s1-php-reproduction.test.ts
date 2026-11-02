import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CODE_GRAPH_SCHEMA_VERSION,
  classifyCodeArchitectureNode,
  createCodeSourceSubsystemRead,
  projectCodeArchitecture,
  type CodeGraphSnapshot,
  type CodeNode,
  type CodeRelation,
  type CodeMapProviderCapabilityReport,
} from '../src/index.js';

// Synthetic normalized SCIP-style facts. These are NOT output from a real PHP provider.
// Their file paths correspond to the companion Composer/PHP source fixture.
function phpNode(id: string, name: string, path: string, kind: CodeNode['kind'] = 'class'): CodeNode {
  return { id: `code:node:${id}`, name, kind, language: 'php',
    canonicalIdentity: `scip-php synthetic/source-flow-s1 ${path}#${name}`,
    location: { path, startLine: 3 } };
}

const baseNodes = [
  phpNode('http', 'HttpGateway', 'src/Transport/HttpGateway.php'),
  phpNode('handler', 'BatchHandler', 'src/Application/BatchHandler.php'),
  phpNode('service', 'InvoiceService', 'src/Service/InvoiceService.php'),
  phpNode('dao', 'InvoiceDao', 'src/DAO/InvoiceDao.php'),
] as const;
const rawCalls: CodeRelation[] = [
  { id: 'code:relation:handler-service', from: 'code:node:handler', to: 'code:node:service', kind: 'calls', confidence: 1,
    evidence: [{ location: { path: 'src/Application/BatchHandler.php', startLine: 6 }, label: 'synthetic method call' }] },
  { id: 'code:relation:service-dao', from: 'code:node:service', to: 'code:node:dao', kind: 'calls', confidence: 1,
    evidence: [{ location: { path: 'src/Service/InvoiceService.php', startLine: 6 }, label: 'synthetic method call' }] },
];
function graph(nodes: readonly CodeNode[] = baseNodes, relations: readonly CodeRelation[] = rawCalls): CodeGraphSnapshot {
  return { schemaVersion: CODE_GRAPH_SCHEMA_VERSION, projectId: 'synthetic-source-flow-s1',
    rootPath: '/synthetic/source-flow-s1', indexedAt: '2026-10-14T00:00:00.000Z', nodes, relations };
}

test('S1 reproduces two legacy boxes and zero edges while two PHP calls survive as subsystem evidence', () => {
  const snapshot = graph();
  const compatibility = projectCodeArchitecture(snapshot);
  const subsystem = createCodeSourceSubsystemRead(snapshot, compatibility);
  assert.deepEqual(compatibility.nodes.map((item) => item.kind), ['http_api', 'application_service']);
  assert.equal(compatibility.relations.length, 0);
  assert.deepEqual([compatibility.quality.status, compatibility.quality.reason], ['sparse', 'no_relations']);
  assert.equal(snapshot.nodes.length, 4);
  assert.equal(snapshot.relations.filter((item) => item.kind === 'calls').length, 2);
  assert.equal(subsystem.nodes.length, 4);
  assert.equal(subsystem.relations.filter((item) => item.kind === 'calls').length, 2);
  assert.equal(subsystem.quality.rawCallCount, 2);
  assert.equal(subsystem.quality.subsystemCallEvidenceCount, 2);
  assert.equal(subsystem.quality.compatibilityCallEvidenceCount, 0);
  assert.equal(subsystem.truncated, false);
  assert.equal(subsystem.relations.every((item) => item.sourceRelationIds.length === 1), true);
});

test('S1 distinguishes raw evidence absent from compatibility role-filter omission', () => {
  const compatibility = projectCodeArchitecture(graph(baseNodes, []));
  const subsystem = createCodeSourceSubsystemRead(graph(baseNodes, []), compatibility);
  assert.equal(compatibility.nodes.length, 2);
  assert.equal(compatibility.relations.length, 0);
  assert.equal(subsystem.quality.rawCallCount, 0);
  assert.equal(subsystem.relations.length, 0);
});

test('S1 negative naming: Handler is not automatically HTTP and a DAO class is not a repository contract', () => {
  assert.equal(classifyCodeArchitectureNode(baseNodes[1]!), undefined);
  assert.equal(classifyCodeArchitectureNode(baseNodes[3]!), undefined);
  const port = phpNode('port', 'LedgerPort', 'src/Contract/LedgerPort.php', 'interface');
  assert.equal(classifyCodeArchitectureNode(port), 'repository_contract');
  const extended = graph([...baseNodes, port, phpNode('cli', 'RebuildCommand', 'src/CLI/RebuildCommand.php'),
    phpNode('event', 'InvoiceHandler', 'src/Event/InvoiceHandler.php')], [
    ...rawCalls,
    { id: 'code:relation:dao-port', from: 'code:node:dao', to: 'code:node:port', kind: 'implements', confidence: 1 },
    { id: 'code:relation:handler-dao-instance', from: 'code:node:handler', to: 'code:node:dao', kind: 'instantiates', confidence: 1 },
  ]);
  const compatibility = projectCodeArchitecture(extended);
  const subsystem = createCodeSourceSubsystemRead(extended, compatibility);
  assert.equal(compatibility.relations.length, 0);
  assert.equal(subsystem.relations.filter((item) => item.kind === 'implements').length, 1);
  assert.equal(subsystem.relations.filter((item) => item.kind === 'instantiates').length, 1);
  assert.equal(subsystem.relations.filter((item) => item.kind === 'calls').length, 2);
  assert.ok(compatibility.nodes.some((item) => item.kind === 'agent_mcp'));
});

test('S1 TS and JS comparison: graph projection follows evidence semantics, not PHP-specific source syntax', () => {
  for (const [language, suffix] of [['typescript', '.ts'], ['javascript', '.js']] as const) {
    const translated = baseNodes.map((item) => ({ ...item, language,
      canonicalIdentity: `scip-${language}:${item.name}`,
      location: { ...item.location!, path: item.location!.path.replace('.php', suffix) } }));
    const snapshot = graph(translated, rawCalls);
    const compat = projectCodeArchitecture(snapshot);
    const subs = createCodeSourceSubsystemRead(snapshot, compat);
    assert.equal(compat.nodes.length, 2);
    assert.equal(compat.relations.length, 0);
    assert.equal(subs.quality.rawCallCount, 2);
    assert.equal(subs.relations.length, 2);
  }
});

test('S1 file-only PHP without semantic provider does not fabricate calls or subsystem relations', () => {
  const files = baseNodes.map((item, i) => ({ ...item, id: `file-${i}`, kind: 'file' as const,
    canonicalIdentity: `file:${item.location!.path}` }));
  const provider: CodeMapProviderCapabilityReport = { providers: [], indexed: true, health: 'healthy',
    semanticCoverage: 'unavailable', degraded: false, languages: [{
      language: 'php', discoveredFileCount: files.length, eligibleFileCount: null,
      indexedFileCount: 0, excludedFileCount: 0, exclusionReason: null,
      symbolCount: 0, fidelity: 'file-only', providerIds: [], observedRelationKinds: [],
      semanticCoverage: 'unavailable', gapReason: 'no_trusted_provider_available', installOptions: [],
    }] };
  const snapshot = graph(files, []);
  const compat = projectCodeArchitecture(snapshot);
  const subs = createCodeSourceSubsystemRead(snapshot, compat, provider);
  assert.equal(compat.nodes.length, 0);
  assert.equal(subs.nodes.length, 0);
  assert.equal(subs.relations.length, 0);
  assert.equal(subs.quality.rawCallCount, 0);
  assert.deepEqual(subs.quality.languageGaps.map((item) => [item.language, item.gapReason]),
    [['php', 'no_trusted_provider_available']]);
});

test('S1 PHP method-to-method owners and unknown parameters do not invent transitive calls', () => {
  const methods: CodeNode[] = [
    phpNode('handler-handle', 'handle', 'src/Application/BatchHandler.php', 'method'),
    phpNode('service-load', 'load', 'src/Service/InvoiceService.php', 'method'),
    phpNode('dao-find', 'find', 'src/DAO/InvoiceDao.php', 'method'),
    { id: 'code:node:unknown-param', name: 'mysteryArgument', kind: 'unknown',
      canonicalIdentity: 'synthetic:unknown-parameter', language: 'php',
      location: { path: 'src/Application/BatchHandler.php', startLine: 6 } },
  ];
  const methodCalls: CodeRelation[] = [
    { id: 'code:relation:method-handler-service', from: 'code:node:handler-handle',
      to: 'code:node:service-load', kind: 'calls', confidence: 1 },
    { id: 'code:relation:method-service-dao', from: 'code:node:service-load',
      to: 'code:node:dao-find', kind: 'calls', confidence: 1 },
    { id: 'code:relation:unknown-dependency', from: 'code:node:unknown-param',
      to: 'code:node:dao-find', kind: 'depends_on', confidence: 0.2 },
  ];
  const snapshot = graph([...baseNodes, ...methods], methodCalls);
  const compatibility = projectCodeArchitecture(snapshot);
  const subsystem = createCodeSourceSubsystemRead(snapshot, compatibility);
  assert.equal(snapshot.nodes.length, 8);
  assert.equal(snapshot.relations.filter((item) => item.kind === 'calls').length, 2);
  assert.equal(compatibility.nodes.length, 2);
  assert.equal(compatibility.relations.length, 0);
  assert.equal(subsystem.relations.filter((item) => item.kind === 'calls').length, 2);
  assert.equal(subsystem.quality.rawCallCount, 2);
  assert.equal(subsystem.relations.some((item) => item.sourceRelationIds.includes('code:relation:unknown-dependency')), false);
  assert.equal(subsystem.relations.some((item) => item.fromPathPrefix === 'src/Application'
    && item.toPathPrefix === 'src/DAO'), false);
});