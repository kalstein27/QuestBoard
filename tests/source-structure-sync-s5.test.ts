import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  CODE_GRAPH_SCHEMA_VERSION,
  CodeMapService,
  QuestBoardService,
  SourceStructureFlowSyncService,
  SqliteQuestBoardRepository,
  createQuestBoardHttpServer,
  createQuestBoardMcpHandler,
  describeQuestBoardError,
  executeQuestBoardAgentTool,
  runQuestBoardCli,
  QUESTBOARD_AGENT_TOOLS,
  type ActorRef,
  type CodeGraphSnapshot,
  type CodeIndexRequest,
  type CodeIntelligenceProvider,
  type QuestBoardAgentToolContext,
} from "../src/index.js";

const actor: ActorRef = { id: "agent:s5-synthetic", provider: "synthetic" };
const indexedAt = "2026-10-20T00:00:00.000Z";
function synthetic(projectId: string, stamp = indexedAt): CodeGraphSnapshot {
  const node = (id: string, path: string, language = "php") => ({
    id: "code:node:" + id, kind: "method" as const, name: id, language,
    canonicalIdentity: language + ":synthetic:" + path + "#" + id,
    location: { path, startLine: 2 },
  });
  return {
    schemaVersion: CODE_GRAPH_SCHEMA_VERSION, projectId, rootPath: "/synthetic/s5",
    indexedAt: stamp,
    nodes: [
      node("handler", "src/Application/Handler.php"),
      node("service", "src/Service/Worker.php"),
      node("storage", "src/Data/Store.ts", "typescript"),
    ],
    relations: [
      { id: "code:relation:handler-service", from: "code:node:handler", to: "code:node:service",
        kind: "calls", confidence: 0.93, evidence: [{ location: {
          path: "src/Application/Handler.php", startLine: 8 }, label: "synthetic" }] },
      { id: "code:relation:service-storage", from: "code:node:service", to: "code:node:storage",
        kind: "calls", confidence: 0.96, evidence: [{ location: {
          path: "src/Service/Worker.php", startLine: 8 } }] },
    ],
  };
}
class FixtureProvider implements CodeIntelligenceProvider {
  readonly providerId = "synthetic-s5";
  readonly capabilities = { incrementalIndexing: true, impactAnalysis: false, callTrace: false } as const;
  public next: CodeGraphSnapshot | undefined;
  async indexProject(_request: CodeIndexRequest): Promise<CodeGraphSnapshot> {
    if (!this.next) throw new Error("Synthetic provider was not seeded");
    return this.next;
  }
}
type Context = {
  repository: SqliteQuestBoardRepository;
  service: QuestBoardService;
  codeMap: CodeMapService;
  sync: SourceStructureFlowSyncService;
  runtime: QuestBoardAgentToolContext;
  provider: FixtureProvider;
  projectId: string;
};
async function fixture(fn: (ctx: Context) => Promise<void> | void) {
  const root = await mkdtemp(join(tmpdir(), "questboard-s5-synthetic-"));
  const repository = new SqliteQuestBoardRepository(join(root, "isolated.sqlite"));
  const service = new QuestBoardService(repository);
  const projectId = service.createProject({ name: "S5 synthetic" }, actor).id;
  const provider = new FixtureProvider();
  provider.next = synthetic(projectId);
  const codeMap = new CodeMapService(provider, undefined, undefined, undefined, {
    store: { load: () => undefined, save: () => {} },
    sourceState: {
      rootIdentity: (path) => "synthetic-root:" + path,
      sourceManifestFingerprint: () => "synthetic-source-manifest",
    },
    providerConfigFingerprint: "synthetic-s5-provider",
  });
  await codeMap.refresh({ projectId, rootPath: "/synthetic/s5" });
  const sync = new SourceStructureFlowSyncService(repository, {
    read: (id) => {
      const cached = codeMap.getCached(id);
      const snapshotId = codeMap.snapshotIdentity(id)?.snapshotId;
      if (!cached || !snapshotId) throw new Error("Not indexed in synthetic fixture");
      return { graph: cached.graph, snapshotId };
    },
  });
  const runtime: QuestBoardAgentToolContext = { service, codeMapService: codeMap,
    sourceStructureFlowSyncService: sync };
  try { await fn({ repository, service, codeMap, sync, runtime, provider, projectId }); }
  finally { repository.close(); await rm(root, { recursive: true, force: true }); }
}
function tool<T>(ctx: Context, name: string, args: unknown): T {
  return executeQuestBoardAgentTool(ctx.runtime, name, args) as T;
}
type CandidateResult = { candidates: {
  projectId: string; snapshotId: string; sourceIndexedAt: string; offset: number;
  nodes: Array<{ id: string; pathPrefix: string }>;
  hasMore: boolean; truncated: boolean; candidateCount: number; limit: number;
} };
type PreviewResult = { preview: {
  projectId: string; snapshotId: string; sourceIndexedAt: string;
  selectionFingerprint: string; expectedSelectionRevision: number | null;
  nodes: Array<{ bindingId: string }>; relations: Array<{ rawRelationIds?: readonly string[] }>;
  counts: Record<string, number>; warnings: string[];
} };
type ApplyResult = { result: {
  createdNodes: number; createdRelationItems: number; createdRelationLinks: number;
  replayed: boolean; nodeIds: string[]; linkIds: string[];
} };
function prepare(ctx: Context, selectionKey = "s5-alpha") {
  const c = tool<CandidateResult>(ctx, "questboard_list_source_structure_candidates",
    { projectId: ctx.projectId }).candidates;
  assert.ok(c.snapshotId);
  const args = {
    projectId: ctx.projectId, selectionKey,
    selectedSubsystemIds: c.nodes.map((node) => node.id),
    expectedSnapshotId: c.snapshotId,
    expectedSourceIndexedAt: c.sourceIndexedAt,
    offset: c.offset, limit: c.limit,
  };
  const preview = tool<PreviewResult>(ctx, "questboard_preview_source_structure_flow_sync", args).preview;
  return { candidates: c, args, preview };
}
function authorize(ctx: Context): QuestBoardAgentToolContext {
  return { ...ctx.runtime, sourceStructureApplyAuthority: (projectId, claimed) =>
    projectId === ctx.projectId && claimed.id === actor.id && claimed.provider === actor.provider
      ? actor : undefined };
}
async function http(ctx: Context, authorizeHttp = false) {
  const server = createQuestBoardHttpServer(ctx.service, {
    codeMapService: ctx.codeMap, sourceStructureFlowSyncService: ctx.sync,
    ...(authorizeHttp ? { authorizeSourceStructureApply: (request, projectId, claimed) =>
      request.headers["x-s5-fixture-auth"] === "trusted-session" &&
      projectId === ctx.projectId && claimed.id === actor.id && claimed.provider === actor.provider
        ? actor : undefined } : {}),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  return {
    get: async (path: string) => {
      const response = await fetch(url + path);
      return { status: response.status, body: await response.json() as Record<string, any> };
    },
    post: async (path: string, body: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(url + path, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as Record<string, any> };
    },
    close: async () => { await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
function mcpCall(context: QuestBoardAgentToolContext, name: string, args: unknown, id = 1) {
  const handler = createQuestBoardMcpHandler(context, "s5-synthetic-session");
  return Promise.resolve(handler.handle({ jsonrpc: "2.0", id, method: "tools/call",
    params: { name, arguments: args } })).then((value) => {
    if (!value || !("result" in value)) throw new Error("Expected MCP tool result");
    const result = value.result as { isError?: boolean; content: Array<{ type: string; text: string }> };
    return { isError: result.isError ?? false, body: JSON.parse(result.content[0]!.text) as any };
  });
}
function cli(context: QuestBoardAgentToolContext, args: string[]) {
  const out: string[] = [], err: string[] = [];
  return runQuestBoardCli((name, payload) => executeQuestBoardAgentTool(context, name, payload),
    args, { defaultActor: actor, io: { stdout: (x) => out.push(x), stderr: (x) => err.push(x) } })
    .then((exitCode) => ({ exitCode, body: JSON.parse((exitCode ? err : out)[0]!) as any }));
}
function flags(args: ReturnType<typeof prepare>["args"]): string[] {
  return ["--project", args.projectId, "--selection-key", args.selectionKey,
    "--subsystems", args.selectedSubsystemIds.join(","),
    "--snapshot", args.expectedSnapshotId, "--indexed-at", args.expectedSourceIndexedAt,
    "--offset", String(args.offset), "--limit", String(args.limit)];
}
const applyFields = (p: ReturnType<typeof prepare>, requestId: string) => ({
  ...p.args, expectedSelectionFingerprint: p.preview.selectionFingerprint,
  expectedSelectionRevision: p.preview.expectedSelectionRevision, approved: true, requestId, actor,
});
const route = (projectId: string, action: string) =>
  "/projects/" + projectId + "/source-structure/flow-sync/" + action;

test("S5 candidate/list and preview parity across HTTP, MCP, CLI and direct agent tool", async () => {
  await fixture(async (ctx) => {
    const h = await http(ctx);
    try {
      const p = prepare(ctx);
      const viaHttp = await h.get(route(ctx.projectId, "candidates"));
      const viaMcp = await mcpCall(ctx.runtime, "questboard_list_source_structure_candidates",
        { projectId: ctx.projectId });
      const viaCli = await cli(ctx.runtime, ["source-structure-candidates", "--project", ctx.projectId]);
      assert.equal(viaHttp.status, 200);
      assert.equal(viaCli.exitCode, 0);
      assert.deepEqual(viaHttp.body, { candidates: p.candidates });
      assert.deepEqual(viaMcp.body, { candidates: p.candidates });
      assert.deepEqual(viaCli.body, { candidates: p.candidates });
      const httpPreview = await h.post(route(ctx.projectId, "preview"), p.args);
      const mcpPreview = await mcpCall(ctx.runtime, "questboard_preview_source_structure_flow_sync", p.args);
      const cliPreview = await cli(ctx.runtime, ["source-structure-preview", ...flags(p.args)]);
      assert.equal(httpPreview.status, 200);
      assert.equal(cliPreview.exitCode, 0);
      assert.deepEqual(httpPreview.body.preview, p.preview);
      assert.deepEqual(mcpPreview.body.preview, p.preview);
      assert.deepEqual(cliPreview.body.preview, p.preview);
      assert.equal(p.preview.nodes.length, 3);
      assert.equal(p.preview.relations.length, 2);
      assert.equal(ctx.repository.listInvestigationNodes(ctx.projectId).length, 0);
      assert.equal(ctx.repository.sourceStructureBindings.listBindings(ctx.projectId).length, 0);
    } finally { await h.close(); }
  });
});
test("S5 default apply fails closed on HTTP, MCP and CLI even with spoofed actor headers", async () => {
  await fixture(async (ctx) => {
    const p = prepare(ctx); const req = applyFields(p, "s5-denied-apply-01");
    const h = await http(ctx);
    try {
      const httpResponse = await h.post(route(ctx.projectId, "apply"), req, {
        "x-questboard-actor-id": actor.id, "x-questboard-actor-provider": actor.provider,
        "x-questboard-request-id": req.requestId, "x-questboard-daemon-client": "1",
      });
      const mcpResponse = await mcpCall(ctx.runtime, "questboard_apply_source_structure_flow_sync", req);
      const cliResponse = await cli(ctx.runtime, ["source-structure-apply", ...flags(p.args),
        "--selection-fingerprint", p.preview.selectionFingerprint, "--new-selection",
        "--approved", "--request-id", req.requestId]);
      assert.equal(httpResponse.status, 403);
      assert.equal(httpResponse.body.error.code, "source_structure_apply_unauthorized");
      assert.equal(mcpResponse.isError, true);
      assert.equal(mcpResponse.body.error.code, "source_structure_apply_unauthorized");
      assert.equal(cliResponse.exitCode, 1);
      assert.equal(cliResponse.body.error.code, "source_structure_apply_unauthorized");
      assert.equal(ctx.repository.listInvestigationNodes(ctx.projectId).length, 0);
      assert.equal(ctx.repository.sourceStructureBindings.getSelection(ctx.projectId, p.args.selectionKey), undefined);
    } finally { await h.close(); }
  });
});
test("S5 transport-authenticated HTTP apply and MCP/CLI exact request replays share one terminal receipt", async () => {
  await fixture(async (ctx) => {
    const p = prepare(ctx);
    const req = applyFields(p, "s5-authorized-replay-01");
    const h = await http(ctx, true);
    try {
      const applied = await h.post(route(ctx.projectId, "apply"), req, {
        "x-questboard-actor-id": actor.id, "x-questboard-actor-provider": actor.provider,
        "x-questboard-request-id": req.requestId, "x-s5-fixture-auth": "trusted-session",
      });
      assert.equal(applied.status, 200);
      const result = applied.body.result as ApplyResult["result"];
      assert.equal(result.createdNodes, 3);
      assert.equal(result.createdRelationLinks, 2);
      const mcpReplay = await mcpCall(authorize(ctx), "questboard_apply_source_structure_flow_sync", req);
      const cliReplay = await cli(authorize(ctx), ["source-structure-apply", ...flags(p.args),
        "--selection-fingerprint", p.preview.selectionFingerprint, "--new-selection",
        "--approved", "--request-id", req.requestId]);
      assert.equal(mcpReplay.isError, false);
      assert.equal(mcpReplay.body.result.replayed, true);
      assert.equal(cliReplay.exitCode, 0);
      assert.equal(cliReplay.body.result.replayed, true);
      assert.deepEqual(mcpReplay.body.result.nodeIds, result.nodeIds);
      assert.deepEqual(cliReplay.body.result.linkIds, result.linkIds);
      assert.equal(ctx.repository.listInvestigationNodes(ctx.projectId).length, 3);
      assert.equal(ctx.repository.listInvestigationItemLinks(ctx.projectId).length, 2);
      assert.equal(ctx.repository.sourceStructureBindings.getSelection(ctx.projectId, p.args.selectionKey)?.revision, 1);
    } finally { await h.close(); }
  });
});
test("S5 distinct conflicting writer fails CAS; same exact authorized selection avoids duplicate Flow", async () => {
  await fixture((ctx) => {
    const p = prepare(ctx);
    const trusted = authorize(ctx);
    executeQuestBoardAgentTool(trusted, "questboard_apply_source_structure_flow_sync",
      applyFields(p, "s5-cas-first-01"));
    assert.throws(() => executeQuestBoardAgentTool(trusted, "questboard_apply_source_structure_flow_sync",
      applyFields(p, "s5-cas-second-01")),
    (error: unknown) => describeQuestBoardError(error).code === "selection_revision_conflict");
    const next = prepare(ctx);
    const again = executeQuestBoardAgentTool(trusted, "questboard_apply_source_structure_flow_sync",
      applyFields(next, "s5-cas-third-01")) as ApplyResult;
    assert.equal(again.result.createdNodes, 0);
    assert.equal(again.result.createdRelationLinks, 0);
    assert.equal(ctx.repository.listInvestigationNodes(ctx.projectId).length, 3);
  });
});
test("S5 hardened boundary rejects forged pages, oversized or malformed selections and foreign ownership", async () => {
  await fixture((ctx) => {
    const p = prepare(ctx); const trusted = authorize(ctx);
    const reject = (payload: Record<string, unknown>, code: string) => {
      assert.throws(() => executeQuestBoardAgentTool(trusted,
        "questboard_preview_source_structure_flow_sync", payload),
      (error: unknown) => describeQuestBoardError(error).code === code);
    };
    reject({ ...p.args, subsystemPage: { operation: "list_subsystems" } },
      "source_structure_bad_request");
    reject({ ...p.args, selectedSubsystemIds: Array(13).fill("code-subsystem:node:x") },
      "source_structure_selection_cap");
    reject({ ...p.args, selectedSubsystemIds: ["code-map:node:legacy"] },
      "source_structure_bad_request");
    reject({ ...p.args, pathPrefix: "/Users/private/source" },
      "source_structure_bad_request");
    reject({ ...p.args, offset: -1 }, "source_structure_bad_request");
    reject({ ...p.args, selectedSubsystemIds: ["code-subsystem:node:" + "x".repeat(30_000)] },
      "source_structure_request_too_large");
    const foreign = ctx.service.createProject({ name: "S5 other project" }, actor);
    const args = { ...p.args, projectId: foreign.id, selectionKey: "foreign" };
    assert.throws(() => executeQuestBoardAgentTool(trusted,
      "questboard_apply_source_structure_flow_sync",
      { ...applyFields(p, "s5-foreign-apply-01"), ...args }),
    (error: unknown) => describeQuestBoardError(error).code === "source_structure_apply_unauthorized");
    assert.equal(ctx.repository.listInvestigationNodes(foreign.id).length, 0);
  });
});
test("S5 exact pinned source rejects changed source before applying, preserving prior objects", async () => {
  await fixture(async (ctx) => {
    const p = prepare(ctx);
    const trusted = authorize(ctx);
    ctx.provider.next = synthetic(ctx.projectId, "2026-10-20T01:00:00.000Z");
    await ctx.codeMap.refresh({ projectId: ctx.projectId, rootPath: "/synthetic/s5",
      changes: [{ path: "src/Application/Handler.php", kind: "modified" }] });
    assert.throws(() => executeQuestBoardAgentTool(trusted, "questboard_apply_source_structure_flow_sync",
      applyFields(p, "s5-stale-apply-01")),
    (error: unknown) => ["code_map_subsystem_snapshot_stale", "code_map_snapshot_changed"].includes(
      describeQuestBoardError(error).code));
    assert.equal(ctx.repository.listInvestigationNodes(ctx.projectId).length, 0);
  });
});
test("S5 bounded candidate pagination retains pins; legacy six-role names and schema are untouched", async () => {
  await fixture(async (ctx) => {
    const first = tool<CandidateResult>(ctx, "questboard_list_source_structure_candidates", {
      projectId: ctx.projectId, limit: 1,
    }).candidates;
    assert.equal(first.nodes.length, 1);
    assert.equal(first.hasMore, true);
    assert.equal(first.truncated, true);
    const second = tool<CandidateResult>(ctx, "questboard_list_source_structure_candidates", {
      projectId: ctx.projectId, limit: 1, offset: 1,
      expectedSnapshotId: first.snapshotId, expectedSourceIndexedAt: first.sourceIndexedAt,
    }).candidates;
    assert.equal(second.nodes.length, 1);
    assert.notEqual(second.nodes[0]?.id, first.nodes[0]?.id);
    assert.equal(second.snapshotId, first.snapshotId);
    assert.ok(QUESTBOARD_AGENT_TOOLS.some((tool) =>
      tool.name === "questboard_preview_code_map_investigation_sync"));
    assert.ok(QUESTBOARD_AGENT_TOOLS.some((tool) =>
      tool.name === "questboard_apply_code_map_investigation_sync"));
    assert.equal(ctx.repository.listInvestigationNodes(ctx.projectId).length, 0);
  });
});
test("S5 CLI apply without its explicit review/receipt flags rejects before accessing a mutation", async () => {
  await fixture(async (ctx) => {
    const p = prepare(ctx);
    const noApproval = await cli(authorize(ctx), ["source-structure-apply", ...flags(p.args),
      "--selection-fingerprint", p.preview.selectionFingerprint,
      "--new-selection", "--request-id", "s5-without-approval-01"]);
    assert.equal(noApproval.exitCode, 1);
    assert.equal(ctx.repository.listInvestigationNodes(ctx.projectId).length, 0);
    const noCas = await cli(authorize(ctx), ["source-structure-apply", ...flags(p.args),
      "--selection-fingerprint", p.preview.selectionFingerprint, "--approved",
      "--request-id", "s5-without-cas-01"]);
    assert.equal(noCas.exitCode, 1);
    assert.equal(ctx.repository.listInvestigationNodes(ctx.projectId).length, 0);
  });
});
test("S5 concurrent authorized HTTP apply requests serialize with one winner and no duplicate Flow", async () => {
  await fixture(async (ctx) => {
    const p = prepare(ctx);
    const h = await http(ctx, true);
    const authHeaders = {
      "x-questboard-actor-id": actor.id,
      "x-questboard-actor-provider": actor.provider,
      "x-s5-fixture-auth": "trusted-session",
    };
    try {
      const [first, second] = await Promise.all([
        h.post(route(ctx.projectId, "apply"), applyFields(p, "s5-race-first-01"), {
          ...authHeaders, "x-questboard-request-id": "s5-race-first-01",
        }),
        h.post(route(ctx.projectId, "apply"), applyFields(p, "s5-race-second-01"), {
          ...authHeaders, "x-questboard-request-id": "s5-race-second-01",
        }),
      ]);
      assert.deepEqual([first.status, second.status].sort(), [200, 409]);
      assert.equal(ctx.repository.listInvestigationNodes(ctx.projectId).length, 3);
      assert.equal(ctx.repository.listInvestigationItemLinks(ctx.projectId).length, 2);
      assert.equal(ctx.repository.sourceStructureBindings.getSelection(
        ctx.projectId, p.args.selectionKey)?.revision, 1);
    } finally { await h.close(); }
  });
});
