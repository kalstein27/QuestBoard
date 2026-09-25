import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  CodeMapInvestigationSyncService,
  createQuestBoardHttpServer,
  QuestBoardService,
  SqliteQuestBoardRepository,
  type ActorRef,
} from "../src/index.js";
import { createConfiguredCodeMapRuntime } from "../src/server/code-map-config.js";

const actor: ActorRef = { id: "agent:actual-scip-sync-e2e", provider: "test" };
const chromeCandidates = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
];

test("actual SCIP indexes 6/5, Web syncs to Investigation, and MCP/HTTP agree", { timeout: 120_000 }, async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), "questboard-actual-scip-sync-"));
  const repository = new SqliteQuestBoardRepository(join(tempRoot, "questboard.sqlite"));
  const service = new QuestBoardService(repository);
  const projectRoot = resolve(process.cwd());
  const project = service.createProject(
    { name: "Actual SCIP Sync E2E", rootPath: projectRoot },
    actor,
  );
  const codeMapRuntime = createConfiguredCodeMapRuntime({
    ...process.env,
    QUESTBOARD_CODE_MAP: "1",
    QUESTBOARD_CODE_MAP_PROVIDER: "scip-typescript",
    QUESTBOARD_CODE_MAP_STORAGE_ROOT: join(tempRoot, "code-map"),
  });

  assert.ok(codeMapRuntime.service, JSON.stringify(codeMapRuntime.availability));
  assert.equal(codeMapRuntime.availability.available, true, JSON.stringify(codeMapRuntime.availability));

  const syncService = new CodeMapInvestigationSyncService(codeMapRuntime.service, repository);
  const server = createQuestBoardHttpServer(service, {
    webRoot: resolve("web"),
    codeMapService: codeMapRuntime.service,
    codeMapInvestigationSyncService: syncService,
    codeMapAvailability: codeMapRuntime.availability,
  });
  let chrome: ChildProcess | undefined;
  let cdp: CdpClient | undefined;

  try {
    await listen(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const codeMapUrl = `${baseUrl}/projects/${encodeURIComponent(project.id)}/code-map`;
    const previewUrl = `${codeMapUrl}/investigation-sync/preview`;

    const indexed = await json(codeMapUrl, { method: "POST" });
    assert.equal(indexed.response.status, 200, JSON.stringify(indexed.body));
    assert.equal(indexed.body.provider, "scip-typescript");
    assert.equal(indexed.body.projection.nodes.length, 6);
    assert.equal(indexed.body.projection.relations.length, 5);

    const preview = await json(previewUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ includeRelations: true, recreateDetached: false }),
    });
    assert.equal(preview.response.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.preview.counts.nodes.create, 6);
    assert.equal(preview.body.preview.counts.relations.create, 5);
    const projectionFingerprint = preview.body.preview.projectionFingerprint as string;

    const chromePath = chromeCandidates.find(existsSync);
    if (!chromePath) {
      throw new Error("Chrome/Chromium is unavailable for the browser portion of the actual SCIP E2E");
    }

    const userDataDir = join(tempRoot, "chrome");
    chrome = spawn(
      chromePath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        baseUrl,
      ],
      { stdio: "ignore" },
    );

    const devToolsPortFile = join(userDataDir, "DevToolsActivePort");
    await waitUntil(() => existsSync(devToolsPortFile), 15_000, "Chrome DevToolsActivePort");
    const [debugPort] = readFileSync(devToolsPortFile, "utf8").trim().split(/\r?\n/);
    assert.ok(debugPort);
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json()) as Array<{
      type: string;
      url: string;
      webSocketDebuggerUrl?: string;
    }>;
    const page = targets.find((target) => target.type === "page" && target.url.startsWith(baseUrl))
      ?? targets.find((target) => target.type === "page");
    assert.ok(page?.webSocketDebuggerUrl, "headless Chrome page target must expose a CDP WebSocket");
    cdp = await CdpClient.connect(page.webSocketDebuggerUrl);
    await cdp.call("Runtime.enable");
    await cdp.call("Page.enable");

    await cdp.evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (document.querySelector('#project-select option')) return true;
        await sleep(100);
      }
      throw new Error('QuestBoard boot timeout');
    })()`);
    await cdp.evaluate(`document.querySelector('[data-board-view="code-map"]').click(); true`);
    const codeMapRender = await cdp.evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const sync = document.querySelector('#code-map-sync');
        const nodes = document.querySelectorAll('.code-map-node').length;
        const relations = document.querySelectorAll('.code-map-relation').length;
        if (nodes === 6 && relations === 5 && sync && !sync.classList.contains('hidden')) {
          return { nodes, relations, status: document.querySelector('#code-map-status')?.textContent || '' };
        }
        await sleep(100);
      }
      throw new Error('Code Map render timeout');
    })()`);
    assert.deepEqual(
      { nodes: codeMapRender.nodes, relations: codeMapRender.relations },
      { nodes: 6, relations: 5 },
    );
    assert.match(codeMapRender.status, /scip-typescript/);

    await cdp.evaluate(`document.querySelector('#code-map-sync').click(); true`);
    const browserPreview = await cdp.evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const dialog = document.querySelector('#code-map-sync-dialog');
        const rows = document.querySelectorAll('.code-map-sync-row').length;
        const values = [...document.querySelectorAll('.code-map-sync-stat-value')].map((item) => item.textContent);
        if (dialog?.open && rows === 11 && values[0] === '6' && values[1] === '5') {
          return { rows, values };
        }
        await sleep(100);
      }
      throw new Error('Code Map sync preview timeout');
    })()`);
    assert.equal(browserPreview.rows, 11);
    assert.deepEqual(browserPreview.values.slice(0, 2), ["6", "5"]);

    await cdp.evaluate(`document.querySelector('#code-map-sync-apply').click(); true`);
    const browserResult = await cdp.evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const copy = document.querySelector('.code-map-sync-result-copy')?.textContent || '';
        const open = document.querySelector('#code-map-sync-open-investigation');
        const values = [...document.querySelectorAll('.code-map-sync-stat-value')].map((item) => item.textContent);
        if (copy.includes('Sync completed') && open && !open.classList.contains('hidden')) {
          return { copy, values };
        }
        await sleep(100);
      }
      throw new Error('Code Map sync apply timeout');
    })()`);
    assert.equal(browserResult.values[0], "6");
    assert.equal(browserResult.values[1], "5");

    await cdp.evaluate(`document.querySelector('#code-map-sync-open-investigation').click(); true`);
    const focusedAfterNavigation = await cdp.evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const title = document.querySelector('#workspace-title')?.textContent || '';
        const nodes = document.querySelectorAll('.investigation-graph-node').length;
        const focused = document.querySelectorAll('.investigation-graph-node.code-map-sync-focus').length;
        if (title === 'Investigation' && nodes === 6 && focused > 0) return focused;
        await sleep(50);
      }
      return 0;
    })()`);
    assert.ok(focusedAfterNavigation > 0, "newly synced Code Map nodes should be visibly focused after navigation");
    const investigationRender = await cdp.evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const title = document.querySelector('#workspace-title')?.textContent || '';
        const nodes = document.querySelectorAll('.investigation-graph-node').length;
        const items = document.querySelectorAll('.investigation-item').length;
        const flows = document.querySelectorAll('.investigation-flow-line').length;
        const badges = document.querySelectorAll('.code-map-binding-badge').length;
        if (title === 'Investigation' && nodes === 6 && items === 5 && flows === 5 && badges >= 11) {
          return { title, nodes, items, flows, badges };
        }
        await sleep(100);
      }
      throw new Error('Investigation render timeout');
    })()`);
    assert.deepEqual(
      {
        title: investigationRender.title,
        nodes: investigationRender.nodes,
        items: investigationRender.items,
        flows: investigationRender.flows,
      },
      { title: "Investigation", nodes: 6, items: 5, flows: 5 },
    );
    assert.ok(investigationRender.badges >= 11);

    const graph = await json(`${baseUrl}/projects/${encodeURIComponent(project.id)}/investigation/graph`);
    assert.equal(graph.body.nodes.length, 6);
    assert.equal(graph.body.items.length, 5);
    assert.equal(graph.body.itemLinks.length, 5);

    const mcpPreview = await mcpToolCall(baseUrl, "actual-scip-sync-session", 1, "questboard_preview_code_map_investigation_sync", {
      projectId: project.id,
    });
    assert.equal(mcpPreview.preview.counts.nodes.unchanged, 6);
    assert.equal(mcpPreview.preview.counts.relations.unchanged, 5);
    assert.equal(mcpPreview.preview.projectionFingerprint, projectionFingerprint);

    const mcpApply = await mcpToolCall(baseUrl, "actual-scip-sync-session", 2, "questboard_apply_code_map_investigation_sync", {
      projectId: project.id,
      expectedProjectionFingerprint: projectionFingerprint,
      actor,
      requestId: "actual-scip-sync-mcp-rerun-0001",
    });
    assert.equal(mcpApply.result.counts.createdNodes, 0);
    assert.equal(mcpApply.result.counts.createdRelationItems, 0);
    assert.equal(mcpApply.result.counts.createdRelationLinks, 0);
    assert.equal(mcpApply.result.counts.unchangedNodes, 6);
    assert.equal(mcpApply.result.counts.unchangedRelations, 5);

    const httpPreviewAfterMcp = await json(previewUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ includeRelations: true }),
    });
    assert.equal(httpPreviewAfterMcp.body.preview.counts.nodes.unchanged, 6);
    assert.equal(httpPreviewAfterMcp.body.preview.counts.relations.unchanged, 5);
    const finalGraph = await json(`${baseUrl}/projects/${encodeURIComponent(project.id)}/investigation/graph`);
    assert.equal(finalGraph.body.nodes.length, 6);
    assert.equal(finalGraph.body.items.length, 5);
    assert.equal(finalGraph.body.itemLinks.length, 5);
  } finally {
    if (cdp) {
      await cdp.call("Browser.close").catch(() => undefined);
      cdp.close();
    }
    if (chrome) {
      if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGTERM");
      await waitForChildExit(chrome, 5_000);
    }
    await closeServer(server);
    repository.close();
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function mcpToolCall(
  baseUrl: string,
  sessionId: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  const response = await json(`${baseUrl}/_questboard/mcp-proxy`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-questboard-daemon-client": "1" },
    body: JSON.stringify({
      sessionId,
      message: {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      },
    }),
  });
  assert.equal(response.response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.result?.isError, undefined, JSON.stringify(response.body));
  const content = response.body.result?.content as Array<{ text?: string }>;
  return JSON.parse(content?.[0]?.text ?? "{}");
}

