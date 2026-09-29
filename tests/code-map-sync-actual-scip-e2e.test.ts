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
  AgentFocusService,
  CodeMapInvestigationSyncService,
  CodeScopeBindingService,
  createQuestBoardHttpServer,
  QuestBoardService,
  SqliteQuestBoardRepository,
  type ActorRef,
} from "../src/index.js";
import { createConfiguredCodeMapRuntime } from "../src/server/code-map-config.js";

const actor: ActorRef = { id: "agent:actual-scip-sync-e2e", provider: "test" };
const chromeCandidates = [
  process.env.QUESTBOARD_CHROME_EXECUTABLE,
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter((candidate): candidate is string => Boolean(candidate));

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
  const scopeService = new CodeScopeBindingService(codeMapRuntime.service, repository, service);
  const focusService = new AgentFocusService(repository);
  const server = createQuestBoardHttpServer(service, {
    webRoot: resolve("web"),
    codeMapService: codeMapRuntime.service,
    codeMapInvestigationSyncService: syncService,
    codeScopeBindingService: scopeService,
    agentFocusService: focusService,
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
    const groupedNode = (indexed.body.graph.nodes as Array<{ id: string; name: string }>).find((node) => node.name === "createQuestBoardHttpServer");
    assert.ok(groupedNode, "actual SCIP graph should expose createQuestBoardHttpServer for Work Group aggregation proof");
    const groupTask = service.createTask({ projectId: project.id, title: "HTTP Work Group", status: "in_progress" }, actor);
    const groupChild = service.createTask({ projectId: project.id, title: "HTTP scoped child", status: "ready" }, actor);
    service.createRelation({
      fromType: "task",
      fromId: groupTask.id,
      toType: "task",
      toId: groupChild.id,
      kind: "contains",
    }, actor);
    const groupBinding = scopeService.attach({ projectId: project.id, taskId: groupChild.id, codeNodeId: groupedNode.id, kind: "targets" }, actor);
    const visualFlowGroup = service.createFlowWorkGroup({
      projectId: project.id,
      title: "SCIP Flow Group",
      linkedTaskId: groupTask.id,
      x: 520,
      y: 80,
      width: 520,
      height: 300,
    }, actor);
    service.setFlowWorkGroupMembership({
      groupId: visualFlowGroup.id,
      entityType: "task",
      entityId: groupChild.id,
    }, actor);
    focusService.set({
      projectId: project.id,
      sessionId: "actual-scip-agent",
      taskId: groupChild.id,
      workGroupId: visualFlowGroup.id,
      codeScopeId: groupedNode.id,
    });

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
        const sourceExplorer = document.querySelector('.code-map-source-panel');
        const nodes = document.querySelectorAll('.code-map-architecture-card').length;
        const relations = document.querySelectorAll('.code-map-architecture-relation').length;
        if (sourceExplorer && nodes === 6 && relations === 5 && sync && !sync.classList.contains('hidden')) {
          return { sourceExplorer: true, nodes, relations, status: document.querySelector('#code-map-status')?.textContent || '' };
        }
        await sleep(100);
      }
      throw new Error('Code Map render timeout');
    })()`);
    assert.deepEqual(
      { sourceExplorer: codeMapRender.sourceExplorer, nodes: codeMapRender.nodes, relations: codeMapRender.relations },
      { sourceExplorer: true, nodes: 6, relations: 5 },
    );
    assert.match(codeMapRender.status, /scip-typescript/);

    const rawExplorer = await cdp.evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const search = document.querySelector('#code-map-search');
      search.value = 'createQuestBoardHttpServer';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const result = [...document.querySelectorAll('.code-map-search-result')]
          .find((item) => item.textContent.includes('createQuestBoardHttpServer'));
        if (result) {
          result.click();
          break;
        }
        await sleep(100);
      }
      while (Date.now() < deadline) {
        const title = document.querySelector('#code-map-inspector-title')?.textContent || '';
        const location = document.querySelector('.code-map-location-path')?.textContent || '';
        const navigation = [...document.querySelectorAll('.code-map-inspector-navigation')].find((item) => {
          const section = item.closest('.code-map-inspector-section')?.querySelector('.code-map-inspector-section-title')?.textContent || '';
          const meta = item.querySelector('.code-map-inspector-navigation-meta')?.textContent || '';
          return ['Calls', 'Called by', 'References', 'Referenced by'].includes(section)
            && meta.includes('src/')
            && !meta.includes('src/server/http-api.ts');
        });
        if (title === 'createQuestBoardHttpServer' && location && navigation) {
          const target = navigation.querySelector('.code-map-inspector-navigation-title')?.textContent || '';
          const targetMeta = navigation.querySelector('.code-map-inspector-navigation-meta')?.textContent || '';
          const relationSection = navigation.closest('.code-map-inspector-section')?.querySelector('.code-map-inspector-section-title')?.textContent || '';
          navigation.click();
          while (Date.now() < deadline) {
            const navigatedTitle = document.querySelector('#code-map-inspector-title')?.textContent || '';
            const back = document.querySelector('#code-map-back');
            if (navigatedTitle && navigatedTitle !== title && back && !back.disabled) {
              back.click();
              while (Date.now() < deadline) {
                const restoredTitle = document.querySelector('#code-map-inspector-title')?.textContent || '';
                const restoredLocation = document.querySelector('.code-map-location-path')?.textContent || '';
                if (restoredTitle === title && restoredLocation.includes('src/server/http-api.ts')) {
                  return { title, location, target, targetMeta, relationSection, navigatedTitle, restoredTitle, restoredLocation };
                }
                await sleep(100);
              }
            }
            await sleep(100);
          }
        }
        await sleep(100);
      }
      throw new Error('Raw Code explorer search/inspector timeout');
    })()`);
    assert.equal(rawExplorer.title, "createQuestBoardHttpServer");
    assert.match(rawExplorer.location, /src\/server\/http-api\.ts/);
    assert.ok(rawExplorer.target);
    assert.match(rawExplorer.targetMeta, /src\//);
    assert.doesNotMatch(rawExplorer.targetMeta, /src\/server\/http-api\.ts/);
    assert.match(rawExplorer.relationSection, /^(Calls|Called by|References|Referenced by)$/);
    assert.notEqual(rawExplorer.navigatedTitle, rawExplorer.title);
    assert.equal(rawExplorer.restoredTitle, rawExplorer.title);
    assert.match(rawExplorer.restoredLocation, /src\/server\/http-api\.ts/);

    const agentFollowBrowser = await cdp.evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const control = document.querySelector('#agent-focus-control');
        const status = document.querySelector('#agent-focus-status')?.textContent || '';
        const follow = document.querySelector('#agent-focus-follow');
        if (control && !control.classList.contains('hidden') && status.includes('actual-scip-agent') && follow) {
          follow.click();
          break;
        }
        await sleep(100);
      }
      while (Date.now() < deadline) {
        const follow = document.querySelector('#agent-focus-follow');
        const title = document.querySelector('#workspace-title')?.textContent || '';
        const inspector = document.querySelector('#code-map-inspector-title')?.textContent || '';
        if (follow?.classList.contains('active') && title === 'Code' && inspector === 'createQuestBoardHttpServer') {
          document.querySelector('#agent-focus-free')?.click();
          document.querySelector('[data-board-view="quest"]')?.click();
          await sleep(100);
          const returnButton = document.querySelector('#agent-focus-return');
          if (returnButton && !returnButton.classList.contains('hidden')) {
            returnButton.click();
            while (Date.now() < deadline) {
              const returnedTitle = document.querySelector('#workspace-title')?.textContent || '';
              const returnedInspector = document.querySelector('#code-map-inspector-title')?.textContent || '';
              if (returnedTitle === 'Code' && returnedInspector === 'createQuestBoardHttpServer') {
                return { status: document.querySelector('#agent-focus-status')?.textContent || '', returnedTitle, returnedInspector };
              }
              await sleep(100);
            }
          }
        }
        await sleep(100);
      }
      throw new Error('Agent Focus Follow/Free/Return timeout');
    })()`);
    assert.match(agentFollowBrowser.status, /actual-scip-agent/);
    assert.equal(agentFollowBrowser.returnedTitle, "Code");
    assert.equal(agentFollowBrowser.returnedInspector, "createQuestBoardHttpServer");

    const phase5RoundTrip = await cdp.evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const deadline = Date.now() + 15000;
      let relatedFlowText = '';
      while (Date.now() < deadline) {
        const section = [...document.querySelectorAll('.code-map-inspector-section')]
          .find((item) => item.querySelector('.code-map-inspector-section-title')?.textContent === 'Related Flow');
        const show = section ? [...section.querySelectorAll('button')].find((button) => button.textContent === 'Show in Flow') : null;
        relatedFlowText = section?.textContent || '';
        if (show && !show.disabled && relatedFlowText.includes('SCIP Flow Group')) {
          show.click();
          break;
        }
        await sleep(100);
      }
      while (Date.now() < deadline) {
        const title = document.querySelector('#workspace-title')?.textContent || '';
        const group = [...document.querySelectorAll('.flow-work-group')]
          .find((item) => item.textContent.includes('SCIP Flow Group'));
        const lensButton = document.querySelector('#investigation-code-lens');
        const scope = group ? [...group.querySelectorAll('.flow-code-scope-chip')]
          .find((item) => item.textContent.includes('createQuestBoardHttpServer')) : null;
        if (title === 'Flow' && group?.classList.contains('code-focus-related') && lensButton?.classList.contains('active') && scope) {
          const groupText = group.textContent || '';
          scope.click();
          while (Date.now() < deadline) {
            const codeTitle = document.querySelector('#workspace-title')?.textContent || '';
            const inspectorTitle = document.querySelector('#code-map-inspector-title')?.textContent || '';
            const flowSection = [...document.querySelectorAll('.code-map-inspector-section')]
              .find((item) => item.querySelector('.code-map-inspector-section-title')?.textContent === 'Related Flow');
            if (codeTitle === 'Code' && inspectorTitle === 'createQuestBoardHttpServer' && flowSection?.textContent.includes('SCIP Flow Group')) {
              return { relatedFlowText, groupText, inspectorTitle, flowText: flowSection.textContent || '' };
            }
            await sleep(100);
          }
        }
        await sleep(100);
      }
      throw new Error('Phase 5 Flow-Code round-trip timeout');
    })()`);
    assert.match(phase5RoundTrip.relatedFlowText, /SCIP Flow Group/);
    assert.match(phase5RoundTrip.groupText, /createQuestBoardHttpServer/);
    assert.equal(phase5RoundTrip.inspectorTitle, "createQuestBoardHttpServer");
    assert.match(phase5RoundTrip.flowText, /SCIP Flow Group/);

    const persisted = repository.getTaskCodeScopeBinding(groupBinding.id)!;
    repository.updateTaskCodeScopeBinding({
      ...persisted,
      codeNodeId: "code:node:pre-refactor-id",
      updatedBy: actor.id,
      updatedByProvider: actor.provider,
      updatedAt: "2026-09-29T05:00:00.000Z",
      revision: persisted.revision + 1,
    }, persisted.revision);
    const relinkBrowser = await cdp.evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      await openTask(${JSON.stringify(groupChild.id)});
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const row = [...document.querySelectorAll('.task-code-scope-row')]
          .find((item) => item.textContent.includes('createQuestBoardHttpServer') && item.textContent.includes('relinkable'));
        const relink = row ? [...row.querySelectorAll('button')].find((button) => button.textContent === 'Relink') : null;
        if (relink) {
          const before = row.textContent || '';
          relink.click();
          while (Date.now() < deadline) {
            const active = [...document.querySelectorAll('.task-code-scope-row')]
              .find((item) => item.textContent.includes('createQuestBoardHttpServer') && item.textContent.includes('active'));
            if (active) return { before, after: active.textContent || '' };
            await sleep(100);
          }
        }
        await sleep(100);
      }
      throw new Error('CodeScope relink browser timeout');
    })()`);
    assert.match(relinkBrowser.before, /relinkable/i);
    assert.match(relinkBrowser.after, /active/i);
    assert.equal(scopeService.list(project.id, { taskId: groupChild.id })[0]?.codeNodeId, groupedNode.id);
    await cdp.evaluate(`closeDrawer(); true`);

    const groupAggregationBrowser = await cdp.evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const group = [...document.querySelectorAll('.code-scope-task-group')]
          .find((item) => item.textContent.includes('HTTP Work Group') && item.textContent.includes('HTTP scoped child'));
        const open = group ? [...group.querySelectorAll('button')].find((button) => button.textContent === 'Open Group') : null;
        if (open) {
          open.click();
          break;
        }
        await sleep(100);
      }
      while (Date.now() < deadline) {
        const title = document.querySelector('#drawer-title')?.textContent || '';
        const summary = document.querySelector('.task-code-scope-summary')?.textContent || '';
        const scope = [...document.querySelectorAll('.task-code-scope-row')]
          .find((item) => item.textContent.includes('HTTP scoped child') && item.textContent.includes('targets'));
        if (title === 'HTTP Work Group' && summary.includes('1 CodeScope') && summary.includes('1 descendant binding') && scope) {
          return { title, summary, scope: scope.textContent || '' };
        }
        await sleep(100);
      }
      throw new Error('Work Group descendant CodeScope aggregation timeout');
    })()`);
    assert.equal(groupAggregationBrowser.title, "HTTP Work Group");
    assert.match(groupAggregationBrowser.summary, /1 CodeScope/);
    assert.match(groupAggregationBrowser.summary, /1 descendant binding/);
    assert.match(groupAggregationBrowser.scope, /HTTP scoped child/);
    await cdp.evaluate(`closeDrawer(); true`);

    const codeScopeBrowser = await cdp.evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      window.prompt = (message) => message.includes('Task title') ? 'Browser scoped task' : message.includes('Goal') ? 'Preserve browser CodeScope context' : null;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const section = [...document.querySelectorAll('.code-map-inspector-section')]
          .find((item) => item.querySelector('.code-map-inspector-section-title')?.textContent === 'Related Tasks');
        const add = section?.querySelector('button');
        if (add) {
          add.click();
          break;
        }
        await sleep(100);
      }
      while (Date.now() < deadline) {
        const section = [...document.querySelectorAll('.code-map-inspector-section')]
          .find((item) => item.querySelector('.code-map-inspector-section-title')?.textContent === 'Related Tasks');
        const row = section ? [...section.querySelectorAll('.code-scope-task-row')]
          .find((item) => item.textContent.includes('Browser scoped task')) : null;
        if (row) {
          row.click();
          break;
        }
        await sleep(100);
      }
      while (Date.now() < deadline) {
        const drawer = document.querySelector('#task-drawer');
        const scopeRow = drawer?.querySelector('.task-code-scope-row');
        const title = document.querySelector('#drawer-title')?.textContent || '';
        if (drawer?.classList.contains('open') && title === 'Browser scoped task' && scopeRow) {
          const before = scopeRow.textContent;
          const detach = [...scopeRow.querySelectorAll('button')].find((button) => button.textContent === 'Detach');
          detach?.click();
          while (Date.now() < deadline) {
            const empty = document.querySelector('.task-code-scope-section .muted')?.textContent || '';
            if (empty.includes('remains valid without one')) return { title, before, empty };
            await sleep(100);
          }
        }
        await sleep(100);
      }
      throw new Error('CodeScope Task create/drawer/detach timeout');
    })()`);
    assert.equal(codeScopeBrowser.title, "Browser scoped task");
    assert.match(codeScopeBrowser.before, /targets · active/i);
    assert.match(codeScopeBrowser.empty, /remains valid without one/);
    assert.equal(scopeService.list(project.id).some((binding) => binding.task.title === "Browser scoped task"), false, "browser detach should remove only the selected binding");
    assert.equal(scopeService.list(project.id).some((binding) => binding.task.title === "HTTP scoped child"), true, "Work Group descendant binding should remain intact");
    assert.ok(service.listTasks({ projectId: project.id }).some((task) => task.title === "Browser scoped task"), "targetless Task must remain after detach");

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
        if (title === 'Flow' && nodes === 6 && focused > 0) return focused;
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
        if (title === 'Flow' && nodes === 6 && items === 5 && flows === 5 && badges >= 11) {
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
      { title: "Flow", nodes: 6, items: 5, flows: 5 },
    );
    assert.ok(investigationRender.badges >= 11);

    const syncedForCodeLens = service.getInvestigationGraph(project.id);
    const linkedFlowItem = syncedForCodeLens.items[0];
    assert.ok(linkedFlowItem, "Code→Flow lens needs one real synced Flow Item for highlight proof");
    service.linkTaskToInvestigationItem(linkedFlowItem.id, groupChild.id, actor);
    const flowItemFocus = await cdp.evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      await loadBoard();
      setViewMode('code-map');
      await loadCodeMapContext();
      await openCodeMapNode(${JSON.stringify(groupedNode.id)});
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const section = [...document.querySelectorAll('.code-map-inspector-section')]
          .find((entry) => entry.querySelector('.code-map-inspector-section-title')?.textContent === 'Related Flow');
        const show = section ? [...section.querySelectorAll('button')].find((button) => button.textContent === 'Show in Flow') : null;
        if (show && !show.disabled) {
          show.click();
          break;
        }
        await sleep(100);
      }
      while (Date.now() < deadline) {
        const title = document.querySelector('#workspace-title')?.textContent || '';
        const item = document.querySelector('[data-investigation-item-id="' + ${JSON.stringify(linkedFlowItem.id)} + '"]');
        const group = [...document.querySelectorAll('.flow-work-group')].find((entry) => entry.textContent.includes('SCIP Flow Group'));
        if (title === 'Flow' && item?.classList.contains('code-focus-related') && group?.classList.contains('code-focus-related')) {
          return { title, itemFocused: true, groupFocused: true };
        }
        await sleep(100);
      }
      throw new Error('Phase 5 related Flow Item highlight timeout');
    })()`);
    assert.deepEqual(flowItemFocus, { title: "Flow", itemFocused: true, groupFocused: true });

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