class CdpClient {
  readonly #socket: WebSocket;
  #nextId = 1;
  readonly #pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: any; error?: { message?: string } };
      if (message.id === undefined) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "CDP command failed"));
      else pending.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) pending.reject(new Error("CDP socket closed"));
      this.#pending.clear();
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => rejectOpen(new Error("CDP WebSocket open timeout")), 10_000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolveOpen();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        rejectOpen(new Error("CDP WebSocket failed to open"));
      }, { once: true });
    });
    return new CdpClient(socket);
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.#nextId++;
    const response = new Promise<any>((resolveResult, rejectResult) => {
      this.#pending.set(id, { resolve: resolveResult, reject: rejectResult });
    });
    this.#socket.send(JSON.stringify({ id, method, params }));
    return await response;
  }

  async evaluate(expression: string): Promise<any> {
    const response = await this.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "Runtime.evaluate failed");
    }
    return response.result?.value;
  }

  close(): void {
    try {
      this.#socket.close();
    } catch {
      // Browser.close may have already closed the socket.
    }
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`${label} timeout`);
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, timeoutMs)),
  ]);
}

async function listen(server: ReturnType<typeof createQuestBoardHttpServer>): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => rejectListen(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolveListen();
    });
  });
}

async function closeServer(server: ReturnType<typeof createQuestBoardHttpServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

async function json(
  url: string,
  options: RequestInit = {},
): Promise<{ response: Response; body: any }> {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}
