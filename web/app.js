const STATUSES = [
  ["inbox", "Inbox"],
  ["planned", "Planned"],
  ["ready", "Ready"],
  ["in_progress", "In Progress"],
  ["blocked", "Blocked"],
  ["review", "Review"],
  ["done", "Done"],
];

const PRIORITIES = ["low", "normal", "high", "urgent"];
const ARTIFACT_TYPES = ["file", "url", "commit", "screenshot", "operation", "log", "other"];
const CODE_MAP_TREE_PAGE_SIZE = 80;
const FLOW_CODE_LENS_SCOPE_LIMIT = 40;
const FLOW_CODE_LENS_INLINE_LIMIT = 6;

const state = {
  projects: [],
  projectId: null,
  viewMode: loadViewMode(),
  hideCompleted: loadHideCompleted(),
  seenDoneTaskIds: new Set(),
  seenDoneProjectId: null,
  taskHierarchy: null,
  tasks: [],
  claims: new Map(),
  selectedTaskId: null,
  activities: [],
  artifacts: [],
  relations: [],
  projectArtifacts: [],
  projectRelations: [],
  investigationGraphNodes: [],
  investigationGraphItems: [],
  investigationItemLinks: [],
  investigationItemTaskLinks: [],
  flowWorkGroups: [],
  flowWorkGroupMemberships: [],
  boardPositions: new Map(),
  displayPositions: new Map(),
  investigationZoom: loadInvestigationZoom(),
  investigationPan: loadInvestigationPan(),
  investigationViewportMeta: loadInvestigationViewportMeta(),
  investigationPointers: new Map(),
  investigationGesture: null,
  investigationUndo: [],
  investigationRedo: [],
  investigationHistoryBusy: false,
  selectedInvestigationNodeId: null,
  flowCodeLensEnabled: false,
  flowCodeFocus: { groupId: null, taskId: null, codeNodeId: null },
  agentFocus: null,
  agentFocusMode: "free",
  agentFocusLastAppliedAt: null,
  agentFocusPollTimer: null,
  codeMap: { enabled: false, available: false, indexed: false, graph: null, projection: null, mode: null },
  codeMapLoading: false,
  codeMapIndexError: null,
  selectedCodeMapDetail: null,
  codeMapInspectorData: null,
  codeMapInspectorLoading: false,
  codeMapNavigationHistory: [],
  codeMapExpandedTreeKeys: new Set(),
  codeMapTreeVisibleCounts: new Map(),
  codeMapSearchResults: null,
  codeMapSearchLoading: false,
  codeMapSearchTimer: null,
  codeMapSyncPreview: null,
  codeMapSyncResult: null,
  codeMapSyncLoading: false,
  codeMapSyncFocusNodeIds: [],
  codeMapSyncFocusDeadline: 0,
  codeMapSyncFocusCentered: false,
  actor: loadActor(),
  busy: false,
  boardError: null,
};

const el = {};

window.addEventListener("DOMContentLoaded", () => {
  collectElements();
  populateStaticOptions();
  bindEvents();
  renderActor();
  void boot();
});

function collectElements() {
  [
    "project-select", "new-project-button", "new-task-button", "refresh-button", "hide-completed-control", "hide-completed-toggle", "unseen-done-count",
    "actor-id", "actor-provider", "save-actor-button", "board-loading", "board-empty", "board-error", "board-error-message", "board-error-retry",
    "project-empty", "quest-board", "kanban-board", "empty-new-task-button", "empty-new-project-button",
    "investigation-board", "investigation-canvas", "investigation-groups", "investigation-edges", "investigation-nodes",
    "investigation-controls", "investigation-undo", "investigation-redo", "investigation-zoom-out", "investigation-code-lens",
    "investigation-zoom-reset", "investigation-zoom-in", "investigation-fit", "investigation-add-node", "investigation-add-group",
    "investigation-inspector", "investigation-inspector-title", "investigation-inspector-body", "investigation-inspector-close",
    "code-map-board", "code-map-status", "code-map-refresh", "code-map-sync", "code-map-content",
    "code-map-search", "code-map-kind-filter", "code-map-language-filter", "code-map-back",
    "code-map-inspector", "code-map-inspector-kicker", "code-map-inspector-title", "code-map-inspector-body", "code-map-inspector-close",
    "code-map-sync-dialog", "code-map-sync-close", "code-map-sync-body", "code-map-sync-recreate-row",
    "code-map-sync-recreate-detached", "code-map-sync-open-investigation", "code-map-sync-apply",
    "workspace-title", "workspace-context", "workspace-nav", "agent-focus-control", "agent-focus-status",
    "agent-focus-follow", "agent-focus-free", "agent-focus-return",
    "task-drawer", "drawer-status", "drawer-title", "drawer-body", "close-drawer-button",
    "drawer-scrim", "task-dialog", "task-form", "task-dialog-title", "task-id", "task-title",
    "task-description", "task-goal", "task-status", "task-priority", "task-tags", "task-more", "project-dialog",
    "project-form", "project-name", "project-description", "toast", "connection-label",
  ].forEach((id) => { el[id] = document.getElementById(id); });
}

function populateStaticOptions() {
  el["task-status"].replaceChildren(...STATUSES.map(([value, label]) => option(value, label)));
  el["task-priority"].replaceChildren(...PRIORITIES.map((value) => option(value, capitalize(value))));
}

function bindEvents() {
  el["project-select"].addEventListener("change", () => {
    state.projectId = el["project-select"].value || null;
    localStorage.setItem("questboard.projectId", state.projectId ?? "");
    closeDrawer();
    resetCodeMapExplorerState();
    void loadBoard();
  });
  el["new-project-button"].addEventListener("click", openProjectDialog);
  el["empty-new-project-button"].addEventListener("click", openProjectDialog);
  el["new-task-button"].addEventListener("click", () => openTaskDialog());
  el["empty-new-task-button"].addEventListener("click", () => openTaskDialog());
  el["refresh-button"].addEventListener("click", () => void refreshAll());
  el["agent-focus-follow"].addEventListener("click", () => {
    state.agentFocusMode = "follow";
    renderAgentFocusControls();
    void applyLatestAgentFocus();
  });
  el["agent-focus-free"].addEventListener("click", () => {
    state.agentFocusMode = "free";
    renderAgentFocusControls();
  });
  el["agent-focus-return"].addEventListener("click", () => void applyLatestAgentFocus());
  el["hide-completed-toggle"].addEventListener("change", () => {
    state.hideCompleted = el["hide-completed-toggle"].checked;
    localStorage.setItem("questboard.hideCompleted", String(state.hideCompleted));
    renderBoard();
  });
  el["board-error-retry"].addEventListener("click", () => void refreshAll());
  el["code-map-refresh"].addEventListener("click", () => void refreshCodeMap());
  el["code-map-sync"].addEventListener("click", () => void openCodeMapSyncPreview());
  el["code-map-search"].addEventListener("input", scheduleCodeMapSearch);
  el["code-map-kind-filter"].addEventListener("change", () => void runCodeMapSearch());
  el["code-map-language-filter"].addEventListener("change", () => void runCodeMapSearch());
  el["code-map-back"].addEventListener("click", navigateCodeMapBack);
  el["code-map-inspector-close"].addEventListener("click", clearCodeMapSelection);
  el["code-map-sync-close"].addEventListener("click", () => el["code-map-sync-dialog"].close());
  el["code-map-sync-recreate-detached"].addEventListener("change", renderCodeMapSyncDialog);
  el["code-map-sync-apply"].addEventListener("click", () => void applyCodeMapSync());
  el["code-map-sync-open-investigation"].addEventListener("click", () => void openInvestigationFromCodeMapSync());
  el["workspace-nav"].querySelectorAll("[data-board-view]").forEach((button) => {
    button.addEventListener("click", () => setViewMode(button.dataset.boardView));
  });
  el["investigation-undo"].addEventListener("click", () => void undoInvestigationMove());
  el["investigation-redo"].addEventListener("click", () => void redoInvestigationMove());
  el["investigation-zoom-out"].addEventListener("click", () => setInvestigationZoom(state.investigationZoom - 0.15));
  el["investigation-zoom-reset"].addEventListener("click", resetInvestigationViewport);
  el["investigation-zoom-in"].addEventListener("click", () => setInvestigationZoom(state.investigationZoom + 0.15));
  el["investigation-fit"].addEventListener("click", fitInvestigationContent);
  el["investigation-code-lens"].addEventListener("click", toggleFlowCodeLens);
  el["investigation-inspector-close"].addEventListener("click", clearInvestigationSelection);
  el["investigation-add-node"].addEventListener("click", () => void createInvestigationNodeFromPrompt());
  el["investigation-add-group"].addEventListener("click", () => void createFlowWorkGroupFromPrompt());
  bindInvestigationViewportGestures();
  el["save-actor-button"].addEventListener("click", saveActor);
  el["task-form"].addEventListener("submit", (event) => void saveTask(event));
  el["project-form"].addEventListener("submit", (event) => void saveProject(event));
  el["close-drawer-button"].addEventListener("click", closeDrawer);
  el["drawer-scrim"].addEventListener("click", closeDrawer);
  document.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => document.getElementById(button.dataset.closeDialog)?.close());
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDrawer();
    if (state.viewMode !== "investigation" || isEditingTarget(event.target)) return;
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) void redoInvestigationMove();
      else void undoInvestigationMove();
    } else if (modifier && event.key.toLowerCase() === "y") {
      event.preventDefault();
      void redoInvestigationMove();
    }
  });
}

function isEditingTarget(target) {
  return target instanceof HTMLElement
    && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

async function boot() {
  try {
    await loadProjects();
    await loadBoard();
    startAgentFocusPolling();
    setConnection("Local board · connected");
  } catch (error) {
    fail(error);
  }
}

function startAgentFocusPolling() {
  if (state.agentFocusPollTimer) return;
  void refreshAgentFocus();
  state.agentFocusPollTimer = window.setInterval(() => void refreshAgentFocus(), 1500);
}

async function refreshAgentFocus() {
  if (!state.projectId) {
    state.agentFocus = null;
    renderAgentFocusControls();
    return;
  }
  try {
    const { focus } = await api(`/projects/${encodeURIComponent(state.projectId)}/agent-focus`);
    const changed = Boolean(focus?.updatedAt && focus.updatedAt !== state.agentFocus?.updatedAt);
    state.agentFocus = focus || null;
    renderAgentFocusControls();
    if (changed && state.agentFocusMode === "follow") await applyLatestAgentFocus();
  } catch {
    state.agentFocus = null;
    renderAgentFocusControls();
  }
}

function renderAgentFocusControls() {
  const control = el["agent-focus-control"];
  if (!control) return;
  const focus = state.agentFocus;
  control.classList.toggle("hidden", !focus);
  if (!focus) return;
  el["agent-focus-status"].textContent = `Watching · ${focus.sessionId}`;
  el["agent-focus-follow"].classList.toggle("active", state.agentFocusMode === "follow");
  el["agent-focus-free"].classList.toggle("active", state.agentFocusMode === "free");
  el["agent-focus-return"].classList.toggle("hidden", state.agentFocusMode === "follow");
}

async function applyLatestAgentFocus() {
  const focus = state.agentFocus;
  if (!focus || focus.projectId !== state.projectId) return;
  state.agentFocusLastAppliedAt = focus.updatedAt;
  if (focus.codeScopeId) {
    await jumpToCodeScope(focus.codeScopeId);
    return;
  }
  if (focus.workGroupId || focus.flowNodeId) {
    setViewMode("investigation");
    await loadBoard();
    if (focus.workGroupId) {
      state.flowCodeLensEnabled = true;
      state.flowCodeFocus = { groupId: focus.workGroupId, taskId: focus.taskId || null, codeNodeId: null };
      renderInvestigationBoard();
      requestAnimationFrame(() => flowWorkGroupShell(focus.workGroupId)?.scrollIntoView({ block: "center", inline: "center" }));
    }
    if (focus.flowNodeId && state.investigationGraphNodes.some((entry) => entry.id === focus.flowNodeId)) {
      selectInvestigationNode(focus.flowNodeId);
    }
    return;
  }
  if (focus.taskId) {
    setViewMode("quest");
    await openTask(focus.taskId);
  }
}

async function refreshAll() {
  if (state.busy) return;
  try {
    setBusy(true);
    await loadProjects();
    await loadBoard();
    if (state.selectedTaskId) await openTask(state.selectedTaskId);
    toast("Board refreshed");
  } catch (error) {
    fail(error);
    await loadCodeMap().catch(() => {});
  } finally {
    setBusy(false);
  }
}

async function loadProjects() {
  const { projects } = await api("/projects");
  state.projects = projects;
  const remembered = localStorage.getItem("questboard.projectId");
  const currentStillExists = projects.some((project) => project.id === state.projectId);
  const rememberedExists = projects.some((project) => project.id === remembered);
  if (!currentStillExists) {
    state.projectId = rememberedExists ? remembered : projects[0]?.id ?? null;
  }
  renderProjectSelect();
}

function renderProjectSelect() {
  el["project-select"].replaceChildren(
    ...state.projects.map((project) => option(project.id, project.name)),
  );
  el["project-select"].disabled = state.projects.length === 0;
  el["new-task-button"].disabled = !state.projectId;
  if (state.projectId) el["project-select"].value = state.projectId;
}

async function loadBoard() {
  if (!state.projectId) {
    state.boardError = null;
    state.taskHierarchy = null;
    state.tasks = [];
    state.claims.clear();
    state.projectArtifacts = [];
    state.projectRelations = [];
    state.investigationGraphNodes = [];
    state.investigationGraphItems = [];
    state.investigationItemLinks = [];
    state.investigationItemTaskLinks = [];
    state.flowWorkGroups = [];
    state.flowWorkGroupMemberships = [];
    state.agentFocus = null;
    state.boardPositions.clear();
    state.displayPositions.clear();
    state.codeMap = { enabled: false, available: false, indexed: false, graph: null, projection: null, mode: null };
    state.codeMapIndexError = null;
    resetCodeMapExplorerState();
    state.codeMapSyncPreview = null;
    state.codeMapSyncResult = null;
    state.codeMapSyncFocusNodeIds = [];
    resetInvestigationHistory();
    renderBoard();
    return;
  }
  showBoardLoading(true);
  try {
    const [graph, hierarchyResponse] = await Promise.all([
      api(`/projects/${encodeURIComponent(state.projectId)}/investigation/graph`),
      api(`/projects/${encodeURIComponent(state.projectId)}/task-hierarchy`),
    ]);
    const { tasks, claims, artifacts, relations, positions, nodes, items, itemLinks, itemTaskLinks, flowWorkGroups, flowWorkGroupMemberships } = graph;
    state.tasks = tasks;
    state.taskHierarchy = hierarchyResponse.hierarchy;
    syncSeenDoneTasks();
    state.projectArtifacts = artifacts;
    state.projectRelations = relations;
    state.investigationGraphNodes = nodes;
    state.investigationGraphItems = items;
    state.investigationItemLinks = itemLinks;
    state.investigationItemTaskLinks = itemTaskLinks;
    state.flowWorkGroups = flowWorkGroups || [];
    state.flowWorkGroupMemberships = flowWorkGroupMemberships || [];
    state.boardPositions = new Map(positions.map((position) => [boardNodeKey(position.entityType, position.entityId), position]));
    resetInvestigationHistory();
    state.claims = new Map(claims.map((claim) => [claim.taskId, claim]));
    state.boardError = null;
    void refreshAgentFocus();
    if (state.viewMode === "code-map" || state.viewMode === "investigation") {
      await loadCodeMapContext();
    }
    renderBoard();
  } catch (error) {
    state.boardError = error instanceof Error ? error.message : String(error);
    renderBoard();
    throw error;
  }
}

function renderBoard() {
  showBoardLoading(false);
  const noProject = !state.projectId;
  const hasQuestContent = state.tasks.length > 0;
  const hasCurrentContent = state.viewMode === "quest" ? hasQuestContent : Boolean(state.projectId);
  const hasError = Boolean(state.boardError);
  el["board-error"].classList.toggle("hidden", !hasError);
  el["board-error-message"].textContent = state.boardError || "QuestBoard could not load this project.";
  el["project-empty"].classList.toggle("hidden", hasError || !noProject);
  el["board-empty"].classList.toggle("hidden", hasError || noProject || hasCurrentContent);
  el["quest-board"].classList.toggle("hidden", hasError || noProject || !hasQuestContent || state.viewMode !== "quest");
  el["investigation-board"].classList.toggle("hidden", hasError || noProject || state.viewMode !== "investigation");
  el["code-map-board"].classList.toggle("hidden", hasError || noProject || state.viewMode !== "code-map");
  renderViewSwitch();
  if (hasError) return;
  if (noProject || !hasCurrentContent) {
    if (state.viewMode === "quest") {
      el["kanban-board"].replaceChildren();
    }
    else if (state.viewMode === "investigation") clearInvestigationBoard();
    else el["code-map-content"].replaceChildren();
    return;
  }

  if (state.viewMode === "investigation") {
    renderInvestigationBoard();
    return;
  }

  if (state.viewMode === "code-map") {
    renderCodeMapBoard();
    return;
  }

  const columns = STATUSES.flatMap(([status, label]) => {
    const column = node("section", "kanban-column");
    column.dataset.status = status;
    const statusTasks = state.tasks.filter((task) => task.status === status);
    const tasks = statusTasks.filter(shouldShowQuestTask);
    if (status === "done" && state.hideCompleted && tasks.length === 0) return [];
    const heading = node("header", "column-header");
    const title = node("div", "column-title");
    title.append(node("span", `status-dot status-${status}`), text(label));
    const count = node("span", "column-count", String(tasks.length));
    heading.append(title, count);
    const list = node("div", "card-list");
    list.dataset.status = status;
    list.addEventListener("dragover", (event) => {
      event.preventDefault();
      list.classList.add("drop-target");
    });
    list.addEventListener("dragleave", () => list.classList.remove("drop-target"));
    list.addEventListener("drop", (event) => {
      event.preventDefault();
      list.classList.remove("drop-target");
      const taskId = event.dataTransfer?.getData("text/questboard-task");
      if (taskId) void moveTask(taskId, status);
    });
    tasks.forEach((task) => list.append(renderTaskCard(task)));
    column.append(heading, list);
    return [column];
  });
  el["kanban-board"].replaceChildren(...columns);
}

function setViewMode(mode) {
  if (!["quest", "investigation", "code-map"].includes(mode)) return;
  state.viewMode = mode;
  localStorage.setItem("questboard.viewMode", mode);
  closeDrawer();
  if ((mode === "code-map" || mode === "investigation") && state.projectId) {
    void loadCodeMapContext().catch(fail);
  }
  renderBoard();
}

function loadViewMode() {
  const requested = new URLSearchParams(globalThis.location?.search ?? "").get("view");
  if (["quest", "investigation", "code-map"].includes(requested)) return requested;
  const stored = localStorage.getItem("questboard.viewMode");
  return ["quest", "investigation", "code-map"].includes(stored) ? stored : "quest";
}

function loadHideCompleted() {
  const stored = localStorage.getItem("questboard.hideCompleted");
  return stored === null ? true : stored === "true";
}

function seenDoneStorageKey(projectId) {
  return `questboard.seenDoneTasks.${projectId}`;
}

function seenDoneInitKey(projectId) {
  return `questboard.seenDoneTasksInitialized.${projectId}`;
}

function persistSeenDoneTasks() {
  if (!state.projectId) return;
  localStorage.setItem(seenDoneStorageKey(state.projectId), JSON.stringify([...state.seenDoneTaskIds]));
}

function syncSeenDoneTasks() {
  if (!state.projectId) {
    state.seenDoneTaskIds = new Set();
    state.seenDoneProjectId = null;
    return;
  }
  if (state.seenDoneProjectId !== state.projectId) {
    try {
      const stored = JSON.parse(localStorage.getItem(seenDoneStorageKey(state.projectId)) || "[]");
      state.seenDoneTaskIds = new Set(Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : []);
    } catch {
      state.seenDoneTaskIds = new Set();
    }
    state.seenDoneProjectId = state.projectId;
  }
  const initKey = seenDoneInitKey(state.projectId);
  if (localStorage.getItem(initKey) !== "1") {
    state.seenDoneTaskIds = new Set(state.tasks.filter((task) => task.status === "done").map((task) => task.id));
    localStorage.setItem(initKey, "1");
    persistSeenDoneTasks();
    return;
  }
  let changed = false;
  state.tasks.forEach((task) => {
    if (task.status !== "done" && state.seenDoneTaskIds.delete(task.id)) changed = true;
  });
  if (changed) persistSeenDoneTasks();
}

function markDoneTaskSeen(taskId) {
  if (!state.projectId || state.seenDoneTaskIds.has(taskId)) return;
  state.seenDoneTaskIds.add(taskId);
  persistSeenDoneTasks();
}

function taskById(taskId) {
  return taskId ? state.tasks.find((task) => task.id === taskId) ?? null : null;
}

function hierarchyChildren(taskId) {
  return state.taskHierarchy?.childrenByParent?.[taskId] ?? [];
}

function isGroupTask(taskId) {
  return hierarchyChildren(taskId).length > 0;
}

function descendantTaskIds(taskId) {
  const descendants = [];
  const pending = [...hierarchyChildren(taskId)];
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    descendants.push(current);
    pending.push(...hierarchyChildren(current));
  }
  return descendants;
}

function nearestWorkGroup(taskId) {
  if (isGroupTask(taskId)) return taskById(taskId);
  const visited = new Set();
  let current = state.taskHierarchy?.parentByChild?.[taskId];
  while (current && !visited.has(current)) {
    visited.add(current);
    if (isGroupTask(current)) return taskById(current);
    current = state.taskHierarchy?.parentByChild?.[current];
  }
  return null;
}

function shouldShowQuestTask(task) {
  if (!state.hideCompleted || task.id === state.selectedTaskId) return true;
  if (task.status !== "done") return true;
  return !state.seenDoneTaskIds.has(task.id);
}

function renderDoneFilterControl() {
  if (!el["hide-completed-toggle"]) return;
  el["hide-completed-toggle"].checked = state.hideCompleted;
  const unseen = state.tasks.filter((task) => task.status === "done" && !state.seenDoneTaskIds.has(task.id)).length;
  el["unseen-done-count"].textContent = unseen > 0 ? `${unseen} new` : "";
  el["unseen-done-count"].classList.toggle("hidden", unseen === 0);
}

function loadInvestigationZoom() {
  const stored = Number(localStorage.getItem("questboard.investigationZoom"));
  return Number.isFinite(stored) ? clamp(stored, 0.35, 2.5) : 1;
}

function loadInvestigationPan() {
  try {
    const stored = JSON.parse(localStorage.getItem("questboard.investigationPan") || "null");
    return Number.isFinite(stored?.x) && Number.isFinite(stored?.y) ? stored : { x: 0, y: 0 };
  } catch {
    return { x: 0, y: 0 };
  }
}

function loadInvestigationViewportMeta() {
  try {
    const stored = JSON.parse(localStorage.getItem("questboard.investigationViewportMeta") || "null");
    if (!stored || typeof stored.projectId !== "string") return null;
    if (!Number.isFinite(stored.width) || !Number.isFinite(stored.height)) return null;
    return stored;
  } catch {
    return null;
  }
}

function renderViewSwitch() {
  el["workspace-nav"].querySelectorAll("[data-board-view]").forEach((button) => {
    const active = button.dataset.boardView === state.viewMode;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  const quest = state.viewMode === "quest";
  const investigation = state.viewMode === "investigation";
  const codeMap = state.viewMode === "code-map";
  el["investigation-controls"].classList.toggle("hidden", !investigation);
  el["new-task-button"].classList.toggle("hidden", !quest);
  el["hide-completed-control"].classList.toggle("hidden", !quest);
  el["investigation-add-node"].classList.toggle("hidden", !investigation);
  el["investigation-add-group"].classList.toggle("hidden", !investigation);
  el["code-map-refresh"].classList.toggle("hidden", !codeMap);
  if (!codeMap) el["code-map-sync"].classList.add("hidden");
  const title = codeMap ? "Code" : investigation ? "Flow" : "Quest";
  const role = codeMap ? "Code context" : investigation ? "Work map" : "Work queue";
  const projectName = state.projects.find((project) => project.id === state.projectId)?.name;
  el["workspace-title"].textContent = title;
  el["workspace-context"].textContent = projectName ? `${projectName} · ${role}` : role;
  renderDoneFilterControl();
  renderInvestigationControls();
}

async function loadCodeMap() {
  if (!state.projectId) return;
  state.codeMapLoading = true;
  renderCodeMapBoard();
  try {
    state.codeMap = await api(`/projects/${encodeURIComponent(state.projectId)}/code-map`);
    state.codeMapIndexError = null;
  } finally {
    state.codeMapLoading = false;
    renderCodeMapBoard();
  }
}

async function loadCodeMapContext() {
  await loadCodeMap();
  if (!state.codeMap.indexed || !state.codeMap.graph || !state.codeMap.projection) {
    state.codeMapSyncPreview = null;
    renderBoard();
    return;
  }
  try {
    await loadCodeMapSyncPreview();
  } catch {
    state.codeMapSyncPreview = null;
  }
  renderBoard();
}

async function loadCodeMapSyncPreview(selection = {}) {
  if (!state.projectId || !state.codeMap.indexed) return null;
  const { preview } = await api(
    `/projects/${encodeURIComponent(state.projectId)}/code-map/investigation-sync/preview`,
    { method: "POST", body: selection },
  );
  state.codeMapSyncPreview = preview;
  return preview;
}

async function refreshCodeMap() {
  if (!state.projectId || state.codeMapLoading) return;
  try {
    state.codeMapLoading = true;
    setBusy(true);
    renderCodeMapBoard();
    state.codeMap = await api(`/projects/${encodeURIComponent(state.projectId)}/code-map`, { method: "POST" });
    state.codeMapIndexError = null;
    toast(state.codeMap.mode === "cache-hit" ? "Code is current" : "Code indexed");
  } catch (error) {
    state.codeMapIndexError = error.message || "Code indexing failed";
    try {
      state.codeMap = await api(`/projects/${encodeURIComponent(state.projectId)}/code-map`);
    } catch {}
    fail(error);
  } finally {
    state.codeMapLoading = false;
    setBusy(false);
    renderCodeMapBoard();
  }
}

function renderCodeMapBoard() {
  if (!el["code-map-content"] || state.viewMode !== "code-map") return;
  const map = state.codeMap;
  const action = el["code-map-refresh"];
  const syncAction = el["code-map-sync"];
  action.classList.toggle("hidden", state.viewMode !== "code-map");
  action.disabled = state.codeMapLoading || !map.available;
  action.textContent = state.codeMapLoading ? "Indexing…" : map.indexed ? "Re-index" : "Index code";
  action.classList.toggle("primary", !map.indexed);
  action.classList.toggle("secondary", Boolean(map.indexed));
  syncAction.classList.toggle("hidden", state.viewMode !== "code-map" || !map.indexed || !map.projection);
  syncAction.disabled = state.codeMapLoading || state.codeMapSyncLoading;
  syncAction.classList.toggle("primary", Boolean(map.indexed && map.projection));
  syncAction.classList.toggle("secondary", !map.indexed || !map.projection);

  if (state.codeMapLoading && !map.graph) {
    el["code-map-status"].textContent = "Indexing source graph…";
    el["code-map-content"].replaceChildren(node("div", "code-map-state", "Building the raw Code Map…"));
    return;
  }
  if (!map.available) {
    state.selectedCodeMapDetail = null;
    state.codeMapInspectorData = null;
    renderCodeMapInspector();
    if (map.enabled) {
      const provider = map.provider && map.provider !== "unknown" ? map.provider : "Code";
      el["code-map-status"].textContent = `${provider} unavailable`;
      el["code-map-content"].replaceChildren(node("div", "code-map-state", map.message || "The configured Code provider is unavailable."));
    } else {
      el["code-map-status"].textContent = "Disabled";
      el["code-map-content"].replaceChildren(node("div", "code-map-state", "Code is not enabled for this QuestBoard runtime."));
    }
    return;
  }
  if (!map.indexed || !map.graph) {
    state.selectedCodeMapDetail = null;
    state.codeMapInspectorData = null;
    renderCodeMapInspector();
    el["code-map-status"].textContent = "Not indexed";
    el["code-map-content"].replaceChildren(node("div", "code-map-state", "Index this project to build its source map."));
    return;
  }

  syncCodeMapSearchControls(map);
  const timestamp = map.graph.indexedAt ? new Date(map.graph.indexedAt).toLocaleString() : "Indexed";
  const provider = map.provider && map.provider !== "unknown" ? `${map.provider} · ` : "";
  const indexFailed = Boolean(state.codeMapIndexError);
  const sourceStale = map.freshness === "stale";
  const snapshotSource = map.snapshotSource === "persisted" ? "persisted snapshot" : (map.mode || "cached");
  el["code-map-status"].textContent = indexFailed
    ? `${provider}last-good snapshot · ${timestamp} · indexing failed`
    : sourceStale
      ? `${provider}${snapshotSource} · stale · ${timestamp}`
      : `${provider}${snapshotSource} · ${timestamp}`;
  el["code-map-back"].disabled = state.codeMapNavigationHistory.length === 0;
  const shell = node("div", "code-map-explorer-shell");
  if (indexFailed) {
    shell.append(node("div", "code-map-banner warning", `Showing the last good snapshot. ${state.codeMapIndexError}`));
  } else if (sourceStale) {
    shell.append(node("div", "code-map-banner warning", "Source files changed after this Code Map snapshot. Existing results remain available; use Refresh / Re-index when you want a fresh index."));
  }
  const providerPanel = codeMapProviderPanel(map);
  if (providerPanel) shell.append(providerPanel);
  const manualRelationsPanel = codeMapManualRelationsPanel(map);
  if (manualRelationsPanel) shell.append(manualRelationsPanel);
  const searchPanel = codeMapSearchPanel();
  if (searchPanel) shell.append(searchPanel);
  shell.append(renderCodeMapSourceTree(map));
  const architectureLens = codeMapArchitectureLens(map);
  if (architectureLens) shell.append(architectureLens);
  el["code-map-content"].replaceChildren(shell);
  renderCodeMapInspector();
}

function resetCodeMapExplorerState() {
  if (state.codeMapSearchTimer) clearTimeout(state.codeMapSearchTimer);
  state.codeMapSearchTimer = null;
  state.selectedCodeMapDetail = null;
  state.codeMapInspectorData = null;
  state.codeMapInspectorLoading = false;
  state.codeMapNavigationHistory = [];
  state.codeMapExpandedTreeKeys = new Set();
  state.codeMapTreeVisibleCounts = new Map();
  state.codeMapSearchResults = null;
  state.codeMapSearchLoading = false;
  if (el["code-map-search"]) el["code-map-search"].value = "";
  if (el["code-map-kind-filter"]) el["code-map-kind-filter"].value = "";
  if (el["code-map-language-filter"]) el["code-map-language-filter"].value = "";
}

function scheduleCodeMapSearch() {
  if (state.codeMapSearchTimer) clearTimeout(state.codeMapSearchTimer);
  state.codeMapSearchTimer = setTimeout(() => void runCodeMapSearch(), 180);
}

async function codeMapQuery(input) {
  if (!state.projectId) throw new Error("Select a project before querying Code Map");
  const result = await api(`/projects/${encodeURIComponent(state.projectId)}/code-map/query`, {
    method: "POST",
    body: input,
  });
  return result.query;
}

async function runCodeMapSearch() {
  if (!state.projectId || !state.codeMap.indexed || !state.codeMap.graph) return;
  const query = el["code-map-search"].value.trim();
  const kind = el["code-map-kind-filter"].value;
  const language = el["code-map-language-filter"].value;
  if (!query && !kind && !language) {
    state.codeMapSearchResults = null;
    state.codeMapSearchLoading = false;
    renderCodeMapBoard();
    return;
  }

  const signature = `${query}\u0000${kind}\u0000${language}`;
  const base = {
    operation: "find_nodes",
    limit: 50,
    ...(kind ? { kinds: [kind] } : {}),
    ...(language ? { language } : {}),
  };
  state.codeMapSearchLoading = true;
  renderCodeMapBoard();
  try {
    const responses = query
      ? await Promise.all([
          codeMapQuery({ ...base, query }),
          codeMapQuery({ ...base, path: query }),
        ])
      : [await codeMapQuery(base)];
    if (`${el["code-map-search"].value.trim()}\u0000${el["code-map-kind-filter"].value}\u0000${el["code-map-language-filter"].value}` !== signature) return;
    const merged = new Map();
    responses.flatMap((response) => response.nodes || []).forEach((item) => merged.set(item.id, item));
    state.codeMapSearchResults = [...merged.values()].sort((left, right) =>
      (left.location?.path || "").localeCompare(right.location?.path || "")
      || (left.location?.startLine || 0) - (right.location?.startLine || 0)
      || left.name.localeCompare(right.name));
  } catch (error) {
    fail(error);
  } finally {
    state.codeMapSearchLoading = false;
    renderCodeMapBoard();
  }
}

function syncCodeMapSearchControls(map) {
  const graph = map.graph;
  if (!graph) return;
  const currentKind = el["code-map-kind-filter"].value;
  const currentLanguage = el["code-map-language-filter"].value;
  const kinds = [...new Set(graph.nodes.map((item) => item.kind))].sort();
  const languages = [...new Set(graph.nodes.map((item) => item.language).filter(Boolean))].sort();
  el["code-map-kind-filter"].replaceChildren(option("", "All kinds"), ...kinds.map((item) => option(item, item)));
  el["code-map-language-filter"].replaceChildren(option("", "All languages"), ...languages.map((item) => option(item, item)));
  if (kinds.includes(currentKind)) el["code-map-kind-filter"].value = currentKind;
  if (languages.includes(currentLanguage)) el["code-map-language-filter"].value = currentLanguage;
}

function codeMapSearchPanel() {
  if (!state.codeMapSearchLoading && state.codeMapSearchResults === null) return null;
  const panel = node("section", "code-map-search-results");
  if (state.codeMapSearchLoading) {
    panel.append(node("span", "code-map-search-state", "Searching raw Code Map…"));
    return panel;
  }
  const results = state.codeMapSearchResults || [];
  panel.append(node("strong", "code-map-search-title", `${results.length} search result${results.length === 1 ? "" : "s"}`));
  if (results.length === 0) {
    panel.append(node("span", "code-map-search-state", "No symbol or path matched these filters."));
    return panel;
  }
  const list = node("div", "code-map-search-list");
  results.forEach((item) => {
    const button = node("button", "code-map-search-result");
    button.type = "button";
    button.dataset.codeMapNodeId = item.id;
    button.append(
      node("strong", "code-map-search-result-title", item.name),
      node("span", "code-map-search-result-meta", `${item.kind}${item.language ? ` · ${item.language}` : ""}${item.location?.path ? ` · ${item.location.path}` : ""}`),
    );
    button.addEventListener("click", () => selectCodeMapDetail("node", item.id));
    list.append(button);
  });
  panel.append(list);
  return panel;
}

function renderCodeMapSourceTree(map) {
  const graph = map.graph;
  const panel = node("section", "code-map-source-panel");
  const fileNodes = graph.nodes.filter((item) => item.kind === "file");
  const heading = node("div", "code-map-source-heading");
  heading.append(
    node("strong", "code-map-source-title", "Repository source"),
    node("span", "code-map-source-count", `${fileNodes.length} files · ${graph.nodes.length} nodes · ${graph.relations.length} relations`),
  );
  panel.append(heading);

  const childrenByNode = codeMapContainsChildren(graph);
  const containedIds = new Set(graph.relations.filter((relation) => relation.kind === "contains").map((relation) => relation.to));
  const tree = buildCodeMapDirectoryTree(fileNodes);
  const unparented = graph.nodes
    .filter((item) => item.kind !== "file" && !containedIds.has(item.id))
    .sort(codeMapTreeNodeSort);
  const rootEntries = codeMapDirectoryEntries(tree);
  if (unparented.length) {
    const orphanDirectory = {
      name: "Unparented symbols",
      path: "@unparented",
      directories: new Map(),
      files: unparented,
      synthetic: true,
    };
    rootEntries.push({ type: "directory", value: orphanDirectory });
  }
  const body = node("div", "code-map-tree");
  appendCodeMapTreeChildren(body, "dir:@root", rootEntries, 0, childrenByNode);
  if (!body.childElementCount) body.append(node("span", "code-map-tree-empty", "No source nodes are available in this snapshot."));
  panel.append(body);
  return panel;
}

function buildCodeMapDirectoryTree(fileNodes) {
  const root = { name: "", path: "", directories: new Map(), files: [] };
  fileNodes.forEach((fileNode) => {
    const path = codeMapNodePath(fileNode).replace(/^\.\//, "");
    const segments = path.split("/").filter(Boolean);
    segments.pop();
    let current = root;
    let currentPath = "";
    segments.forEach((segment) => {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      if (!current.directories.has(segment)) {
        current.directories.set(segment, { name: segment, path: currentPath, directories: new Map(), files: [] });
      }
      current = current.directories.get(segment);
    });
    current.files.push(fileNode);
  });
  return root;
}

function codeMapContainsChildren(graph) {
  const nodeById = new Map(graph.nodes.map((item) => [item.id, item]));
  const result = new Map();
  graph.relations.filter((relation) => relation.kind === "contains").forEach((relation) => {
    const child = nodeById.get(relation.to);
    if (!child) return;
    const children = result.get(relation.from) || [];
    children.push(child);
    result.set(relation.from, children);
  });
  result.forEach((items) => items.sort(codeMapTreeNodeSort));
  return result;
}

function codeMapTreeNodeSort(left, right) {
  return (left.location?.path || "").localeCompare(right.location?.path || "")
    || (left.location?.startLine || 0) - (right.location?.startLine || 0)
    || left.kind.localeCompare(right.kind)
    || left.name.localeCompare(right.name);
}

function codeMapNodePath(item) {
  if (item.location?.path) return item.location.path;
  return item.canonicalIdentity.replace(/^file:/, "");
}

function codeMapDirectoryEntries(directory) {
  return [
    ...[...directory.directories.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((value) => ({ type: "directory", value })),
    ...[...directory.files]
      .sort(codeMapTreeNodeSort)
      .map((value) => ({ type: "node", value })),
  ];
}

function codeMapTreePage(entries, visibleCount = CODE_MAP_TREE_PAGE_SIZE) {
  const normalized = Number.isInteger(visibleCount) && visibleCount > 0 ? visibleCount : CODE_MAP_TREE_PAGE_SIZE;
  const limit = Math.min(normalized, entries.length);
  return {
    visible: entries.slice(0, limit),
    remaining: Math.max(0, entries.length - limit),
  };
}

function appendCodeMapTreeChildren(shell, key, entries, depth, childrenByNode) {
  const visibleCount = state.codeMapTreeVisibleCounts.get(key) || CODE_MAP_TREE_PAGE_SIZE;
  const page = codeMapTreePage(entries, visibleCount);
  page.visible.forEach((entry) => {
    shell.append(entry.type === "directory"
      ? renderCodeMapDirectoryBranch(entry.value, depth, childrenByNode)
      : renderCodeMapNodeBranch(entry.value, depth, childrenByNode));
  });
  if (page.remaining === 0) return;
  const row = node("div", "code-map-tree-load-more");
  row.style.setProperty("--code-tree-depth", String(depth));
  const nextCount = Math.min(CODE_MAP_TREE_PAGE_SIZE, page.remaining);
  const more = node("button", "code-map-tree-load-more-button", `Load ${nextCount} more · ${page.remaining} remaining`);
  more.type = "button";
  more.addEventListener("click", () => {
    state.codeMapTreeVisibleCounts.set(key, Math.min(entries.length, visibleCount + CODE_MAP_TREE_PAGE_SIZE));
    renderCodeMapBoard();
  });
  row.append(more);
  shell.append(row);
}

function renderCodeMapDirectoryBranch(directory, depth, childrenByNode) {
  const shell = node("div", "code-map-tree-branch");
  const key = `dir:${directory.path}`;
  const expanded = state.codeMapExpandedTreeKeys.has(key);
  const row = node("div", "code-map-tree-row code-map-tree-directory");
  row.style.setProperty("--code-tree-depth", String(depth));
  const toggle = node("button", "code-map-tree-toggle", expanded ? "▾" : "▸");
  toggle.type = "button";
  toggle.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${directory.name}`);
  const label = node("button", "code-map-tree-label");
  label.type = "button";
  label.append(node("span", "code-map-tree-icon", directory.synthetic ? "◇" : "▸"), node("strong", "code-map-tree-name", directory.name));
  const expand = () => {
    toggleCodeMapTreeKey(key);
    renderCodeMapBoard();
  };
  toggle.addEventListener("click", expand);
  label.addEventListener("click", expand);
  row.append(toggle, label);
  shell.append(row);
  if (!expanded) return shell;
  appendCodeMapTreeChildren(shell, key, codeMapDirectoryEntries(directory), depth + 1, childrenByNode);
  return shell;
}

function renderCodeMapNodeBranch(item, depth, childrenByNode) {
  const shell = node("div", "code-map-tree-branch");
  const children = childrenByNode.get(item.id) || [];
  const key = `node:${item.id}`;
  const expanded = state.codeMapExpandedTreeKeys.has(key);
  const row = node("div", `code-map-tree-row code-map-node code-map-node-${item.kind}`);
  row.dataset.codeMapNodeId = item.id;
  row.style.setProperty("--code-tree-depth", String(depth));
  row.classList.toggle("selected", state.selectedCodeMapDetail?.type === "node" && state.selectedCodeMapDetail.id === item.id);
  const toggle = node("button", `code-map-tree-toggle${children.length ? "" : " empty"}`, children.length ? (expanded ? "▾" : "▸") : "·");
  toggle.type = "button";
  toggle.disabled = children.length === 0;
  if (children.length) {
    toggle.addEventListener("click", () => {
      toggleCodeMapTreeKey(key);
      renderCodeMapBoard();
    });
  }
  const label = node("button", "code-map-tree-label");
  label.type = "button";
  label.append(
    node("span", "code-map-tree-icon", item.kind === "file" ? "▤" : "•"),
    node("strong", "code-map-tree-name", item.name),
    node("span", "code-map-tree-meta", `${item.kind}${item.language ? ` · ${item.language}` : ""}`),
  );
  label.addEventListener("click", () => selectCodeMapDetail("node", item.id));
  row.append(toggle, label);
  const providers = (item.provenance || []).map((entry) => entry.providerId);
  if (providers.length) row.append(node("span", "code-map-tree-provider", providers.join(" + ")));
  shell.append(row);
  if (expanded) {
    appendCodeMapTreeChildren(
      shell,
      key,
      children.map((value) => ({ type: "node", value })),
      depth + 1,
      childrenByNode,
    );
  }
  return shell;
}

function toggleCodeMapTreeKey(key) {
  if (state.codeMapExpandedTreeKeys.has(key)) {
    state.codeMapExpandedTreeKeys.delete(key);
    state.codeMapTreeVisibleCounts.delete(key);
  } else {
    state.codeMapExpandedTreeKeys.add(key);
  }
}

function revealCodeMapNode(nodeId) {
  const graph = state.codeMap.graph;
  if (!graph) return;
  const nodeById = new Map(graph.nodes.map((item) => [item.id, item]));
  let currentId = nodeId;
  const visited = new Set();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const parentRelation = graph.relations.find((relation) => relation.kind === "contains" && relation.to === currentId);
    if (!parentRelation) break;
    state.codeMapExpandedTreeKeys.add(`node:${parentRelation.from}`);
    currentId = parentRelation.from;
  }
  const item = nodeById.get(nodeId);
  const path = item ? codeMapNodePath(item) : "";
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  let directory = "";
  segments.forEach((segment) => {
    directory = directory ? `${directory}/${segment}` : segment;
    state.codeMapExpandedTreeKeys.add(`dir:${directory}`);
  });
}

function codeMapArchitectureLens(map) {
  const projection = map.projection;
  if (!projection?.nodes?.length) return null;
  const details = document.createElement("details");
  details.className = "code-map-architecture-lens";
  const summary = node("summary", "code-map-architecture-summary", `Architecture lens · ${projection.nodes.length} groups · ${projection.relations.length} relations`);
  details.append(summary);
  const stage = node("div", "code-map-architecture-stage");
  projection.nodes.forEach((item) => {
    const card = node("article", "code-map-architecture-card");
    card.append(
      node("span", "code-map-node-kind", item.kind.replaceAll("_", " ")),
      node("strong", "code-map-node-title", item.title),
      node("span", "code-map-node-count", `${item.memberNodeIds.length} symbols`),
    );
    stage.append(card);
  });
  const relations = node("div", "code-map-architecture-relations");
  const nodeById = new Map(projection.nodes.map((item) => [item.id, item]));
  projection.relations.forEach((relation) => {
    relations.append(node("div", "code-map-architecture-relation", `${nodeById.get(relation.from)?.title || relation.from} · ${relation.kind.replaceAll("_", " ")} → ${nodeById.get(relation.to)?.title || relation.to}`));
  });
  details.append(stage, relations);
  return details;
}

function codeMapProviderPanel(map) {
  const report = map.providerCapabilities;
  if (!report?.providers?.length) return null;
  const gaps = report.languages?.filter((entry) => entry.gapReason) || [];
  const missing = report.providers.filter((provider) => !provider.available);
  if (!gaps.length && !missing.length) return null;

  const panel = node("section", "code-map-provider-panel");
  panel.append(node("strong", "code-map-provider-title", "Language coverage"));
  if (gaps.length) {
    const list = node("div", "code-map-provider-gaps");
    gaps.forEach((entry) => {
      list.append(node(
        "span",
        "code-map-provider-gap",
        `${entry.language}: ${entry.indexedFileCount}/${entry.discoveredFileCount} symbol-covered files · ${entry.gapReason.replaceAll("_", " ")}`,
      ));
    });
    panel.append(list);
  }

  missing.forEach((provider) => {
    const row = node("div", "code-map-provider-row");
    const copy = node("div", "code-map-provider-copy");
    copy.append(
      node("strong", "code-map-provider-name", provider.providerId),
      node("span", "code-map-provider-health", provider.diagnostics?.[0] || provider.health),
    );
    row.append(copy);
    if (provider.installOption) {
      const install = node("button", "secondary small", "Install provider…");
      install.type = "button";
      install.addEventListener("click", () => void showCodeMapProviderInstallRequest(provider.providerId));
      row.append(install);
    }
    panel.append(row);
  });
  return panel;
}

async function showCodeMapProviderInstallRequest(providerId) {
  try {
    const result = await api(
      `/projects/${encodeURIComponent(state.projectId)}/code-map/providers/${encodeURIComponent(providerId)}/install-request`,
      { method: "POST" },
    );
    const request = result.installRequest;
    const install = request.install;
    window.alert([
      `Provider: ${providerId}`,
      `Source: ${install.source}@${install.version}`,
      `Permissions: ${(install.permissions || []).join(", ") || "none"}`,
      `Re-index: ${install.reindexMode}`,
      "",
      "Installation has not run. It requires explicit approval in the trusted external host before any package or executable is changed.",
    ].join("\n"));
  } catch (error) {
    fail(error);
  }
}

function codeMapManualRelationsPanel(map) {
  const manualRelations = map.manualRelations || [];
  if (!manualRelations.length) return null;
  const graphNodes = new Map((map.graph?.nodes || []).map((candidate) => [candidate.id, candidate]));
  const panel = node("section", "code-map-manual-panel");
  const heading = node("div", "code-map-manual-heading");
  heading.append(
    node("strong", "code-map-manual-title", "Manual wiring"),
    node("span", "code-map-manual-count", `${manualRelations.length} relation${manualRelations.length === 1 ? "" : "s"}`),
  );
  panel.append(heading);
  manualRelations.forEach((relation) => {
    const from = graphNodes.get(relation.fromCodeNodeId)?.name || relation.fromCanonicalIdentity;
    const to = graphNodes.get(relation.toCodeNodeId)?.name || relation.toCanonicalIdentity;
    const row = node("div", `code-map-manual-relation ${relation.state === "stale" ? "stale" : "active"}`);
    const badges = node("div", "code-map-manual-badges");
    badges.append(node("span", "code-map-manual-badge", "Manual"));
    if (relation.state === "stale") badges.append(node("span", "code-map-manual-badge stale", "Stale"));
    const copy = node("div", "code-map-manual-copy");
    copy.append(
      node("strong", "code-map-manual-edge", `${from} → ${to}`),
      node("span", "code-map-manual-kind", relation.relationKind.replaceAll("_", " ")),
    );
    if (relation.label) copy.append(node("span", "code-map-manual-label", relation.label));
    if (relation.rationale) copy.append(node("span", "code-map-manual-rationale", relation.rationale));
    if (relation.staleReason) copy.append(node("span", "code-map-manual-stale-reason", relation.staleReason.replaceAll("_", " ")));
    row.append(copy, badges);
    panel.append(row);
  });
  return panel;
}

function selectCodeMapDetail(type, id) {
  if (type !== "node") return;
  void openCodeMapNode(id, { pushHistory: true });
}

async function openCodeMapNode(id, { pushHistory = false } = {}) {
  const current = state.selectedCodeMapDetail?.type === "node" ? state.selectedCodeMapDetail.id : null;
  if (pushHistory && current && current !== id) state.codeMapNavigationHistory.push(current);
  state.selectedCodeMapDetail = { type: "node", id };
  state.codeMapInspectorData = null;
  state.codeMapInspectorLoading = true;
  revealCodeMapNode(id);
  renderCodeMapBoard();
  try {
    await loadCodeMapInspector(id);
  } catch (error) {
    if (state.selectedCodeMapDetail?.id === id) state.codeMapInspectorData = { error: error.message || String(error) };
  } finally {
    if (state.selectedCodeMapDetail?.id === id) {
      state.codeMapInspectorLoading = false;
      renderCodeMapBoard();
    }
  }
}

function navigateCodeMapBack() {
  const previous = state.codeMapNavigationHistory.pop();
  if (!previous) return;
  void openCodeMapNode(previous);
}

function clearCodeMapSelection() {
  state.selectedCodeMapDetail = null;
  state.codeMapInspectorData = null;
  state.codeMapInspectorLoading = false;
  renderCodeMapBoard();
}

async function loadCodeMapInspector(nodeId) {
  const [exact, parents, children, relations] = await Promise.all([
    codeMapQuery({ operation: "get_node", nodeId }),
    codeMapQuery({ operation: "hierarchy", nodeId, direction: "parents", depth: 4, limit: 20 }),
    codeMapQuery({ operation: "hierarchy", nodeId, direction: "children", depth: 1, limit: 60 }),
    codeMapQuery({ operation: "relations", nodeId, direction: "both", limit: 100 }),
  ]);
  if (state.selectedCodeMapDetail?.id !== nodeId) return;
  state.codeMapInspectorData = {
    node: exact.node,
    parents: parents.entries || [],
    children: children.entries || [],
    relations: relations.entries || [],
    truncated: Boolean(parents.truncated || children.truncated || relations.truncated),
  };
}

function renderCodeMapInspector() {
  const inspector = el["code-map-inspector"];
  if (!inspector) return;
  const selection = state.selectedCodeMapDetail;
  if (!selection || selection.type !== "node") {
    inspector.classList.add("hidden");
    el["code-map-inspector-body"].replaceChildren();
    return;
  }
  const fallback = state.codeMap.graph?.nodes?.find((candidate) => candidate.id === selection.id);
  const data = state.codeMapInspectorData;
  const selectedNode = data?.node || fallback;
  if (!selectedNode) return clearCodeMapSelection();
  el["code-map-inspector-kicker"].textContent = `${selectedNode.kind}${selectedNode.language ? ` · ${selectedNode.language}` : ""}`;
  el["code-map-inspector-title"].textContent = selectedNode.name;
  if (state.codeMapInspectorLoading && !data) {
    el["code-map-inspector-body"].replaceChildren(node("div", "code-map-inspector-empty", "Loading bounded source context…"));
    inspector.classList.remove("hidden");
    return;
  }
  if (data?.error) {
    el["code-map-inspector-body"].replaceChildren(node("div", "code-map-inspector-empty", data.error));
    inspector.classList.remove("hidden");
    return;
  }

  const relations = data?.relations || [];
  const directParents = (data?.parents || []).filter((entry) => entry.depth === 1);
  const directChildren = (data?.children || []).filter((entry) => entry.depth === 1);
  const body = document.createDocumentFragment();
  body.append(codeMapBreadcrumb(data?.parents || [], selectedNode));
  body.append(codeMapInspectorSummary([
    [selectedNode.kind, "Kind"],
    [selectedNode.language || "unknown", "Language"],
    [String(relations.length), data?.truncated ? "Relations +" : "Relations"],
  ]));
  const definition = node("section", "code-map-inspector-section");
  definition.append(node("span", "code-map-inspector-section-title", "Defined at"));
  if (selectedNode.location) definition.append(codeMapLocationRow(selectedNode.location));
  else definition.append(node("span", "code-map-inspector-empty", "No source range recorded."));
  if (selectedNode.signature) definition.append(node("code", "code-map-inspector-signature", selectedNode.signature));
  body.append(definition);
  if (directParents.length) body.append(codeMapHierarchySection("Parent", directParents));
  if (directChildren.length) body.append(codeMapHierarchySection("Children", directChildren));
  codeMapRelationSections(selection.id, relations).forEach((section) => body.append(section));
  body.append(codeMapRelatedTasksSection(selection.id));
  body.append(codeMapRelatedFlowSection(selection.id));
  body.append(codeMapManualInspectorSection(selection.id));
  body.append(codeMapAdvancedSection(selectedNode));
  el["code-map-inspector-body"].replaceChildren(body);
  inspector.classList.remove("hidden");
}

function codeMapBreadcrumb(parentEntries, selectedNode) {
  const breadcrumb = node("nav", "code-map-breadcrumb");
  breadcrumb.setAttribute("aria-label", "Code hierarchy path");
  const ordered = [...parentEntries]
    .filter((entry) => entry.depth > 0)
    .sort((left, right) => right.depth - left.depth);
  ordered.forEach((entry) => {
    const button = node("button", "code-map-breadcrumb-item", entry.node.name);
    button.type = "button";
    button.addEventListener("click", () => selectCodeMapDetail("node", entry.node.id));
    breadcrumb.append(button, node("span", "code-map-breadcrumb-separator", "›"));
  });
  breadcrumb.append(node("span", "code-map-breadcrumb-current", selectedNode.name));
  return breadcrumb;
}

function codeMapHierarchySection(title, entries) {
  const section = node("section", "code-map-inspector-section");
  section.append(node("span", "code-map-inspector-section-title", title));
  const list = node("div", "code-map-inspector-list");
  entries.forEach((entry) => list.append(codeMapNavigationRow(entry.node, entry.relation)));
  section.append(list);
  return section;
}

function codeMapRelationSections(nodeId, entries) {
  const labels = {
    calls: ["Calls", "Called by"],
    depends_on: ["Depends on", "Depended on by"],
    implements: ["Implements", "Implemented by"],
    overrides: ["Overrides", "Overridden by"],
    extends: ["Extends", "Extended by"],
    references_type: ["References", "Referenced by"],
    instantiates: ["Instantiates", "Instantiated by"],
    imports: ["Imports", "Imported by"],
    reads: ["Reads", "Read by"],
    writes: ["Writes", "Written by"],
    unknown: ["Outgoing", "Incoming"],
  };
  const grouped = new Map();
  entries.filter((entry) => entry.relation.kind !== "contains").forEach((entry) => {
    const outgoing = entry.relation.from === nodeId;
    const pair = labels[entry.relation.kind] || [entry.relation.kind, entry.relation.kind];
    const title = pair[outgoing ? 0 : 1];
    const values = grouped.get(title) || [];
    values.push(entry);
    grouped.set(title, values);
  });
  return [...grouped.entries()].map(([title, values]) => {
    const section = node("section", "code-map-inspector-section");
    section.append(node("span", "code-map-inspector-section-title", title));
    const list = node("div", "code-map-inspector-list");
    values.forEach((entry) => list.append(codeMapNavigationRow(entry.node, entry.relation)));
    section.append(list);
    return section;
  });
}

function codeMapNavigationRow(target, relation) {
  const button = node("button", "code-map-relation code-map-inspector-navigation");
  button.type = "button";
  button.dataset.codeMapNodeId = target.id;
  if (relation) button.dataset.codeMapRelationId = relation.id;
  const main = node("span", "code-map-inspector-navigation-main");
  main.append(
    node("strong", "code-map-inspector-navigation-title", target.name),
    node("span", "code-map-inspector-navigation-meta", `${target.kind}${target.location?.path ? ` · ${target.location.path}` : ""}`),
  );
  button.append(main);
  if (relation) button.append(codeMapProvenanceBadges(relation.provenance || [], relation.confidence));
  button.addEventListener("click", () => selectCodeMapDetail("node", target.id));
  return button;
}

function codeMapProvenanceBadges(provenance, confidence) {
  const badges = node("span", "code-map-provenance-badges");
  provenance.forEach((entry) => {
    const manual = entry.providerId === "manual";
    badges.append(node("span", `code-map-provenance-badge${manual ? " manual" : ""}`, manual ? "Manual" : entry.providerId));
  });
  if (Number.isFinite(confidence)) badges.append(node("span", "code-map-provenance-badge confidence", `${Math.round(confidence * 100)}%`));
  return badges;
}

function codeMapManualInspectorSection(nodeId) {
  const section = node("section", "code-map-inspector-section code-map-manual-inspector");
  const head = node("div", "code-map-inspector-section-head");
  head.append(node("span", "code-map-inspector-section-title", "Manual wiring"));
  const add = node("button", "secondary small", "+ Relation");
  add.type = "button";
  add.addEventListener("click", () => void createCodeMapManualRelationFromSelection());
  head.append(add);
  section.append(head);
  const relations = (state.codeMap.manualRelations || []).filter((relation) => relation.fromCodeNodeId === nodeId || relation.toCodeNodeId === nodeId);
  if (!relations.length) {
    section.append(node("span", "code-map-inspector-empty", "No manual wiring touches this node."));
    return section;
  }
  const graphNodes = new Map((state.codeMap.graph?.nodes || []).map((item) => [item.id, item]));
  const list = node("div", "code-map-inspector-list");
  relations.forEach((relation) => {
    const otherId = relation.fromCodeNodeId === nodeId ? relation.toCodeNodeId : relation.fromCodeNodeId;
    const row = node("div", `code-map-manual-inspector-row ${relation.state}`);
    row.append(
      node("strong", "code-map-manual-edge", `${relation.fromCodeNodeId === nodeId ? "→" : "←"} ${graphNodes.get(otherId)?.name || otherId}`),
      node("span", "code-map-manual-kind", relation.relationKind.replaceAll("_", " ")),
      node("span", "code-map-manual-badge", "Manual"),
    );
    if (relation.state === "stale") row.append(node("span", "code-map-manual-badge stale", "Stale"));
    list.append(row);
  });
  section.append(list);
  return section;
}

function codeMapRelatedTasksSection(nodeId) {
  const section = node("section", "code-map-inspector-section code-scope-related-tasks");
  const head = node("div", "code-map-inspector-section-head");
  head.append(node("span", "code-map-inspector-section-title", "Related Tasks"));
  const add = node("button", "secondary small", "+ Task");
  add.type = "button";
  add.addEventListener("click", () => void createTaskForCodeScope(nodeId));
  head.append(add);
  section.append(head);
  const bindings = (state.codeMap.codeScopeBindings || []).filter((binding) => binding.codeNodeId === nodeId);
  if (!bindings.length) {
    section.append(node("span", "code-map-inspector-empty", "No Tasks are bound to this CodeScope yet."));
    return section;
  }
  const list = node("div", "code-scope-task-list");
  const grouped = new Map();
  bindings.forEach((binding) => {
    const group = nearestWorkGroup(binding.taskId);
    const key = group?.id || "__ungrouped__";
    const entry = grouped.get(key) || { group, bindings: [] };
    entry.bindings.push(binding);
    grouped.set(key, entry);
  });
  [...grouped.values()]
    .sort((left, right) => (left.group?.title || "Ungrouped").localeCompare(right.group?.title || "Ungrouped"))
    .forEach(({ group, bindings: groupBindings }) => {
      const shell = node("div", "code-scope-task-group");
      const groupHead = node("div", "code-scope-task-group-head");
      const copy = node("div", "code-scope-task-group-copy");
      copy.append(
        node("span", "code-scope-task-group-kicker", group ? "Work Group" : "Ungrouped"),
        node("strong", "code-scope-task-group-title", group?.title || "Independent Tasks"),
        node("span", "code-scope-task-group-count", `${groupBindings.length} linked Task${groupBindings.length === 1 ? "" : "s"}`),
      );
      groupHead.append(copy);
      if (group) {
        const openGroup = node("button", "button ghost compact", "Open Group");
        openGroup.type = "button";
        openGroup.addEventListener("click", () => void openTask(group.id));
        groupHead.append(openGroup);
      }
      shell.append(groupHead);
      groupBindings
        .sort((left, right) => left.task.title.localeCompare(right.task.title))
        .forEach((binding) => {
          const row = node("button", `code-scope-task-row ${binding.state}`);
          row.type = "button";
          row.append(
            node("strong", "code-scope-task-title", binding.task.title),
            node("span", "code-scope-task-meta", `${binding.kind.replaceAll("_", " ")} · ${binding.task.status}`),
            node("span", `code-scope-state ${binding.state}`, binding.state),
          );
          row.addEventListener("click", () => void openTask(binding.taskId));
          shell.append(row);
        });
      list.append(shell);
    });
  section.append(list);
  return section;
}

function codeMapRelatedFlowSection(nodeId) {
  const section = node("section", "code-map-inspector-section code-map-related-flow");
  const context = relatedFlowContextForCodeScope(nodeId);
  const head = node("div", "code-map-inspector-section-head");
  head.append(node("span", "code-map-inspector-section-title", "Related Flow"));
  const show = node("button", "secondary small", "Show in Flow");
  show.type = "button";
  show.disabled = context.taskIds.size === 0 && context.itemIds.size === 0 && context.groupIds.size === 0;
  show.addEventListener("click", () => void showCodeScopeInFlow(nodeId));
  head.append(show);
  section.append(head);
  if (show.disabled) {
    section.append(node("span", "code-map-inspector-empty", "No Flow work is linked through Tasks for this CodeScope."));
    return section;
  }
  const summary = node("div", "code-map-flow-summary");
  summary.append(
    node("span", "code-map-flow-stat", `${context.groupIds.size} groups`),
    node("span", "code-map-flow-stat", `${context.taskIds.size} tasks`),
    node("span", "code-map-flow-stat", `${context.itemIds.size} items`),
  );
  section.append(summary);
  const groupList = node("div", "code-map-flow-groups");
  [...context.groupIds].slice(0, 8).forEach((groupId) => {
    const group = flowWorkGroupById(groupId);
    if (group) groupList.append(node("span", "code-map-flow-group", flowWorkGroupPathLabel(group)));
  });
  if (context.groupIds.size > 8) groupList.append(node("span", "code-map-flow-group more", `+${context.groupIds.size - 8} more`));
  section.append(groupList);
  return section;
}

async function createTaskForCodeScope(codeNodeId) {
  if (!state.projectId) return;
  const title = window.prompt("Task title for this CodeScope");
  if (!title?.trim()) return;
  const goal = window.prompt("Goal (optional)", "")?.trim();
  try {
    const created = await api(`/projects/${encodeURIComponent(state.projectId)}/code-scope-tasks`, {
      method: "POST",
      actor: true,
      body: {
        codeNodeId,
        kind: "targets",
        title: title.trim(),
        ...(goal ? { goal } : {}),
      },
    });
    await loadBoard();
    if (state.viewMode === "code-map") await openCodeMapNode(codeNodeId);
    toast(`Task created for ${created.binding?.codeNode?.name || "CodeScope"}`);
  } catch (error) {
    fail(error);
  }
}

async function createCodeMapManualRelationFromSelection() {
  const fromCodeNodeId = state.selectedCodeMapDetail?.type === "node" ? state.selectedCodeMapDetail.id : null;
  if (!fromCodeNodeId || !state.projectId) return;
  const toCodeNodeId = window.prompt("Target Code node ID");
  if (!toCodeNodeId?.trim()) return;
  const relationKind = window.prompt("Relation kind (for example calls, depends_on, references_type)", "depends_on");
  if (!relationKind?.trim()) return;
  const rationale = window.prompt("Why is this manual relation known to be real?", "Verified during implementation") || undefined;
  try {
    await api(`/projects/${encodeURIComponent(state.projectId)}/code-map/manual-relations`, {
      method: "POST",
      actor: true,
      body: {
        fromCodeNodeId,
        toCodeNodeId: toCodeNodeId.trim(),
        relationKind: relationKind.trim(),
        ...(rationale ? { rationale } : {}),
      },
    });
    state.codeMap = await api(`/projects/${encodeURIComponent(state.projectId)}/code-map`);
    await loadCodeMapInspector(fromCodeNodeId);
    toast("Manual Code relation added");
  } catch (error) {
    fail(error);
  } finally {
    renderCodeMapBoard();
  }
}

function codeMapAdvancedSection(item) {
  const details = document.createElement("details");
  details.className = "code-map-advanced";
  details.append(node("summary", "code-map-advanced-summary", "Advanced identity & provenance"));
  const body = node("div", "code-map-advanced-body");
  [
    ["Node ID", item.id],
    ["Canonical", item.canonicalIdentity],
    ["Kind", item.kind],
    ["Language", item.language || "unknown"],
    ["Exported", item.exported === undefined ? "unknown" : String(item.exported)],
  ].forEach(([label, value]) => {
    const row = node("div", "code-map-advanced-row");
    row.append(node("span", "code-map-advanced-label", label), node("code", "code-map-advanced-value", value));
    body.append(row);
  });
  if (item.provenance?.length) body.append(codeMapProvenanceBadges(item.provenance));
  details.append(body);
  return details;
}

function codeMapInspectorSummary(metrics) {
  const summary = node("div", "code-map-inspector-summary");
  metrics.forEach(([value, label]) => {
    const metric = node("span", "code-map-inspector-metric");
    metric.append(node("strong", "", value), node("span", "", label));
    summary.append(metric);
  });
  return summary;
}

function codeMapLocationRow(location, label = "") {
  const row = node("div", "code-map-location");
  const line = location.startLine ? `:${location.startLine}${location.startColumn ? `:${location.startColumn}` : ""}` : "";
  row.append(node("code", "code-map-location-path", `${location.path}${line}`));
  if (label) row.append(node("span", "code-map-location-label", label));
  return row;
}

async function openCodeMapSyncPreview() {
  if (!state.projectId || !state.codeMap.indexed || state.codeMapSyncLoading) return;
  state.codeMapSyncResult = null;
  el["code-map-sync-recreate-detached"].checked = false;
  if (!el["code-map-sync-dialog"].open) el["code-map-sync-dialog"].showModal();
  try {
    state.codeMapSyncLoading = true;
    renderCodeMapSyncDialog();
    await loadCodeMapSyncPreview({ includeRelations: true, recreateDetached: false });
  } catch (error) {
    fail(error);
  } finally {
    state.codeMapSyncLoading = false;
    renderCodeMapSyncDialog();
    renderCodeMapBoard();
  }
}

function renderCodeMapSyncDialog() {
  if (!el["code-map-sync-body"]) return;
  const preview = state.codeMapSyncPreview;
  const result = state.codeMapSyncResult;
  const apply = el["code-map-sync-apply"];
  const openInvestigation = el["code-map-sync-open-investigation"];
  const recreateRow = el["code-map-sync-recreate-row"];

  if (state.codeMapSyncLoading) {
    el["code-map-sync-body"].replaceChildren(node("div", "code-map-sync-loading", result ? "Applying sync…" : "Building sync preview…"));
    apply.disabled = true;
    recreateRow.classList.add("hidden");
    openInvestigation.classList.add("hidden");
    return;
  }

  if (result) {
    const counts = result.counts;
    const summary = codeMapSyncSummary([
      ["Created nodes", counts.createdNodes],
      ["Created relations", counts.createdRelationLinks],
      ["Updated bindings", counts.updatedBindings],
      ["Unchanged", counts.unchangedNodes + counts.unchangedRelations],
      ["Stale", counts.staleBindings],
      ["Detached", counts.detachedBindings],
      ["Blocked", counts.blockedRelations],
    ]);
    const copy = node("p", "code-map-sync-result-copy", "Sync completed. Generated Flow content remains editable and future syncs preserve user fields.");
    el["code-map-sync-body"].replaceChildren(summary, copy);
    recreateRow.classList.add("hidden");
    openInvestigation.classList.remove("hidden");
    apply.textContent = "Preview again";
    apply.disabled = false;
    return;
  }

  apply.textContent = "Apply sync";
  openInvestigation.classList.add("hidden");
  if (!preview) {
    el["code-map-sync-body"].replaceChildren(node("div", "code-map-sync-loading", "No sync preview available."));
    apply.disabled = true;
    recreateRow.classList.add("hidden");
    return;
  }

  const changed = preview.counts.nodes.evidence_changed + preview.counts.relations.evidence_changed;
  const stale = preview.counts.nodes.stale + preview.counts.relations.stale;
  const detached = preview.counts.nodes.detached + preview.counts.relations.detached;
  const conflicts = detached + preview.counts.relations.blocked;
  const summary = codeMapSyncSummary([
    ["New nodes", preview.counts.nodes.create],
    ["New relations", preview.counts.relations.create],
    ["Evidence changed", changed],
    ["Stale", stale],
    ["Detached / blocked", conflicts],
  ]);

  const notices = node("div", "code-map-sync-notices");
  if (stale > 0) notices.append(node("div", "code-map-sync-notice", `${stale} stale binding${stale === 1 ? "" : "s"} will be preserved, not deleted.`));
  if (detached > 0) notices.append(node("div", "code-map-sync-notice warning", `${detached} detached target${detached === 1 ? "" : "s"} require explicit recreation confirmation.`));

  const rows = node("div", "code-map-sync-list");
  preview.nodes.forEach((entry) => rows.append(codeMapSyncRow("Node", entry.sourceTitle, entry.state)));
  const projectionNodes = new Map((state.codeMap.projection?.nodes || []).map((entry) => [entry.id, entry.title]));
  preview.relations.forEach((entry) => {
    const from = projectionNodes.get(entry.fromCodeNodeId) || "Previous source";
    const to = projectionNodes.get(entry.toCodeNodeId) || "Previous target";
    rows.append(codeMapSyncRow("Relation", `${from} → ${to}`, entry.state, entry.relationKind));
  });

  el["code-map-sync-body"].replaceChildren(summary, notices, rows);
  recreateRow.classList.toggle("hidden", detached === 0);
  apply.disabled = detached > 0 && !el["code-map-sync-recreate-detached"].checked;
}

function codeMapSyncSummary(entries) {
  const summary = node("div", "code-map-sync-summary");
  entries.forEach(([label, value]) => {
    const item = node("div", "code-map-sync-stat");
    item.append(node("strong", "code-map-sync-stat-value", String(value)), node("span", "code-map-sync-stat-label", label));
    summary.append(item);
  });
  return summary;
}

function codeMapSyncRow(type, title, status, detail = "") {
  const row = node("div", "code-map-sync-row");
  const copy = node("div", "code-map-sync-row-copy");
  copy.append(node("span", "code-map-sync-row-type", type), node("strong", "code-map-sync-row-title", title));
  if (detail) copy.append(node("span", "code-map-sync-row-detail", detail.replaceAll("_", " ")));
  row.append(copy, node("span", `code-map-sync-state code-map-sync-state-${status}`, status.replaceAll("_", " ")));
  return row;
}

async function applyCodeMapSync() {
  if (state.codeMapSyncResult) {
    state.codeMapSyncResult = null;
    await openCodeMapSyncPreview();
    return;
  }
  const preview = state.codeMapSyncPreview;
  if (!state.projectId || !preview || state.codeMapSyncLoading) return;
  const recreateDetached = el["code-map-sync-recreate-detached"].checked;
  try {
    state.codeMapSyncLoading = true;
    renderCodeMapSyncDialog();
    const { result } = await api(
      `/projects/${encodeURIComponent(state.projectId)}/code-map/investigation-sync/apply`,
      {
        method: "POST",
        actor: true,
        body: {
          includeRelations: true,
          recreateDetached,
          expectedProjectionFingerprint: preview.projectionFingerprint,
        },
      },
    );
    state.codeMapSyncResult = result;
    state.codeMapSyncFocusNodeIds = result.investigationNodeIds || [];
    state.codeMapSyncFocusDeadline = 0;
    state.codeMapSyncFocusCentered = false;
    await loadBoard();
    toast("Code synced to Flow");
  } catch (error) {
    fail(error);
  } finally {
    state.codeMapSyncLoading = false;
    renderCodeMapSyncDialog();
  }
}

async function openInvestigationFromCodeMapSync() {
  el["code-map-sync-dialog"].close();
  setViewMode("investigation");
  await loadBoard();
}

function codeMapBindingBadges(status) {
  const badges = node("span", "code-map-binding-badges");
  badges.append(node("span", "code-map-binding-badge", "Code"));
  if (status === "stale") badges.append(node("span", "code-map-binding-badge stale", "Stale"));
  return badges;
}

function codeMapNodeBindingForInvestigationNode(nodeId) {
  return state.codeMapSyncPreview?.nodes?.find((entry) => entry.investigationNodeId === nodeId) || null;
}

function codeMapRelationBindingForInvestigationItem(itemId) {
  return state.codeMapSyncPreview?.relations?.find((entry) => entry.investigationItemId === itemId) || null;
}

function renderInvestigationBoard() {
  const canvas = el["investigation-canvas"];
  const groupsLayer = el["investigation-groups"];
  const nodesLayer = el["investigation-nodes"];
  const graphMode = state.investigationGraphNodes.length > 0;
  canvas.style.width = "1800px";
  canvas.style.height = "1000px";
  applyInvestigationViewport();
  state.displayPositions = new Map();

  if (graphMode) {
    const columns = investigationDefaultColumnCount();
    const graphNodes = state.investigationGraphNodes.map((graphNode, index) => {
      const key = boardNodeKey("investigation_node", graphNode.id);
      const saved = state.boardPositions.get(key);
      const position = saved
        ? { x: saved.x, y: saved.y }
        : { x: 40 + (index % columns) * 360, y: 90 };
      const card = investigationGraphNode(graphNode, position);
      state.displayPositions.set(key, position);
      return card;
    });
    nodesLayer.replaceChildren(...graphNodes);
    renderInvestigationInspector();
    requestAnimationFrame(() => {
      layoutUnsavedInvestigationGraphNodes(graphNodes);
      renderInvestigationGroups();
      syncInvestigationCanvasBounds();
      drawInvestigationEdges();
      if (shouldAutoFitInvestigationViewport()) fitInvestigationContent();
      focusCodeMapSyncNodes();
    });
    return;
  }

  const taskNodes = state.tasks.map((task, index) => {
    const position = investigationPosition("task", task.id, index, false);
    const card = investigationTaskNode(task, position);
    state.displayPositions.set(boardNodeKey("task", task.id), position);
    return card;
  });
  const artifactNodes = state.projectArtifacts.map((artifact, index) => {
    const position = investigationPosition("artifact", artifact.id, index, true);
    const card = investigationArtifactNode(artifact, position);
    state.displayPositions.set(boardNodeKey("artifact", artifact.id), position);
    return card;
  });
  nodesLayer.replaceChildren(...taskNodes, ...artifactNodes);
  state.selectedInvestigationNodeId = null;
  renderInvestigationInspector();
  requestAnimationFrame(() => {
    renderInvestigationGroups();
    syncInvestigationCanvasBounds();
    drawInvestigationEdges();
    if (shouldAutoFitInvestigationViewport()) fitInvestigationContent();
  });
}

function flowWorkGroupById(groupId) {
  return state.flowWorkGroups.find((group) => group.id === groupId) || null;
}

function flowWorkGroupDepth(group) {
  let depth = 0;
  const visited = new Set([group.id]);
  let parentId = group.parentGroupId;
  while (parentId) {
    if (visited.has(parentId)) break;
    visited.add(parentId);
    depth += 1;
    parentId = flowWorkGroupById(parentId)?.parentGroupId;
  }
  return depth;
}

function flowWorkGroupDescendantIds(groupId) {
  const descendants = new Set();
  const queue = [groupId];
  while (queue.length > 0) {
    const parentId = queue.shift();
    state.flowWorkGroups.forEach((group) => {
      if (group.parentGroupId !== parentId || descendants.has(group.id)) return;
      descendants.add(group.id);
      queue.push(group.id);
    });
  }
  return descendants;
}

function flowWorkGroupSubtreeIds(groupId) {
  return new Set([groupId, ...flowWorkGroupDescendantIds(groupId)]);
}

function flowWorkGroupDirectMemberships(groupId) {
  return state.flowWorkGroupMemberships.filter((membership) => membership.groupId === groupId);
}

function flowWorkGroupTaskIds(groupId) {
  const subtree = flowWorkGroupSubtreeIds(groupId);
  const taskIds = new Set(
    state.flowWorkGroupMemberships
      .filter((membership) => subtree.has(membership.groupId) && membership.entityType === "task")
      .map((membership) => membership.entityId),
  );
  state.flowWorkGroups.forEach((group) => {
    if (!subtree.has(group.id) || !group.linkedTaskId) return;
    taskIds.add(group.linkedTaskId);
    descendantTaskIds(group.linkedTaskId).forEach((taskId) => taskIds.add(taskId));
  });
  return taskIds;
}

function flowCodeScopeLensForTaskIds(taskIds, limit = FLOW_CODE_LENS_SCOPE_LIMIT) {
  const byNode = new Map();
  (state.codeMap.codeScopeBindings || []).forEach((binding) => {
    if (!taskIds.has(binding.taskId)) return;
    const entry = byNode.get(binding.codeNodeId) || {
      codeNodeId: binding.codeNodeId,
      codeNode: binding.codeNode,
      codeCanonicalIdentity: binding.codeCanonicalIdentity,
      state: binding.state,
      taskIds: new Set(),
      kinds: new Set(),
    };
    entry.taskIds.add(binding.taskId);
    entry.kinds.add(binding.kind);
    if (!entry.codeNode && binding.codeNode) entry.codeNode = binding.codeNode;
    if (entry.state !== "active" && binding.state === "active") entry.state = "active";
    byNode.set(binding.codeNodeId, entry);
  });
  const all = [...byNode.values()].sort((left, right) => {
    const stateDelta = Number(right.state === "active") - Number(left.state === "active");
    const leftLabel = left.codeNode?.name || left.codeCanonicalIdentity;
    const rightLabel = right.codeNode?.name || right.codeCanonicalIdentity;
    return stateDelta || leftLabel.localeCompare(rightLabel);
  });
  return { entries: all.slice(0, Math.max(0, limit)), total: all.length, truncated: all.length > limit };
}

function flowWorkGroupCodeLens(groupId, limit = FLOW_CODE_LENS_SCOPE_LIMIT) {
  return flowCodeScopeLensForTaskIds(flowWorkGroupTaskIds(groupId), limit);
}

function addFlowGroupAndAncestors(groupId, target) {
  const visited = new Set();
  let current = groupId;
  while (current && !visited.has(current)) {
    visited.add(current);
    target.add(current);
    current = flowWorkGroupById(current)?.parentGroupId;
  }
}

function relatedFlowContextForCodeScope(codeNodeId) {
  const bindings = (state.codeMap.codeScopeBindings || []).filter((binding) => binding.codeNodeId === codeNodeId);
  const taskIds = new Set(bindings.map((binding) => binding.taskId));
  const itemIds = new Set(
    state.investigationItemTaskLinks
      .filter((link) => taskIds.has(link.taskId))
      .map((link) => link.itemId),
  );
  const nodeIds = new Set(
    state.investigationGraphItems
      .filter((item) => itemIds.has(item.id))
      .map((item) => item.nodeId),
  );
  const groupIds = new Set();
  state.flowWorkGroupMemberships.forEach((membership) => {
    if ((membership.entityType === "task" && taskIds.has(membership.entityId))
      || (membership.entityType === "investigation_node" && nodeIds.has(membership.entityId))) {
      addFlowGroupAndAncestors(membership.groupId, groupIds);
    }
  });
  state.flowWorkGroups.forEach((group) => {
    if (!group.linkedTaskId) return;
    const linkedIds = new Set([group.linkedTaskId, ...descendantTaskIds(group.linkedTaskId)]);
    if ([...taskIds].some((taskId) => linkedIds.has(taskId))) addFlowGroupAndAncestors(group.id, groupIds);
  });
  return { bindings, taskIds, itemIds, nodeIds, groupIds };
}

function flowWorkGroupProgress(groupId) {
  const subtree = flowWorkGroupSubtreeIds(groupId);
  const taskIds = new Set(
    state.flowWorkGroupMemberships
      .filter((membership) => subtree.has(membership.groupId) && membership.entityType === "task")
      .map((membership) => membership.entityId),
  );
  const tasks = [...taskIds].map(taskById).filter(Boolean);
  return { total: tasks.length, done: tasks.filter((task) => task.status === "done").length };
}

function flowWorkGroupPathLabel(group) {
  const parts = [group.title];
  const visited = new Set([group.id]);
  let parentId = group.parentGroupId;
  while (parentId) {
    if (visited.has(parentId)) break;
    visited.add(parentId);
    const parent = flowWorkGroupById(parentId);
    if (!parent) break;
    parts.unshift(parent.title);
    parentId = parent.parentGroupId;
  }
  return parts.join(" › ");
}

function investigationNodeCard(nodeId) {
  return [...el["investigation-nodes"].children]
    .find((card) => card.dataset.entityType === "investigation_node" && card.dataset.entityId === nodeId) || null;
}

function flowWorkGroupShell(groupId) {
  return [...el["investigation-groups"].children]
    .find((shell) => shell.dataset.flowWorkGroupId === groupId) || null;
}

function toggleFlowCodeLens() {
  state.flowCodeLensEnabled = !state.flowCodeLensEnabled;
  if (!state.flowCodeLensEnabled) state.flowCodeFocus = { groupId: null, taskId: null, codeNodeId: null };
  renderInvestigationControls();
  if (state.viewMode === "investigation") renderInvestigationBoard();
}

function focusFlowGroupCode(groupId) {
  state.flowCodeLensEnabled = true;
  state.flowCodeFocus = { groupId, taskId: null, codeNodeId: null };
  renderInvestigationControls();
  renderInvestigationBoard();
}

async function jumpToCodeScope(codeNodeId) {
  if (!codeNodeId || !state.projectId) return;
  state.flowCodeFocus = { groupId: null, taskId: null, codeNodeId };
  setViewMode("code-map");
  await loadCodeMapContext();
  await openCodeMapNode(codeNodeId, { pushHistory: true });
}

async function showCodeScopeInFlow(codeNodeId) {
  if (!codeNodeId || !state.projectId) return;
  state.flowCodeLensEnabled = true;
  state.flowCodeFocus = { groupId: null, taskId: null, codeNodeId };
  setViewMode("investigation");
  await loadCodeMapContext();
  renderInvestigationBoard();
}

function flowCodeLensNode(entry) {
  const button = node("button", `flow-code-scope-chip ${entry.state}`);
  button.type = "button";
  button.disabled = entry.state !== "active";
  const label = entry.codeNode?.name || entry.codeCanonicalIdentity;
  button.append(
    node("strong", "flow-code-scope-name", label),
    node("span", "flow-code-scope-kind", entry.codeNode?.kind || entry.state),
  );
  button.title = entry.state === "active" ? `Open CodeScope: ${label}` : `${label} · ${entry.state}`;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (entry.state === "active") void jumpToCodeScope(entry.codeNodeId);
  });
  return button;
}

function renderFlowWorkGroupCodeLens(group) {
  const lens = flowWorkGroupCodeLens(group.id);
  if (!lens.total) return null;
  const shell = node("div", "flow-code-lens");
  const head = node("div", "flow-code-lens-head");
  head.append(
    node("span", "flow-code-lens-label", "Code"),
    node("span", "flow-code-lens-count", `${lens.total} scope${lens.total === 1 ? "" : "s"}`),
  );
  shell.append(head);
  const scopes = node("div", "flow-code-scope-list");
  lens.entries.slice(0, FLOW_CODE_LENS_INLINE_LIMIT).forEach((entry) => scopes.append(flowCodeLensNode(entry)));
  if (lens.total > FLOW_CODE_LENS_INLINE_LIMIT) {
    scopes.append(node("span", "flow-code-scope-more", `+${lens.total - FLOW_CODE_LENS_INLINE_LIMIT} more`));
  }
  shell.append(scopes);
  return shell;
}

function applyFlowCodeFocus() {
  const groups = [...el["investigation-groups"].children];
  const cards = [...el["investigation-nodes"].children];
  groups.forEach((shell) => shell.classList.remove("code-focus-related", "code-focus-selected"));
  cards.forEach((card) => card.classList.remove("code-focus-related"));
  el["investigation-nodes"].querySelectorAll(".investigation-item").forEach((item) => item.classList.remove("code-focus-related"));
  el["investigation-groups"].querySelectorAll(".flow-work-group-task").forEach((chip) => chip.classList.remove("code-focus-related"));
  if (!state.flowCodeLensEnabled) return;

  if (state.flowCodeFocus.groupId) {
    const subtree = flowWorkGroupSubtreeIds(state.flowCodeFocus.groupId);
    subtree.forEach((groupId) => flowWorkGroupShell(groupId)?.classList.add(groupId === state.flowCodeFocus.groupId ? "code-focus-selected" : "code-focus-related"));
    return;
  }
  if (!state.flowCodeFocus.codeNodeId) return;
  const context = relatedFlowContextForCodeScope(state.flowCodeFocus.codeNodeId);
  context.groupIds.forEach((groupId) => flowWorkGroupShell(groupId)?.classList.add("code-focus-related"));
  context.nodeIds.forEach((nodeId) => investigationNodeCard(nodeId)?.classList.add("code-focus-related"));
  context.itemIds.forEach((itemId) => {
    el["investigation-nodes"].querySelector(`[data-investigation-item-id="${CSS.escape(itemId)}"]`)?.classList.add("code-focus-related");
  });
  context.taskIds.forEach((taskId) => {
    el["investigation-groups"].querySelectorAll(`[data-flow-task-id="${CSS.escape(taskId)}"]`).forEach((chip) => chip.classList.add("code-focus-related"));
  });
}

function renderInvestigationGroups() {
  const layer = el["investigation-groups"];
  if (!layer) return;
  const groups = [...state.flowWorkGroups].sort((left, right) => {
    const depthDelta = flowWorkGroupDepth(left) - flowWorkGroupDepth(right);
    return depthDelta || left.createdAt.localeCompare(right.createdAt);
  });
  const shells = groups.map((group) => {
    const depth = flowWorkGroupDepth(group);
    const shell = node("section", `investigation-group flow-work-group depth-${Math.min(depth, 4)}`);
    shell.dataset.flowWorkGroupId = group.id;
    shell.style.left = `${group.x}px`;
    shell.style.top = `${group.y}px`;
    shell.style.width = `${group.width}px`;
    shell.style.height = `${group.collapsed ? 56 : group.height}px`;
    shell.style.zIndex = String(depth + 1);
    shell.classList.toggle("collapsed", Boolean(group.collapsed));

    const head = node("button", "investigation-group-head");
    head.type = "button";
    head.title = group.linkedTaskId ? "Open linked Task" : "Drag visual work group";
    const summary = node("span", "investigation-group-summary");
    summary.append(
      node("span", "investigation-group-kicker", depth ? `Group · L${depth + 1}` : "Group"),
      node("strong", "investigation-group-title", group.title),
    );
    const progress = flowWorkGroupProgress(group.id);
    if (progress.total) summary.append(node("span", "investigation-group-progress", `${progress.done}/${progress.total} done`));
    const childCount = state.flowWorkGroups.filter((candidate) => candidate.parentGroupId === group.id).length;
    if (childCount) summary.append(node("span", "investigation-group-progress", `${childCount} sub`));
    head.append(summary);
    if (group.goal) head.append(node("span", "investigation-group-goal", group.goal));
    attachInvestigationGroupDrag(head, shell, group);
    head.addEventListener("click", () => {
      if (head._suppressClick) {
        head._suppressClick = false;
        return;
      }
      if (group.linkedTaskId) void openTask(group.linkedTaskId);
    });
    shell.append(head);

    const actions = node("div", "flow-work-group-actions");
    const codeLens = flowWorkGroupCodeLens(group.id, 1);
    if (codeLens.total) {
      const code = node("button", "graph-icon-button flow-code-action", "⌘");
      code.type = "button";
      code.title = `Show ${codeLens.total} related CodeScope${codeLens.total === 1 ? "" : "s"}`;
      code.addEventListener("click", (event) => {
        event.stopPropagation();
        focusFlowGroupCode(group.id);
      });
      actions.append(code);
    }
    const addChild = node("button", "graph-icon-button", "+");
    addChild.type = "button";
    addChild.title = "Add subgroup";
    addChild.addEventListener("click", (event) => {
      event.stopPropagation();
      void createFlowWorkGroupFromPrompt(group.id);
    });
    const edit = node("button", "graph-icon-button", "✎");
    edit.type = "button";
    edit.title = "Edit visual group";
    edit.addEventListener("click", (event) => {
      event.stopPropagation();
      void editFlowWorkGroupFromPrompt(group);
    });
    actions.append(addChild, edit);
    shell.append(actions);

    if (state.flowCodeLensEnabled) {
      const lens = renderFlowWorkGroupCodeLens(group);
      if (lens) shell.append(lens);
    }

    if (!group.collapsed) {
      const taskMemberships = flowWorkGroupDirectMemberships(group.id).filter((membership) => membership.entityType === "task");
      if (taskMemberships.length > 0) {
        const taskRail = node("div", "flow-work-group-task-rail");
        taskMemberships.forEach((membership) => {
          const task = taskById(membership.entityId);
          if (!task) return;
          const chip = node("button", "flow-work-group-task");
          chip.type = "button";
          chip.dataset.flowTaskId = task.id;
          chip.append(taskStatusIcon(task.status), node("span", "flow-work-group-task-title", task.title));
          if (state.flowCodeLensEnabled) {
            const taskLens = flowCodeScopeLensForTaskIds(new Set([task.id]), 1);
            if (taskLens.total) chip.append(node("span", "flow-work-group-task-code-count", `${taskLens.total} code`));
          }
          chip.addEventListener("click", (event) => {
            event.stopPropagation();
            void openTask(task.id);
          });
          taskRail.append(chip);
        });
        shell.append(taskRail);
      }
    }
    return shell;
  });
  layer.replaceChildren(...shells);
  applyFlowCodeFocus();
}

function attachInvestigationGroupDrag(head, shell, group) {
  head.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || state.investigationHistoryBusy) return;
    const subtreeIds = flowWorkGroupSubtreeIds(group.id);
    const groupStarts = [...subtreeIds].map((groupId) => {
      const memberGroup = flowWorkGroupById(groupId);
      return memberGroup ? { groupId, position: { x: memberGroup.x, y: memberGroup.y } } : null;
    }).filter(Boolean);
    const nodeIds = new Set(
      state.flowWorkGroupMemberships
        .filter((membership) => subtreeIds.has(membership.groupId) && membership.entityType === "investigation_node")
        .map((membership) => membership.entityId),
    );
    const nodeStarts = [...nodeIds].map((nodeId) => {
      const position = state.displayPositions.get(boardNodeKey("investigation_node", nodeId));
      return position ? { nodeId, position: { ...position } } : null;
    }).filter(Boolean);
    if (groupStarts.length === 0) return;

    head.setPointerCapture(event.pointerId);
    head.classList.add("dragging-group");
    const startClientX = event.clientX;
    const startClientY = event.clientY;
    const minDx = Math.max(...groupStarts.map((entry) => 8 - entry.position.x));
    const minDy = Math.max(...groupStarts.map((entry) => 8 - entry.position.y));
    let latestDx = 0;
    let latestDy = 0;
    let moved = false;

    const onMove = (moveEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      const rawDx = (moveEvent.clientX - startClientX) / state.investigationZoom;
      const rawDy = (moveEvent.clientY - startClientY) / state.investigationZoom;
      if (Math.abs(rawDx) + Math.abs(rawDy) > 3) moved = true;
      latestDx = Math.max(minDx, rawDx);
      latestDy = Math.max(minDy, rawDy);
      groupStarts.forEach((entry) => {
        const memberShell = flowWorkGroupShell(entry.groupId);
        if (memberShell) memberShell.style.transform = `translate(${latestDx}px, ${latestDy}px)`;
      });
      nodeStarts.forEach((entry) => {
        const next = { x: entry.position.x + latestDx, y: entry.position.y + latestDy };
        state.displayPositions.set(boardNodeKey("investigation_node", entry.nodeId), next);
        const card = investigationNodeCard(entry.nodeId);
        if (card) setInvestigationNodePosition(card, next);
      });
      drawInvestigationEdges();
    };

    const onEnd = (endEvent) => {
      if (endEvent.pointerId !== event.pointerId) return;
      head.removeEventListener("pointermove", onMove);
      head.removeEventListener("pointerup", onEnd);
      head.removeEventListener("pointercancel", onEnd);
      head.classList.remove("dragging-group");
      if (!moved) return;
      head._suppressClick = true;
      const groupMoves = groupStarts.map((entry) => ({
        entityType: "flow_work_group",
        entityId: entry.groupId,
        from: entry.position,
        to: { x: entry.position.x + latestDx, y: entry.position.y + latestDy },
      }));
      const nodeMoves = nodeStarts.map((entry) => ({
        entityType: "investigation_node",
        entityId: entry.nodeId,
        from: entry.position,
        to: { x: entry.position.x + latestDx, y: entry.position.y + latestDy },
      }));
      void commitInvestigationGroupMove([...groupMoves, ...nodeMoves]);
    };

    head.addEventListener("pointermove", onMove);
    head.addEventListener("pointerup", onEnd);
    head.addEventListener("pointercancel", onEnd);
  });
}

async function persistFlowWorkGroupPosition(groupId, position) {
  const group = flowWorkGroupById(groupId);
  if (!group) return null;
  const { group: updated } = await api(`/flow-work-groups/${encodeURIComponent(groupId)}`, {
    method: "PATCH", actor: true,
    body: { x: position.x, y: position.y, expectedRevision: group.revision },
  });
  const index = state.flowWorkGroups.findIndex((candidate) => candidate.id === groupId);
  if (index >= 0) state.flowWorkGroups[index] = updated;
  return { x: updated.x, y: updated.y };
}

async function persistFlowHistoryMove(move) {
  if (move.entityType === "flow_work_group") return persistFlowWorkGroupPosition(move.entityId, move.to);
  return persistInvestigationPosition(move.entityType, move.entityId, move.to);
}

async function commitInvestigationGroupMove(moves) {
  state.investigationHistoryBusy = true;
  renderInvestigationControls();
  const historyEntries = [];
  for (const move of moves) {
    const saved = await persistFlowHistoryMove(move);
    if (!saved) continue;
    historyEntries.push({
      entityType: move.entityType,
      entityId: move.entityId,
      from: { ...move.from },
      to: { x: saved.x, y: saved.y },
    });
  }
  if (historyEntries.length > 0) {
    state.investigationUndo.push({ moves: historyEntries });
    if (state.investigationUndo.length > 100) state.investigationUndo.shift();
    state.investigationRedo = [];
  }
  state.investigationHistoryBusy = false;
  renderInvestigationControls();
  renderInvestigationGroups();
  syncInvestigationCanvasBounds();
  drawInvestigationEdges();
}

function investigationDefaultColumnCount() {
  const boardWidth = el["investigation-board"]?.clientWidth || 1440;
  const cardWidth = 330;
  const columnStep = 360;
  const horizontalPadding = 40;
  const usableWidth = Math.max(cardWidth, boardWidth - horizontalPadding * 2);
  return clamp(Math.floor((usableWidth + (columnStep - cardWidth)) / columnStep), 1, 4);
}

function layoutUnsavedInvestigationGraphNodes(cards) {
  const columns = investigationDefaultColumnCount();
  const columnStep = 360;
  const columnWidth = 330;
  const gap = 28;
  const columnX = Array.from({ length: columns }, (_, index) => 40 + index * columnStep);
  const columnBottoms = Array(columns).fill(90);

  state.investigationGraphNodes.forEach((graphNode, index) => {
    const key = boardNodeKey("investigation_node", graphNode.id);
    const saved = state.boardPositions.get(key);
    const card = cards[index];
    if (!saved || !card) return;
    const right = saved.x + card.offsetWidth;
    columnX.forEach((x, column) => {
      const overlapsColumn = saved.x < x + columnWidth && right > x;
      if (overlapsColumn) columnBottoms[column] = Math.max(columnBottoms[column], saved.y + card.offsetHeight + gap);
    });
  });

  state.investigationGraphNodes.forEach((graphNode, index) => {
    const key = boardNodeKey("investigation_node", graphNode.id);
    if (state.boardPositions.has(key)) return;
    const card = cards[index];
    if (!card) return;
    let column = 0;
    for (let candidate = 1; candidate < columns; candidate += 1) {
      if (columnBottoms[candidate] < columnBottoms[column]) column = candidate;
    }
    const position = { x: columnX[column], y: columnBottoms[column] };
    setInvestigationNodePosition(card, position);
    state.displayPositions.set(key, position);
    columnBottoms[column] = position.y + card.offsetHeight + gap;
  });
}

function syncInvestigationCanvasBounds() {
  const cards = [...el["investigation-nodes"].children].filter((card) => card.dataset.entityId);
  const boardWidth = el["investigation-board"]?.clientWidth || 0;
  let maxX = 0;
  let maxY = 0;
  cards.forEach((card) => {
    const key = boardNodeKey(card.dataset.entityType, card.dataset.entityId);
    const position = state.displayPositions.get(key);
    if (!position) return;
    maxX = Math.max(maxX, position.x + card.offsetWidth);
    maxY = Math.max(maxY, position.y + card.offsetHeight);
  });
  state.flowWorkGroups.forEach((group) => {
    maxX = Math.max(maxX, group.x + group.width);
    maxY = Math.max(maxY, group.y + (group.collapsed ? 56 : group.height));
  });
  el["investigation-canvas"].style.width = `${Math.max(1000, boardWidth, Math.ceil(maxX + 80))}px`;
  el["investigation-canvas"].style.height = `${Math.max(1000, Math.ceil(maxY + 80))}px`;
}

function investigationPosition(entityType, entityId, index, artifact) {
  const saved = state.boardPositions.get(boardNodeKey(entityType, entityId));
  if (saved) return { x: saved.x, y: saved.y };
  const columns = investigationDefaultColumnCount();
  const column = index % columns;
  const row = Math.floor(index / columns);
  return artifact
    ? { x: 40 + column * 360, y: 570 + row * 170 }
    : { x: 40 + column * 360, y: 90 + row * 180 };
}

function investigationTaskNode(task, position) {
  const card = node("article", "investigation-node investigation-task");
  card.dataset.entityType = "task";
  card.dataset.entityId = task.id;
  setInvestigationNodePosition(card, position);
  const title = node("strong", "investigation-node-title", task.title);
  card.append(title, taskStatusIcon(task.status));
  attachInvestigationDrag(card, "task", task.id, card);
  card.addEventListener("click", () => {
    if (card._suppressClick) {
      card._suppressClick = false;
      return;
    }
    void openTask(task.id);
  });
  return card;
}

function investigationArtifactNode(artifact, position) {
  const card = node("article", "investigation-node investigation-artifact");
  card.dataset.entityType = "artifact";
  card.dataset.entityId = artifact.id;
  setInvestigationNodePosition(card, position);
  card.append(node("strong", "investigation-node-title", artifact.title));
  attachInvestigationDrag(card, "artifact", artifact.id, card);
  return card;
}

function investigationGraphNode(graphNode, position) {
  const card = node("article", "investigation-node investigation-graph-node");
  card.dataset.entityType = "investigation_node";
  card.dataset.entityId = graphNode.id;
  card.classList.toggle("selected", state.selectedInvestigationNodeId === graphNode.id);
  setInvestigationNodePosition(card, position);

  const head = node("div", "investigation-node-head");
  const identity = node("div", "investigation-graph-identity");
  identity.append(node("strong", "investigation-node-title", graphNode.title));
  const codeMapBinding = codeMapNodeBindingForInvestigationNode(graphNode.id);
  if (codeMapBinding) identity.append(codeMapBindingBadges(codeMapBinding.state));
  const edit = node("button", "graph-icon-button", "✎");
  edit.type = "button";
  edit.title = "Edit node";
  edit.addEventListener("click", (event) => {
    event.stopPropagation();
    void editInvestigationNodeFromPrompt(graphNode);
  });
  head.append(identity, edit);
  card.append(head);

  const items = state.investigationGraphItems
    .filter((item) => item.nodeId === graphNode.id)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
  const itemList = node("div", "investigation-item-list");
  items.forEach((item) => itemList.append(investigationGraphItem(item)));
  card.append(itemList);

  const addItem = node("button", "graph-add-button", "+");
  addItem.type = "button";
  addItem.title = "Add item";
  addItem.addEventListener("click", () => void addInvestigationItemFromPrompt(graphNode.id));
  card.append(addItem);
  attachInvestigationDrag(card, "investigation_node", graphNode.id, head);
  card.addEventListener("click", (event) => {
    if (card._suppressClick || event.target.closest("button")) {
      card._suppressClick = false;
      return;
    }
    selectInvestigationNode(graphNode.id);
  });
  return card;
}

function selectInvestigationNode(nodeId) {
  state.selectedInvestigationNodeId = nodeId;
  [...el["investigation-nodes"].children].forEach((card) => {
    card.classList.toggle("selected", card.dataset.entityId === nodeId);
  });
  renderInvestigationInspector();
}

function clearInvestigationSelection() {
  state.selectedInvestigationNodeId = null;
  [...el["investigation-nodes"].children].forEach((card) => card.classList.remove("selected"));
  renderInvestigationInspector();
}

function renderInvestigationInspector() {
  const inspector = el["investigation-inspector"];
  if (!inspector) return;
  const graphNode = state.investigationGraphNodes.find((candidate) => candidate.id === state.selectedInvestigationNodeId);
  if (!graphNode) {
    if (state.selectedInvestigationNodeId) state.selectedInvestigationNodeId = null;
    inspector.classList.add("hidden");
    el["investigation-inspector-body"].replaceChildren();
    return;
  }

  inspector.classList.remove("hidden");
  el["investigation-inspector-title"].textContent = graphNode.title;
  const body = el["investigation-inspector-body"];
  const items = state.investigationGraphItems
    .filter((item) => item.nodeId === graphNode.id)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
  const itemIds = new Set(items.map((item) => item.id));
  const outgoing = state.investigationItemLinks.filter((link) => itemIds.has(link.fromItemId));
  const incoming = state.investigationItemLinks.filter((link) => link.toNodeId === graphNode.id);
  const taskLinks = state.investigationItemTaskLinks.filter((link) => itemIds.has(link.itemId));
  const binding = state.codeMapSyncPreview?.nodes?.find((entry) => entry.investigationNodeId === graphNode.id) || null;

  const summary = node("div", "investigation-inspector-summary");
  summary.append(
    inspectorMetric(String(items.length), "Items"),
    inspectorMetric(String(outgoing.length + incoming.length), "Flows"),
    inspectorMetric(String(taskLinks.length), "Tasks"),
  );

  const description = node("p", "investigation-inspector-description", graphNode.description || "No description yet.");
  const actions = node("div", "investigation-inspector-actions");
  const focus = node("button", "button compact secondary", "Focus");
  focus.type = "button";
  focus.addEventListener("click", () => focusInvestigationNode(graphNode.id));
  const edit = node("button", "button compact secondary", "Edit");
  edit.type = "button";
  edit.addEventListener("click", () => void editInvestigationNodeFromPrompt(graphNode));
  actions.append(focus, edit);

  const itemSection = node("div", "investigation-inspector-section");
  itemSection.append(node("span", "investigation-inspector-section-title", "Items"));
  if (items.length === 0) {
    itemSection.append(node("span", "investigation-inspector-empty", "No items in this node."));
  } else {
    items.forEach((item) => {
      const row = node("button", "investigation-inspector-item");
      row.type = "button";
      row.append(node("strong", "investigation-inspector-item-title", item.title));
      if (item.description) row.append(node("span", "investigation-inspector-item-description", item.description));
      const linkedTasks = state.investigationItemTaskLinks.filter((link) => link.itemId === item.id).length;
      const flows = state.investigationItemLinks.filter((link) => link.fromItemId === item.id).length;
      if (linkedTasks || flows) row.append(node("span", "investigation-inspector-item-meta", `${linkedTasks} tasks · ${flows} flows`));
      row.addEventListener("click", () => {
        const itemElement = el["investigation-nodes"].querySelector(`[data-investigation-item-id="${CSS.escape(item.id)}"]`);
        itemElement?.scrollIntoView({ block: "nearest", inline: "nearest" });
        itemElement?.classList.add("inspector-focus");
        window.setTimeout(() => itemElement?.classList.remove("inspector-focus"), 1200);
      });
      itemSection.append(row);
    });
  }

  body.replaceChildren(summary, description, actions);
  if (binding) body.append(codeMapBindingBadges(binding.state));
  body.append(renderFlowWorkGroupMembershipSection("investigation_node", graphNode.id));
  body.append(itemSection);
}

function inspectorMetric(value, label) {
  const metric = node("span", "investigation-inspector-metric");
  metric.append(node("strong", "", value), node("span", "", label));
  return metric;
}

function focusInvestigationNode(nodeId) {
  const position = state.displayPositions.get(boardNodeKey("investigation_node", nodeId));
  const card = [...el["investigation-nodes"].children].find((candidate) => candidate.dataset.entityId === nodeId);
  if (!position || !card) return;
  const board = el["investigation-board"];
  const inspectorReserve = board.clientWidth > 720 && !el["investigation-inspector"].classList.contains("hidden") ? 300 : 0;
  const viewportWidth = Math.max(240, board.clientWidth - inspectorReserve);
  const centerX = position.x + card.offsetWidth / 2;
  const centerY = position.y + card.offsetHeight / 2;
  state.investigationPan.x = viewportWidth / 2 - centerX * state.investigationZoom;
  state.investigationPan.y = board.clientHeight / 2 - centerY * state.investigationZoom;
  persistInvestigationViewport();
  applyInvestigationViewport();
  card.classList.add("inspector-node-focus");
  window.setTimeout(() => card.classList.remove("inspector-node-focus"), 1200);
}

function fitInvestigationContent() {
  const cards = [...el["investigation-nodes"].children].filter((card) => card.dataset.entityId);
  if (cards.length === 0 && state.flowWorkGroups.length === 0) return;
  const bounds = cards.reduce((acc, card) => {
    const key = boardNodeKey(card.dataset.entityType, card.dataset.entityId);
    const position = state.displayPositions.get(key);
    if (!position) return acc;
    acc.minX = Math.min(acc.minX, position.x);
    acc.minY = Math.min(acc.minY, position.y);
    acc.maxX = Math.max(acc.maxX, position.x + card.offsetWidth);
    acc.maxY = Math.max(acc.maxY, position.y + card.offsetHeight);
    return acc;
  }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  state.flowWorkGroups.forEach((group) => {
    bounds.minX = Math.min(bounds.minX, group.x);
    bounds.minY = Math.min(bounds.minY, group.y);
    bounds.maxX = Math.max(bounds.maxX, group.x + group.width);
    bounds.maxY = Math.max(bounds.maxY, group.y + (group.collapsed ? 56 : group.height));
  });
  if (!Number.isFinite(bounds.minX)) return;
  const board = el["investigation-board"];
  const inspectorReserve = board.clientWidth > 720 && !el["investigation-inspector"].classList.contains("hidden") ? 300 : 0;
  const viewportWidth = Math.max(240, board.clientWidth - inspectorReserve);
  const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
  const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
  const nextZoom = clamp(Math.min((viewportWidth - 64) / contentWidth, (board.clientHeight - 64) / contentHeight, 1.25), 0.35, 1.4);
  state.investigationZoom = nextZoom;
  state.investigationPan.x = (viewportWidth - contentWidth * nextZoom) / 2 - bounds.minX * nextZoom;
  state.investigationPan.y = (board.clientHeight - contentHeight * nextZoom) / 2 - bounds.minY * nextZoom;
  persistInvestigationViewport();
  applyInvestigationViewport();
  renderInvestigationControls();
}

function shouldAutoFitInvestigationViewport() {
  const board = el["investigation-board"];
  if (!board || !state.projectId || board.clientWidth <= 0 || board.clientHeight <= 0) return false;
  const meta = state.investigationViewportMeta;
  if (!meta || meta.projectId !== state.projectId) return true;
  const widthDelta = Math.abs(meta.width - board.clientWidth) / Math.max(meta.width, board.clientWidth, 1);
  const heightDelta = Math.abs(meta.height - board.clientHeight) / Math.max(meta.height, board.clientHeight, 1);
  return widthDelta > 0.2 || heightDelta > 0.3;
}

function investigationGraphItem(item) {
  const wrapper = node("section", "investigation-item");
  wrapper.dataset.investigationItemId = item.id;
  wrapper.tabIndex = 0;
  wrapper.setAttribute("aria-label", item.title);
  const taskLinks = state.investigationItemTaskLinks
    .filter((link) => link.itemId === item.id)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const linkedTasks = taskLinks
    .map((link) => state.tasks.find((candidate) => candidate.id === link.taskId))
    .filter(Boolean);
  const directTask = linkedTasks.length === 1 ? linkedTasks[0] : null;
  if (directTask) {
    wrapper.classList.add("investigation-item-single-task");
    wrapper.setAttribute("role", "button");
    wrapper.setAttribute("aria-label", `Open Task: ${directTask.title}`);
    wrapper.title = `Open Task: ${directTask.title}`;
    const openDirectTask = (event) => {
      if (event.target?.closest?.("button")) return;
      event.preventDefault();
      event.stopPropagation();
      if (document.activeElement instanceof HTMLElement && wrapper.contains(document.activeElement)) document.activeElement.blur();
      void openTask(directTask.id);
    };
    wrapper.addEventListener("click", openDirectTask);
    wrapper.addEventListener("keydown", (event) => {
      if ((event.key === "Enter" || event.key === " ") && event.target === wrapper) openDirectTask(event);
    });
  }
  const codeMapBinding = codeMapRelationBindingForInvestigationItem(item.id);
  if (codeMapBinding) wrapper.append(codeMapBindingBadges(codeMapBinding.state));
  const head = node("div", "investigation-item-head");
  const title = node("strong", "investigation-item-title", item.title);
  const actions = node("div", "investigation-item-actions");
  const edit = graphActionButton("✎", "Edit item", () => void editInvestigationItemFromPrompt(item));
  const task = graphActionButton("+", "Link or create a Task", () => void addTaskToInvestigationItem(item));
  const connect = graphActionButton("↗", "Connect this item to another Node", () => void connectInvestigationItemToNode(item));
  actions.append(edit, task, connect);
  head.append(title, actions);
  wrapper.append(head);

  if (taskLinks.length > 0) {
    const chips = node("div", "investigation-task-chips");
    taskLinks.forEach((link) => {
      const linkedTask = state.tasks.find((candidate) => candidate.id === link.taskId);
      if (!linkedTask) return;
      const chip = node("div", `investigation-task-chip status-${linkedTask.status}`);
      const open = node("button", "investigation-task-chip-main");
      open.type = "button";
      open.title = `${labelForStatus(linkedTask.status)} · ${linkedTask.priority}`;
      open.append(
        node("span", "investigation-task-chip-title", linkedTask.title),
        taskStatusIcon(linkedTask.status),
      );
      open.addEventListener("click", (event) => {
        event.stopPropagation();
        open.blur();
        void openTask(linkedTask.id);
      });
      const unlink = node("button", "investigation-link-remove", "×");
      unlink.type = "button";
      unlink.title = `Unlink Task: ${linkedTask.title}`;
      unlink.addEventListener("click", (event) => {
        event.stopPropagation();
        void unlinkTaskFromInvestigationItem(item.id, linkedTask.id);
      });
      chip.append(open, unlink);
      chips.append(chip);
    });
    wrapper.append(chips);
  }

  const outgoing = state.investigationItemLinks.filter((link) => link.fromItemId === item.id);
  if (outgoing.length > 0) {
    const links = node("div", "investigation-item-links");
    outgoing.forEach((link) => {
      const target = state.investigationGraphNodes.find((candidate) => candidate.id === link.toNodeId);
      const row = node("div", "investigation-item-link-row");
      const copy = node(
        "span",
        "investigation-item-link-copy",
        `${link.label ? `${link.label} → ` : "→ "}${target?.title || "Connected node"}`,
      );
      const remove = node("button", "investigation-link-remove", "×");
      remove.type = "button";
      remove.title = `Remove connection to ${target?.title || "node"}`;
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        void removeInvestigationItemConnection(link.id);
      });
      row.append(copy, remove);
      links.append(row);
    });
    wrapper.append(links);
  }
  return wrapper;
}

function focusCodeMapSyncNodes() {
  const ids = state.codeMapSyncFocusNodeIds;
  if (!ids?.length || state.viewMode !== "investigation") return;
  if (!state.codeMapSyncFocusDeadline) state.codeMapSyncFocusDeadline = Date.now() + 6000;
  const deadline = state.codeMapSyncFocusDeadline;
  if (Date.now() >= deadline) {
    state.codeMapSyncFocusNodeIds = [];
    state.codeMapSyncFocusDeadline = 0;
    state.codeMapSyncFocusCentered = false;
    return;
  }
  const positions = ids.map((id) => state.displayPositions.get(boardNodeKey("investigation_node", id))).filter(Boolean);
  if (positions.length === 0) return;
  if (!state.codeMapSyncFocusCentered) {
    const board = el["investigation-board"];
    const center = positions.reduce((sum, position) => ({ x: sum.x + position.x, y: sum.y + position.y }), { x: 0, y: 0 });
    center.x = center.x / positions.length + 165;
    center.y = center.y / positions.length + 70;
    state.investigationPan.x = board.clientWidth / 2 - center.x * state.investigationZoom;
    state.investigationPan.y = board.clientHeight / 2 - center.y * state.investigationZoom;
    persistInvestigationViewport();
    applyInvestigationViewport();
    state.codeMapSyncFocusCentered = true;
  }
  ids.forEach((id) => {
    const card = [...el["investigation-nodes"].children].find((candidate) => candidate.dataset.entityId === id);
    if (card) card.classList.add("code-map-sync-focus");
  });
  const focusIds = [...ids];
  window.setTimeout(() => {
    if (state.codeMapSyncFocusDeadline !== deadline) return;
    state.codeMapSyncFocusNodeIds = [];
    state.codeMapSyncFocusDeadline = 0;
    state.codeMapSyncFocusCentered = false;
    focusIds.forEach((id) => {
      const card = [...el["investigation-nodes"].children].find((candidate) => candidate.dataset.entityId === id);
      card?.classList.remove("code-map-sync-focus");
    });
  }, Math.max(0, deadline - Date.now()));
}

function graphActionButton(label, title, onClick) {
  const button = node("button", "graph-item-action", label);
  button.type = "button";
  button.title = title;
  button.addEventListener("click", onClick);
  return button;
}

async function createFlowWorkGroupFromPrompt(parentGroupId = null) {
  if (!state.projectId) return;
  const parent = parentGroupId ? flowWorkGroupById(parentGroupId) : null;
  const title = window.prompt(parent ? `Subgroup title inside ${parent.title}` : "Flow group title");
  if (!title?.trim()) return;
  const goal = window.prompt("Group goal (optional)", "") ?? "";
  const board = el["investigation-board"];
  const centerX = (board.clientWidth / 2 - state.investigationPan.x) / state.investigationZoom;
  const centerY = (board.clientHeight / 2 - state.investigationPan.y) / state.investigationZoom;
  const width = parent ? Math.max(220, Math.min(520, parent.width - 56)) : 760;
  const height = parent ? Math.max(140, Math.min(300, parent.height - 118)) : 460;
  const x = parent ? parent.x + 28 : Math.max(16, centerX - width / 2);
  const y = parent ? parent.y + 92 : Math.max(16, centerY - 72);
  try {
    await api(`/projects/${encodeURIComponent(state.projectId)}/flow-work-groups`, {
      method: "POST", actor: true,
      body: { title, goal, x, y, width, height, ...(parent ? { parentGroupId: parent.id } : {}) },
    });
    await loadBoard();
    toast(parent ? `Subgroup created in ${parent.title}` : "Flow group created");
  } catch (error) {
    fail(error);
  }
}

async function editFlowWorkGroupFromPrompt(group) {
  const title = window.prompt("Flow group title", group.title);
  if (!title?.trim()) return;
  const goal = window.prompt("Group goal", group.goal || "") ?? group.goal;
  try {
    await api(`/flow-work-groups/${encodeURIComponent(group.id)}`, {
      method: "PATCH", actor: true,
      body: { title, goal, expectedRevision: group.revision },
    });
    await loadBoard();
  } catch (error) {
    fail(error);
  }
}

function currentFlowWorkGroupMembership(entityType, entityId) {
  return state.flowWorkGroupMemberships.find((membership) => (
    membership.entityType === entityType && membership.entityId === entityId
  )) || null;
}

async function changeFlowWorkGroupMembership(entityType, entityId, nextGroupId) {
  const current = currentFlowWorkGroupMembership(entityType, entityId);
  if (current?.groupId === nextGroupId || (!current && !nextGroupId)) return;
  try {
    if (!nextGroupId) {
      await api(`/flow-work-groups/${encodeURIComponent(current.groupId)}/members/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`, {
        method: "DELETE", actor: true,
      });
    } else {
      await api(`/flow-work-groups/${encodeURIComponent(nextGroupId)}/members/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`, {
        method: "PUT", actor: true,
      });
    }
    await loadBoard();
    if (entityType === "investigation_node") selectInvestigationNode(entityId);
    else if (entityType === "task") await openTask(entityId);
  } catch (error) {
    fail(error);
  }
}

function renderFlowWorkGroupMembershipSection(entityType, entityId) {
  const section = node("section", "detail-section flow-group-membership-section");
  section.append(node("h3", "section-title", "Flow group"));
  const current = currentFlowWorkGroupMembership(entityType, entityId);
  const select = document.createElement("select");
  select.className = "flow-group-membership-select";
  select.append(option("", "Ungrouped"));
  [...state.flowWorkGroups]
    .sort((left, right) => flowWorkGroupPathLabel(left).localeCompare(flowWorkGroupPathLabel(right)))
    .forEach((group) => select.append(option(group.id, flowWorkGroupPathLabel(group))));
  select.value = current?.groupId || "";
  select.addEventListener("change", () => void changeFlowWorkGroupMembership(entityType, entityId, select.value));
  const hint = node("span", "muted", current
    ? "Visual Flow membership. This does not change the canonical Task hierarchy."
    : "Assign this item to any visual Group depth, or leave it ungrouped.");
  section.append(select, hint);
  return section;
}


async function createInvestigationNodeFromPrompt() {
  if (!state.projectId) return;
  const title = window.prompt("Node title");
  if (!title?.trim()) return;
  const description = window.prompt("Node description (optional)", "") ?? "";
  try {
    const { node: created } = await api(`/projects/${encodeURIComponent(state.projectId)}/investigation/nodes`, {
      method: "POST", actor: true, body: { title, description },
    });
    const board = el["investigation-board"];
    const position = {
      x: clamp((board.clientWidth / 2 - state.investigationPan.x) / state.investigationZoom - 160, 16, 1450),
      y: clamp((board.clientHeight / 2 - state.investigationPan.y) / state.investigationZoom - 80, 16, 820),
    };
    await persistInvestigationPosition("investigation_node", created.id, position);
    await loadBoard();
    toast("Investigation node created");
  } catch (error) {
    fail(error);
  }
}

async function editInvestigationNodeFromPrompt(graphNode) {
  const title = window.prompt("Node title", graphNode.title);
  if (!title?.trim()) return;
  const description = window.prompt("Node description", graphNode.description) ?? graphNode.description;
  try {
    await api(`/investigation/nodes/${encodeURIComponent(graphNode.id)}`, {
      method: "PATCH", actor: true, body: { title, description, expectedRevision: graphNode.revision },
    });
    await loadBoard();
  } catch (error) {
    fail(error);
  }
}

async function addInvestigationItemFromPrompt(nodeId) {
  const title = window.prompt("Item title");
  if (!title?.trim()) return;
  const description = window.prompt("Item description (optional)", "") ?? "";
  try {
    await api(`/investigation/nodes/${encodeURIComponent(nodeId)}/items`, {
      method: "POST", actor: true, body: { title, description },
    });
    await loadBoard();
  } catch (error) {
    fail(error);
  }
}

async function editInvestigationItemFromPrompt(item) {
  const title = window.prompt("Item title", item.title);
  if (!title?.trim()) return;
  const description = window.prompt("Item description", item.description) ?? item.description;
  try {
    await api(`/investigation/items/${encodeURIComponent(item.id)}`, {
      method: "PATCH", actor: true, body: { title, description, expectedRevision: item.revision },
    });
    await loadBoard();
  } catch (error) {
    fail(error);
  }
}

async function addTaskToInvestigationItem(item) {
  const createNew = window.confirm("Create a new Task for this item?\n\nOK = create new\nCancel = link an existing Task");
  if (createNew) {
    const title = window.prompt("New Task title");
    if (!title?.trim()) return;
    const description = window.prompt("Task description (optional)", "") ?? "";
    try {
      await api(`/investigation/items/${encodeURIComponent(item.id)}/tasks/new`, {
        method: "POST", actor: true, body: { title, description, status: "inbox", priority: "normal" },
      });
      await loadBoard();
    } catch (error) {
      fail(error);
    }
    return;
  }

  const linkedIds = new Set(state.investigationItemTaskLinks.filter((link) => link.itemId === item.id).map((link) => link.taskId));
  const candidates = state.tasks.filter((candidate) => !linkedIds.has(candidate.id));
  const selected = chooseInvestigationCandidate("Link which existing Task?", candidates, (candidate) => `${candidate.title} · ${labelForStatus(candidate.status)}`);
  if (!selected) return;
  try {
    await api(`/investigation/items/${encodeURIComponent(item.id)}/tasks`, {
      method: "POST", actor: true, body: { taskId: selected.id },
    });
    await loadBoard();
  } catch (error) {
    fail(error);
  }
}

async function connectInvestigationItemToNode(item) {
  const candidates = state.investigationGraphNodes.filter((candidate) => candidate.id !== item.nodeId);
  const selected = chooseInvestigationCandidate("Connect this item to which Node?", candidates, (candidate) => candidate.title);
  if (!selected) return;
  const label = window.prompt("Connection label (optional)", "") ?? "";
  try {
    await api("/investigation/item-links", {
      method: "POST", actor: true, body: { fromItemId: item.id, toNodeId: selected.id, label },
    });
    await loadBoard();
  } catch (error) {
    fail(error);
  }
}

async function unlinkTaskFromInvestigationItem(itemId, taskId) {
  try {
    await api(`/investigation/items/${encodeURIComponent(itemId)}/tasks/${encodeURIComponent(taskId)}`, {
      method: "DELETE", actor: true,
    });
    await loadBoard();
    toast("Task link removed");
  } catch (error) {
    fail(error);
  }
}

async function removeInvestigationItemConnection(linkId) {
  try {
    await api(`/investigation/item-links/${encodeURIComponent(linkId)}`, {
      method: "DELETE", actor: true,
    });
    await loadBoard();
    toast("Flow connection removed");
  } catch (error) {
    fail(error);
  }
}

function chooseInvestigationCandidate(promptTitle, candidates, labeler) {
  if (candidates.length === 0) {
    toast("Nothing available to link");
    return null;
  }
  const menu = candidates.map((candidate, index) => `${index + 1}. ${labeler(candidate)}`).join("\n");
  const raw = window.prompt(`${promptTitle}\n\n${menu}\n\nEnter a number:`);
  if (raw === null) return null;
  const index = Number.parseInt(raw, 10) - 1;
  return Number.isInteger(index) && index >= 0 && index < candidates.length ? candidates[index] : null;
}

function attachInvestigationDrag(card, entityType, entityId, dragRegion = card) {
  dragRegion.classList.add("investigation-node-drag-region");
  dragRegion.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || state.investigationHistoryBusy) return;
    if (event.target instanceof Element && event.target.closest("button, input, textarea, select, a")) return;
    const key = boardNodeKey(entityType, entityId);
    const start = state.displayPositions.get(key);
    if (!start) return;
    dragRegion.setPointerCapture(event.pointerId);
    card.classList.add("dragging-node");
    const startClientX = event.clientX;
    const startClientY = event.clientY;
    let latest = { ...start };
    let moved = false;

    const onMove = (moveEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      const dx = (moveEvent.clientX - startClientX) / state.investigationZoom;
      const dy = (moveEvent.clientY - startClientY) / state.investigationZoom;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      latest = {
        x: clamp(start.x + dx, 16, 1540),
        y: clamp(start.y + dy, 16, Math.max(820, el["investigation-canvas"].clientHeight - 150)),
      };
      state.displayPositions.set(key, latest);
      setInvestigationNodePosition(card, latest);
      if (entityType === "investigation_node") renderInvestigationGroups();
      drawInvestigationEdges();
    };
    const onEnd = (endEvent) => {
      if (endEvent.pointerId !== event.pointerId) return;
      dragRegion.removeEventListener("pointermove", onMove);
      dragRegion.removeEventListener("pointerup", onEnd);
      dragRegion.removeEventListener("pointercancel", onEnd);
      card.classList.remove("dragging-node");
      if (moved) {
        card._suppressClick = true;
        void commitInvestigationMove(entityType, entityId, start, latest);
      }
    };
    dragRegion.addEventListener("pointermove", onMove);
    dragRegion.addEventListener("pointerup", onEnd);
    dragRegion.addEventListener("pointercancel", onEnd);
  });
}

function bindInvestigationViewportGestures() {
  const board = el["investigation-board"];
  board.addEventListener("wheel", (event) => {
    if (state.viewMode !== "investigation") return;
    event.preventDefault();
    if (event.ctrlKey) {
      const rect = board.getBoundingClientRect();
      setInvestigationZoom(
        state.investigationZoom * Math.exp(-event.deltaY * 0.01),
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
      );
      return;
    }
    state.investigationPan.x -= event.deltaX;
    state.investigationPan.y -= event.deltaY;
    persistInvestigationViewport();
    applyInvestigationViewport();
  }, { passive: false });

  board.addEventListener("pointerdown", (event) => {
    if (state.viewMode !== "investigation") return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest(".investigation-node, .investigation-controls, button, input, textarea, select, a")) return;
    board.setPointerCapture(event.pointerId);
    state.investigationPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    beginInvestigationGesture();
    board.classList.add("panning");
  });

  board.addEventListener("pointermove", (event) => {
    if (!state.investigationPointers.has(event.pointerId)) return;
    state.investigationPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    updateInvestigationGesture();
  });

  const endPointer = (event) => {
    if (!state.investigationPointers.has(event.pointerId)) return;
    state.investigationPointers.delete(event.pointerId);
    beginInvestigationGesture();
    if (state.investigationPointers.size === 0) {
      state.investigationGesture = null;
      board.classList.remove("panning");
      persistInvestigationViewport();
    }
  };
  board.addEventListener("pointerup", endPointer);
  board.addEventListener("pointercancel", endPointer);
}

function beginInvestigationGesture() {
  const points = [...state.investigationPointers.values()];
  if (points.length === 0) {
    state.investigationGesture = null;
    return;
  }
  if (points.length === 1) {
    state.investigationGesture = { type: "pan", last: { ...points[0] } };
    return;
  }
  const board = el["investigation-board"];
  const rect = board.getBoundingClientRect();
  const midpoint = pointerMidpoint(points[0], points[1]);
  const localMidpoint = { x: midpoint.x - rect.left, y: midpoint.y - rect.top };
  state.investigationGesture = {
    type: "pinch",
    startDistance: pointerDistance(points[0], points[1]),
    startZoom: state.investigationZoom,
    world: {
      x: (localMidpoint.x - state.investigationPan.x) / state.investigationZoom,
      y: (localMidpoint.y - state.investigationPan.y) / state.investigationZoom,
    },
  };
}

function updateInvestigationGesture() {
  const points = [...state.investigationPointers.values()];
  const gesture = state.investigationGesture;
  if (!gesture) return;
  if (points.length === 1 && gesture.type === "pan") {
    const point = points[0];
    state.investigationPan.x += point.x - gesture.last.x;
    state.investigationPan.y += point.y - gesture.last.y;
    gesture.last = { ...point };
    applyInvestigationViewport();
    return;
  }
  if (points.length < 2 || gesture.type !== "pinch") return;
  const board = el["investigation-board"];
  const rect = board.getBoundingClientRect();
  const midpoint = pointerMidpoint(points[0], points[1]);
  const localMidpoint = { x: midpoint.x - rect.left, y: midpoint.y - rect.top };
  const distance = Math.max(1, pointerDistance(points[0], points[1]));
  const nextZoom = clamp(gesture.startZoom * distance / Math.max(1, gesture.startDistance), 0.35, 2.5);
  state.investigationZoom = nextZoom;
  state.investigationPan.x = localMidpoint.x - gesture.world.x * nextZoom;
  state.investigationPan.y = localMidpoint.y - gesture.world.y * nextZoom;
  persistInvestigationViewport();
  applyInvestigationViewport();
  renderInvestigationControls();
}

function pointerDistance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function pointerMidpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

async function commitInvestigationMove(entityType, entityId, from, to) {
  state.investigationHistoryBusy = true;
  renderInvestigationControls();
  const saved = await persistInvestigationPosition(entityType, entityId, to);
  if (saved) {
    state.investigationUndo.push({ entityType, entityId, from: { ...from }, to: { x: saved.x, y: saved.y } });
    if (state.investigationUndo.length > 100) state.investigationUndo.shift();
    state.investigationRedo = [];
  }
  state.investigationHistoryBusy = false;
  renderInvestigationControls();
}

async function undoInvestigationMove() {
  if (state.investigationHistoryBusy || state.investigationUndo.length === 0) return;
  const entry = state.investigationUndo[state.investigationUndo.length - 1];
  if (await applyInvestigationHistoryAction(entry, "from")) {
    state.investigationUndo.pop();
    state.investigationRedo.push(entry);
  }
  renderInvestigationControls();
}

async function redoInvestigationMove() {
  if (state.investigationHistoryBusy || state.investigationRedo.length === 0) return;
  const entry = state.investigationRedo[state.investigationRedo.length - 1];
  if (await applyInvestigationHistoryAction(entry, "to")) {
    state.investigationRedo.pop();
    state.investigationUndo.push(entry);
  }
  renderInvestigationControls();
}

async function applyInvestigationHistoryAction(entry, direction) {
  state.investigationHistoryBusy = true;
  renderInvestigationControls();
  const moves = Array.isArray(entry.moves) ? entry.moves : [entry];
  let allSaved = true;
  for (const move of moves) {
    const position = move[direction];
    if (!position) {
      allSaved = false;
      break;
    }
    let saved;
    if (move.entityType === "flow_work_group") {
      saved = await persistFlowWorkGroupPosition(move.entityId, position);
    } else {
      const key = boardNodeKey(move.entityType, move.entityId);
      state.displayPositions.set(key, { ...position });
      const card = [...el["investigation-nodes"].children].find((candidate) => (
        candidate.dataset.entityType === move.entityType && candidate.dataset.entityId === move.entityId
      ));
      if (card) setInvestigationNodePosition(card, position);
      saved = await persistInvestigationPosition(move.entityType, move.entityId, position);
    }
    if (!saved) {
      allSaved = false;
      break;
    }
  }
  renderInvestigationGroups();
  syncInvestigationCanvasBounds();
  drawInvestigationEdges();
  state.investigationHistoryBusy = false;
  return allSaved;
}

function resetInvestigationHistory() {
  state.investigationUndo = [];
  state.investigationRedo = [];
  state.investigationHistoryBusy = false;
  renderInvestigationControls();
}

function renderInvestigationControls() {
  if (!el["investigation-undo"]) return;
  el["investigation-undo"].disabled = state.investigationHistoryBusy || state.investigationUndo.length === 0;
  el["investigation-redo"].disabled = state.investigationHistoryBusy || state.investigationRedo.length === 0;
  el["investigation-zoom-out"].disabled = state.investigationZoom <= 0.35;
  el["investigation-zoom-in"].disabled = state.investigationZoom >= 2.5;
  el["investigation-zoom-reset"].textContent = `${Math.round(state.investigationZoom * 100)}%`;
  el["investigation-fit"].disabled = state.displayPositions.size === 0;
  el["investigation-code-lens"].classList.toggle("active", state.flowCodeLensEnabled);
  el["investigation-code-lens"].setAttribute("aria-pressed", String(state.flowCodeLensEnabled));
  el["investigation-code-lens"].textContent = state.flowCodeLensEnabled ? "Hide code" : "Show code";
}

function setInvestigationZoom(value, focalPoint = null) {
  const next = clamp(value, 0.35, 2.5);
  if (next === state.investigationZoom) return;
  const board = el["investigation-board"];
  const oldZoom = state.investigationZoom;
  const point = focalPoint || { x: board.clientWidth / 2, y: board.clientHeight / 2 };
  const worldX = (point.x - state.investigationPan.x) / oldZoom;
  const worldY = (point.y - state.investigationPan.y) / oldZoom;
  state.investigationZoom = next;
  state.investigationPan.x = point.x - worldX * next;
  state.investigationPan.y = point.y - worldY * next;
  persistInvestigationViewport();
  applyInvestigationViewport();
  renderInvestigationControls();
}

function resetInvestigationViewport() {
  state.investigationZoom = 1;
  state.investigationPan = { x: 0, y: 0 };
  persistInvestigationViewport();
  applyInvestigationViewport();
  renderInvestigationControls();
}

function persistInvestigationViewport() {
  localStorage.setItem("questboard.investigationZoom", String(state.investigationZoom));
  localStorage.setItem("questboard.investigationPan", JSON.stringify(state.investigationPan));
  const board = el["investigation-board"];
  if (state.projectId && board?.clientWidth > 0 && board?.clientHeight > 0) {
    state.investigationViewportMeta = {
      projectId: state.projectId,
      width: board.clientWidth,
      height: board.clientHeight,
    };
    localStorage.setItem("questboard.investigationViewportMeta", JSON.stringify(state.investigationViewportMeta));
  }
}

function applyInvestigationViewport() {
  if (!el["investigation-canvas"]) return;
  el["investigation-canvas"].style.transform = `translate3d(${state.investigationPan.x}px, ${state.investigationPan.y}px, 0) scale(${state.investigationZoom})`;
  el["investigation-canvas"].style.transformOrigin = "top left";
}

function setInvestigationNodePosition(card, position) {
  card.style.left = `${position.x}px`;
  card.style.top = `${position.y}px`;
}

function investigationEdgeRect(card, padding = 0) {
  const key = boardNodeKey(card.dataset.entityType, card.dataset.entityId);
  const position = state.displayPositions.get(key);
  if (!position) return null;
  return {
    left: position.x - padding,
    top: position.y - padding,
    right: position.x + card.offsetWidth + padding,
    bottom: position.y + card.offsetHeight + padding,
    width: card.offsetWidth + padding * 2,
    height: card.offsetHeight + padding * 2,
    centerX: position.x + card.offsetWidth / 2,
    centerY: position.y + card.offsetHeight / 2,
  };
}

function investigationEdgeAnchor(rect, towardRect, itemY = null) {
  const dx = towardRect.centerX - rect.centerX;
  const dy = towardRect.centerY - rect.centerY;
  if (Math.abs(dx) >= Math.abs(dy) * 0.8) {
    const side = dx >= 0 ? "right" : "left";
    return {
      side,
      x: side === "right" ? rect.right : rect.left,
      y: clamp(itemY ?? rect.centerY, rect.top + 16, rect.bottom - 16),
    };
  }
  const side = dy >= 0 ? "bottom" : "top";
  return {
    side,
    x: rect.centerX,
    y: side === "bottom" ? rect.bottom : rect.top,
  };
}

function investigationEdgeLead(anchor, clearance = 16) {
  if (anchor.side === "left") return { x: anchor.x - clearance, y: anchor.y };
  if (anchor.side === "right") return { x: anchor.x + clearance, y: anchor.y };
  if (anchor.side === "top") return { x: anchor.x, y: anchor.y - clearance };
  return { x: anchor.x, y: anchor.y + clearance };
}

function simplifyOrthogonalPoints(points) {
  const deduped = points.filter((point, index) => index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y);
  return deduped.filter((point, index) => {
    if (index === 0 || index === deduped.length - 1) return true;
    const previous = deduped[index - 1];
    const next = deduped[index + 1];
    return !((previous.x === point.x && point.x === next.x) || (previous.y === point.y && point.y === next.y));
  });
}

function orthogonalSegmentHitsRect(from, to, rect) {
  if (from.x === to.x) {
    const minY = Math.min(from.y, to.y);
    const maxY = Math.max(from.y, to.y);
    return from.x > rect.left && from.x < rect.right && maxY > rect.top && minY < rect.bottom;
  }
  if (from.y === to.y) {
    const minX = Math.min(from.x, to.x);
    const maxX = Math.max(from.x, to.x);
    return from.y > rect.top && from.y < rect.bottom && maxX > rect.left && minX < rect.right;
  }
  return true;
}

function orthogonalRouteClear(points, obstacles) {
  for (let index = 1; index < points.length; index += 1) {
    if (obstacles.some((rect) => orthogonalSegmentHitsRect(points[index - 1], points[index], rect))) return false;
  }
  return true;
}

function orthogonalRouteScore(points) {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += Math.abs(points[index].x - points[index - 1].x) + Math.abs(points[index].y - points[index - 1].y);
  }
  return length + Math.max(0, points.length - 2) * 8;
}

function routeInvestigationEdge(sourceAnchor, targetAnchor, obstacles, allRects) {
  const sourceLead = investigationEdgeLead(sourceAnchor);
  const targetLead = investigationEdgeLead(targetAnchor);
  const bounds = allRects.reduce((result, rect) => ({
    left: Math.min(result.left, rect.left),
    top: Math.min(result.top, rect.top),
    right: Math.max(result.right, rect.right),
    bottom: Math.max(result.bottom, rect.bottom),
  }), { left: sourceLead.x, top: sourceLead.y, right: sourceLead.x, bottom: sourceLead.y });
  const outer = 28;
  const xCorridors = [
    (sourceLead.x + targetLead.x) / 2,
    bounds.left - outer,
    bounds.right + outer,
  ];
  const yCorridors = [
    (sourceLead.y + targetLead.y) / 2,
    bounds.top - outer,
    bounds.bottom + outer,
  ];
  const candidates = [];

  xCorridors.forEach((x) => {
    candidates.push([sourceAnchor, sourceLead, { x, y: sourceLead.y }, { x, y: targetLead.y }, targetLead, targetAnchor]);
  });
  yCorridors.forEach((y) => {
    candidates.push([sourceAnchor, sourceLead, { x: sourceLead.x, y }, { x: targetLead.x, y }, targetLead, targetAnchor]);
  });
  [bounds.left - outer, bounds.right + outer].forEach((x) => {
    [bounds.top - outer, bounds.bottom + outer].forEach((y) => {
      candidates.push([
        sourceAnchor,
        sourceLead,
        { x, y: sourceLead.y },
        { x, y },
        { x: targetLead.x, y },
        targetLead,
        targetAnchor,
      ]);
      candidates.push([
        sourceAnchor,
        sourceLead,
        { x: sourceLead.x, y },
        { x, y },
        { x, y: targetLead.y },
        targetLead,
        targetAnchor,
      ]);
    });
  });

  const clearRoutes = candidates
    .map(simplifyOrthogonalPoints)
    .filter((points) => orthogonalRouteClear(points, obstacles))
    .sort((left, right) => orthogonalRouteScore(left) - orthogonalRouteScore(right));
  const bentRoutes = clearRoutes.filter((points) => points.length >= 4);
  return bentRoutes[0] ?? clearRoutes[0] ?? simplifyOrthogonalPoints([
    sourceAnchor,
    sourceLead,
    { x: bounds.right + outer, y: sourceLead.y },
    { x: bounds.right + outer, y: targetLead.y },
    targetLead,
    targetAnchor,
  ]);
}

function investigationEdgePath(points) {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${Math.round(point.x)} ${Math.round(point.y)}`).join(" ");
}

function investigationArrowDefs() {
  const defs = svgNode("defs");
  const marker = svgNode("marker");
  marker.setAttribute("id", "investigation-flow-arrow");
  marker.setAttribute("viewBox", "0 0 8 8");
  marker.setAttribute("refX", "7");
  marker.setAttribute("refY", "4");
  marker.setAttribute("markerWidth", "6");
  marker.setAttribute("markerHeight", "6");
  marker.setAttribute("orient", "auto-start-reverse");
  const arrow = svgNode("path");
  arrow.setAttribute("d", "M 0 0 L 8 4 L 0 8 z");
  arrow.setAttribute("class", "investigation-flow-arrow");
  marker.append(arrow);
  defs.append(marker);
  return defs;
}

function drawInvestigationEdges() {
  const svg = el["investigation-edges"];
  svg.setAttribute("width", String(el["investigation-canvas"].clientWidth || 1800));
  svg.setAttribute("height", String(el["investigation-canvas"].clientHeight || 1000));
  const children = [investigationArrowDefs()];
  if (state.investigationGraphNodes.length > 0) {
    const graphCards = [...el["investigation-nodes"].children]
      .filter((candidate) => candidate.dataset.entityType === "investigation_node");
    const rects = graphCards
      .map((card) => ({ card, rect: investigationEdgeRect(card) }))
      .filter((entry) => entry.rect);
    state.investigationItemLinks.forEach((link) => {
      const itemElement = [...el["investigation-nodes"].querySelectorAll("[data-investigation-item-id]")]
        .find((candidate) => candidate.dataset.investigationItemId === link.fromItemId);
      const sourceCard = itemElement?.closest("[data-entity-type='investigation_node']");
      const targetCard = [...el["investigation-nodes"].children]
        .find((candidate) => candidate.dataset.entityType === "investigation_node" && candidate.dataset.entityId === link.toNodeId);
      if (!itemElement || !sourceCard || !targetCard) return;
      const source = state.displayPositions.get(boardNodeKey("investigation_node", sourceCard.dataset.entityId));
      const target = state.displayPositions.get(boardNodeKey("investigation_node", link.toNodeId));
      if (!source || !target) return;
      const sourceRect = investigationEdgeRect(sourceCard);
      const targetRect = investigationEdgeRect(targetCard);
      if (!sourceRect || !targetRect) return;
      const itemY = source.y + itemElement.offsetTop + itemElement.offsetHeight / 2;
      const sourceAnchor = investigationEdgeAnchor(sourceRect, targetRect, itemY);
      const targetAnchor = investigationEdgeAnchor(targetRect, sourceRect);
      const obstacles = rects
        .filter(({ card }) => card !== sourceCard && card !== targetCard)
        .map(({ card }) => investigationEdgeRect(card, 12))
        .filter(Boolean);
      const points = routeInvestigationEdge(sourceAnchor, targetAnchor, obstacles, rects.map(({ rect }) => rect));
      const path = svgNode("path");
      path.setAttribute("d", investigationEdgePath(points));
      path.setAttribute("class", "investigation-edge-line investigation-flow-line");
      path.setAttribute("marker-end", "url(#investigation-flow-arrow)");
      children.push(path);
    });
    svg.replaceChildren(...children);
    return;
  }
  state.projectRelations.forEach((relation) => {
    const from = state.displayPositions.get(boardNodeKey(relation.fromType, relation.fromId));
    const to = state.displayPositions.get(boardNodeKey(relation.toType, relation.toId));
    if (!from || !to) return;
    const x1 = from.x + 115;
    const y1 = from.y + 58;
    const x2 = to.x + 115;
    const y2 = to.y + 58;
    const line = svgNode("line");
    line.setAttribute("x1", String(x1));
    line.setAttribute("y1", String(y1));
    line.setAttribute("x2", String(x2));
    line.setAttribute("y2", String(y2));
    line.setAttribute("class", "investigation-edge-line");
    children.push(line);
  });
  svg.replaceChildren(...children);
}

async function persistInvestigationPosition(entityType, entityId, position) {
  if (!state.projectId) return null;
  try {
    const { position: saved } = await api(
      `/projects/${encodeURIComponent(state.projectId)}/investigation/positions/${entityType}/${encodeURIComponent(entityId)}`,
      { method: "PUT", actor: true, body: position },
    );
    state.boardPositions.set(boardNodeKey(entityType, entityId), saved);
    return saved;
  } catch (error) {
    fail(error);
    await loadBoard();
    return null;
  }
}

function clearInvestigationBoard() {
  state.selectedInvestigationNodeId = null;
  state.displayPositions.clear();
  el["investigation-groups"].replaceChildren();
  el["investigation-nodes"].replaceChildren();
  el["investigation-edges"].replaceChildren();
  renderInvestigationInspector();
}

function boardNodeKey(entityType, entityId) {
  return `${entityType}:${entityId}`;
}

function svgNode(tag) {
  return document.createElementNS("http://www.w3.org/2000/svg", tag);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function taskStatusIcon(status) {
  const glyph = {
    inbox: "↓",
    planned: "◇",
    ready: "▶",
    in_progress: "↻",
    blocked: "!",
    review: "⌕",
    done: "✓",
  }[status] || "?";
  const icon = node("span", `task-status-icon task-status-icon-${status}`, glyph);
  const label = labelForStatus(status);
  icon.title = label;
  icon.setAttribute("role", "img");
  icon.setAttribute("aria-label", label);
  return icon;
}

function renderTaskCard(task) {
  const card = node("article", "task-card");
  card.tabIndex = 0;
  card.draggable = true;
  card.dataset.taskId = task.id;
  const title = node("h3", "task-title", task.title);
  card.append(title);
  if (task.status === "done" && !state.seenDoneTaskIds.has(task.id)) {
    card.classList.add("task-card-unseen-done");
    card.append(node("span", "task-new-done", "New"));
  }
  card.append(taskStatusIcon(task.status));
  card.addEventListener("click", () => void openTask(task.id));
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      void openTask(task.id);
    }
  });
  card.addEventListener("dragstart", (event) => {
    event.dataTransfer?.setData("text/questboard-task", task.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    card.classList.add("dragging");
  });
  card.addEventListener("dragend", () => card.classList.remove("dragging"));
  return card;
}


async function moveTask(taskId, status) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task || task.status === status) return;
  try {
    await api(`/tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      body: { status },
      actor: true,
    });
    await loadBoard();
    toast(`Moved to ${labelForStatus(status)}`);
  } catch (error) {
    fail(error);
  }
}

async function openTask(taskId) {
  state.selectedTaskId = taskId;
  try {
    const [{ task }, { claim }, { activities }, { artifacts }, { relations }, { codeScopeBindings }] = await Promise.all([
      api(`/tasks/${encodeURIComponent(taskId)}`),
      api(`/tasks/${encodeURIComponent(taskId)}/claim`),
      api(`/tasks/${encodeURIComponent(taskId)}/activity`),
      api(`/tasks/${encodeURIComponent(taskId)}/artifacts`),
      api(`/tasks/${encodeURIComponent(taskId)}/relations`),
      api(`/projects/${encodeURIComponent(state.projectId)}/code-scope-bindings`),
    ]);
    state.claims.set(taskId, claim);
    state.activities = activities;
    state.artifacts = artifacts;
    state.relations = relations;
    renderDrawer(task, claim, artifacts, relations, codeScopeBindings || []);
    el["task-drawer"].classList.add("open");
    el["task-drawer"].setAttribute("aria-hidden", "false");
    el["drawer-scrim"].classList.remove("hidden");
    renderBoard();
  } catch (error) {
    fail(error);
  }
}

function renderDrawer(task, claim, artifacts, relations, codeScopeBindings = []) {
  el["drawer-status"].textContent = `${labelForStatus(task.status)} · ${task.priority}`;
  el["drawer-title"].textContent = task.title;
  const body = document.createDocumentFragment();

  const continuitySection = node("section", "detail-section continuity-section");
  continuitySection.append(node("h3", "section-title continuity-title", "Current"));
  const continuityGrid = node("div", "continuity-grid");
  const currentItem = (label, value, className = "") => {
    const item = node("div", `continuity-item ${className}`.trim());
    item.append(node("span", "continuity-label", label), node("p", "continuity-value", value));
    return item;
  };
  continuityGrid.append(
    currentItem("Goal", task.goal, "continuity-goal"),
    currentItem("Now", task.now, "continuity-now"),
    currentItem("Next", task.next, "continuity-next"),
  );
  if (task.blocked) continuityGrid.append(currentItem("Blocked", task.blocked, "continuity-blocked"));
  if (task.guardrail) continuityGrid.append(currentItem("Guardrail", task.guardrail, "continuity-guardrail"));
  continuitySection.append(continuityGrid);

  const checkpointDetails = document.createElement("details");
  checkpointDetails.className = "checkpoint-details";
  checkpointDetails.append(node("summary", "checkpoint-details-summary", "Checkpoint"));
  const checkpointForm = node("form", "checkpoint-form");
  const checkpointField = (label, value, placeholder) => {
    const wrapper = node("label", "checkpoint-field");
    wrapper.append(node("span", "checkpoint-label", label));
    const input = document.createElement("textarea");
    input.rows = 2;
    input.value = value ?? "";
    input.placeholder = placeholder;
    wrapper.append(input);
    return { wrapper, input };
  };
  const nowField = checkpointField("Now", task.now, "What is true right now?");
  const nextField = checkpointField("Next", task.next, "What should the next session do?");
  nowField.input.required = true;
  nextField.input.required = true;
  checkpointForm.append(nowField.wrapper, nextField.wrapper);

  let blockedField = null;
  let clearBlocked = null;
  if (task.status === "blocked") {
    blockedField = checkpointField("Blocked (optional)", task.blocked ?? "", "Describe the current blocker");
    checkpointForm.append(blockedField.wrapper);
    if (task.blocked) {
      const clearLabel = node("label", "checkpoint-clear");
      clearBlocked = document.createElement("input");
      clearBlocked.type = "checkbox";
      clearLabel.append(clearBlocked, text(" Clear existing blocker detail"));
      checkpointForm.append(clearLabel);
    }
  }

  const guardrailField = checkpointField("Guardrail (optional)", task.guardrail ?? "", "Constraint worth carrying forward");
  checkpointForm.append(guardrailField.wrapper);
  let clearGuardrail = null;
  if (task.guardrail) {
    const clearLabel = node("label", "checkpoint-clear");
    clearGuardrail = document.createElement("input");
    clearGuardrail.type = "checkbox";
    clearLabel.append(clearGuardrail, text(" Clear existing guardrail"));
    checkpointForm.append(clearLabel);
  }

  const noteField = checkpointField("Checkpoint note (optional)", "", "Only a meaningful decision, verification, blocker change, or handoff");
  checkpointForm.append(noteField.wrapper);
  const checkpointButton = node("button", "button primary full", "Save checkpoint");
  checkpointButton.type = "submit";
  checkpointForm.append(checkpointButton);
  checkpointForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const payload = {
      now: nowField.input.value.trim(),
      next: nextField.input.value.trim(),
    };
    if (blockedField) {
      const blockedValue = blockedField.input.value.trim();
      if (clearBlocked?.checked) payload.blocked = null;
      else if (blockedValue && blockedValue !== (task.blocked ?? "")) payload.blocked = blockedValue;
    }
    const guardrailValue = guardrailField.input.value.trim();
    if (clearGuardrail?.checked) payload.guardrail = null;
    else if (guardrailValue && guardrailValue !== (task.guardrail ?? "")) payload.guardrail = guardrailValue;
    const checkpointNote = noteField.input.value.trim();
    if (checkpointNote) payload.activity = { type: "note_added", summary: checkpointNote };
    void saveCheckpoint(task.id, payload);
  });
  checkpointDetails.append(checkpointForm);
  continuitySection.append(checkpointDetails);
  continuitySection.append(renderTaskCodeScopeSection(task, codeScopeBindings));

  const summary = node("section", "detail-section");
  summary.append(node("p", "detail-description", task.description || "No description yet."));
  const tagRow = node("div", "tag-row");
  task.tags.forEach((tag) => tagRow.append(node("span", "tag", `#${tag}`)));
  summary.append(tagRow);
  const edit = node("button", "button ghost full", "Edit task");
  edit.type = "button";
  edit.addEventListener("click", () => openTaskDialog(task));
  summary.append(edit);

  const claimSection = node("section", "detail-section");
  claimSection.append(node("h3", "section-title", "Claim"));
  if (claim) {
    claimSection.append(node("div", "claim-card", `Claimed by ${claim.agentId}`));
    const release = node("button", "button danger full", "Release claim");
    release.type = "button";
    release.disabled = claim.agentId !== state.actor.id;
    release.title = release.disabled ? `Only ${claim.agentId} can release this claim` : "";
    release.addEventListener("click", () => void mutateClaim(task.id, "release"));
    claimSection.append(release);
  } else {
    claimSection.append(node("div", "claim-card free", "Unclaimed · available"));
    const claimButton = node("button", "button primary full", "Claim as current actor");
    claimButton.type = "button";
    claimButton.addEventListener("click", () => void mutateClaim(task.id, "claim"));
    claimSection.append(claimButton);
  }

  const evidenceSection = node("section", "detail-section");
  evidenceSection.append(node("h3", "section-title", "Evidence"));
  const artifactList = node("div", "evidence-list");
  artifacts.forEach((artifact) => {
    const card = node("div", "evidence-card");
    const head = node("div", "evidence-head");
    head.append(
      node("span", "evidence-type", artifact.type),
      node("strong", "evidence-title", artifact.title),
    );
    const locator = artifactLocatorNode(artifact.locator);
    if (artifact.description) {
      card.append(head, locator, node("p", "evidence-description", artifact.description));
    } else {
      card.append(head, locator);
    }
    card.append(node("span", "evidence-id", `artifact:${artifact.id}`));
    artifactList.append(card);
  });
  if (artifacts.length === 0) artifactList.append(node("div", "muted", "No evidence attached yet."));
  evidenceSection.append(artifactList);

  const artifactForm = node("form", "evidence-form");
  const artifactGrid = node("div", "evidence-form-grid");
  const artifactType = document.createElement("select");
  artifactType.replaceChildren(...ARTIFACT_TYPES.map((value) => option(value, capitalize(value))));
  const artifactTitle = document.createElement("input");
  artifactTitle.placeholder = "Evidence title";
  artifactTitle.required = true;
  const artifactLocator = document.createElement("input");
  artifactLocator.placeholder = "Path, URL, commit, operation ref…";
  artifactLocator.required = true;
  const artifactDescription = document.createElement("textarea");
  artifactDescription.rows = 2;
  artifactDescription.placeholder = "Optional context";
  artifactGrid.append(artifactType, artifactTitle, artifactLocator, artifactDescription);
  const artifactButton = node("button", "button compact", "Attach evidence");
  artifactButton.type = "submit";
  artifactForm.append(artifactGrid, artifactButton);
  artifactForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void addArtifact(task.id, {
      type: artifactType.value,
      title: artifactTitle.value,
      locator: artifactLocator.value,
      description: artifactDescription.value,
    });
  });
  evidenceSection.append(artifactForm);

  const relationBlock = node("div", "relation-block");
  relationBlock.append(node("h4", "subsection-title", "Relations"));
  const relationList = node("div", "relation-list");
  relations.forEach((relation) => {
    const item = node("div", "relation-item");
    item.append(
      node("span", "relation-kind", relation.kind),
      node("span", "relation-route", `${relation.fromType}:${shortId(relation.fromId)} → ${relation.toType}:${shortId(relation.toId)}`),
    );
    if (relation.label) item.append(node("span", "relation-label", relation.label));
    relationList.append(item);
  });
  if (relations.length === 0) relationList.append(node("div", "muted", "No relations yet."));
  relationBlock.append(relationList);

  const relationForm = node("form", "relation-form");
  const targetType = document.createElement("select");
  targetType.append(option("task", "Task"), option("artifact", "Artifact"));
  const targetId = document.createElement("input");
  targetId.placeholder = "Target ID";
  targetId.required = true;
  const kind = document.createElement("input");
  kind.placeholder = "Relation kind";
  kind.value = "related";
  kind.required = true;
  const label = document.createElement("input");
  label.placeholder = "Optional label";
  const relationButton = node("button", "button compact", "Add relation");
  relationButton.type = "submit";
  relationForm.append(targetType, targetId, kind, label, relationButton);
  relationForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void addRelation(task.id, {
      toType: targetType.value,
      toId: targetId.value,
      kind: kind.value,
      label: label.value,
    });
  });
  relationBlock.append(relationForm);
  evidenceSection.append(relationBlock);

  const activitySection = node("section", "detail-section");
  activitySection.append(node("h3", "section-title", "Activity"));
  const activityList = node("div", "activity-list");
  [...state.activities].reverse().forEach((activity) => {
    const item = node("div", "activity-item");
    const marker = node("span", `activity-marker activity-${activity.type}`);
    const copy = node("div", "activity-copy");
    copy.append(
      node("strong", "activity-summary", activity.summary),
      node("span", "activity-meta", `${shortActor(activity.actorId)} · ${formatTime(activity.createdAt)}`),
    );
    item.append(marker, copy);
    activityList.append(item);
  });
  if (state.activities.length === 0) activityList.append(node("div", "muted", "No activity yet."));
  activitySection.append(activityList);

  const noteForm = node("form", "note-form");
  const note = document.createElement("textarea");
  note.rows = 2;
  note.placeholder = "Add a note to the quest log…";
  note.required = true;
  const noteButton = node("button", "button compact", "Add note");
  noteButton.type = "submit";
  noteForm.append(note, noteButton);
  noteForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void addNote(task.id, note.value);
  });
  activitySection.append(noteForm);

  const details = document.createElement("details");
  details.className = "drawer-details";
  details.append(node("summary", "drawer-details-summary", "Details & tools"));
  const detailsContent = node("div", "drawer-details-content");
  detailsContent.append(summary, claimSection, evidenceSection, activitySection);
  details.append(detailsContent);
  body.append(continuitySection, renderFlowWorkGroupMembershipSection("task", task.id), renderWorkGroupSection(task), details);
  el["drawer-body"].replaceChildren(body);
}

function renderTaskCodeScopeSection(task, bindings) {
  const section = node("section", "task-code-scope-section");
  const head = node("div", "task-code-scope-head");
  head.append(node("h3", "section-title", "Code scopes"));
  const attach = node("button", "button ghost compact", "+ Attach");
  attach.type = "button";
  attach.addEventListener("click", () => void attachTaskCodeScope(task));
  head.append(attach);
  section.append(head);
  const descendantIds = new Set(descendantTaskIds(task.id));
  const directBindings = bindings.filter((binding) => binding.taskId === task.id);
  const descendantBindings = isGroupTask(task.id)
    ? bindings.filter((binding) => descendantIds.has(binding.taskId))
    : [];
  const visibleBindings = [...directBindings, ...descendantBindings];
  if (isGroupTask(task.id)) {
    const uniqueScopeCount = new Set(visibleBindings.map((binding) => binding.codeNodeId)).size;
    section.append(node(
      "div",
      "task-code-scope-summary",
      `${uniqueScopeCount} CodeScope${uniqueScopeCount === 1 ? "" : "s"} across this Work Group and ${descendantBindings.length} descendant binding${descendantBindings.length === 1 ? "" : "s"}.`,
    ));
  }
  const list = node("div", "task-code-scope-list");
  visibleBindings.forEach((binding) => {
    const inherited = binding.taskId !== task.id;
    const ownerTask = inherited ? taskById(binding.taskId) : task;
    const row = node("div", `task-code-scope-row ${binding.state}`);
    const copy = node("div", "task-code-scope-copy");
    copy.append(
      node("strong", "task-code-scope-name", binding.codeNode?.name || binding.codeCanonicalIdentity),
      node("span", "task-code-scope-meta", `${inherited ? `${ownerTask?.title || "Descendant Task"} · ` : ""}${binding.kind.replaceAll("_", " ")} · ${binding.state}`),
    );
    const actions = node("div", "task-code-scope-actions");
    const openCode = node("button", "button ghost compact", "Open Code");
    openCode.type = "button";
    openCode.disabled = binding.state !== "active";
    openCode.addEventListener("click", () => void jumpToCodeScope(binding.codeNodeId));
    const relink = node("button", "button ghost compact", "Relink");
    relink.type = "button";
    relink.classList.toggle("hidden", binding.state !== "relinkable" || inherited);
    relink.addEventListener("click", () => void relinkTaskCodeScope(task.id, binding));
    const action = node("button", "button ghost compact", inherited ? "Open Task" : "Detach");
    action.type = "button";
    action.addEventListener("click", () => {
      if (inherited) void openTask(binding.taskId);
      else void detachTaskCodeScope(task.id, binding);
    });
    actions.append(openCode, relink, action);
    row.append(copy, actions);
    list.append(row);
  });
  if (!visibleBindings.length) list.append(node("div", "muted", "No CodeScope attached. This Task remains valid without one."));
  section.append(list);
  return section;
}

async function attachTaskCodeScope(task) {
  if (!state.projectId) return;
  const codeNodeId = window.prompt("Exact Code node ID to attach");
  if (!codeNodeId?.trim()) return;
  const kind = window.prompt("Binding kind: targets, implemented_in, affects, investigates", "targets")?.trim() || "targets";
  try {
    await api(`/projects/${encodeURIComponent(state.projectId)}/code-scope-bindings`, {
      method: "POST",
      actor: true,
      body: { taskId: task.id, codeNodeId: codeNodeId.trim(), kind },
    });
    if (state.viewMode === "code-map") await loadCodeMap();
    await openTask(task.id);
    toast("CodeScope attached");
  } catch (error) {
    fail(error);
  }
}

async function detachTaskCodeScope(taskId, binding) {
  try {
    await api(`/code-scope-bindings/${encodeURIComponent(binding.id)}?expectedRevision=${binding.revision}`, {
      method: "DELETE",
      actor: true,
    });
    if (state.viewMode === "code-map") await loadCodeMap();
    await openTask(taskId);
    toast("CodeScope detached");
  } catch (error) {
    fail(error);
  }
}

async function relinkTaskCodeScope(taskId, binding) {
  try {
    await api(`/code-scope-bindings/${encodeURIComponent(binding.id)}/relink`, {
      method: "POST",
      actor: true,
      body: { expectedRevision: binding.revision },
    });
    if (state.viewMode === "code-map") await loadCodeMap();
    await openTask(taskId);
    toast("CodeScope relinked");
  } catch (error) {
    fail(error);
  }
}

function hierarchyRelationForChild(taskId) {
  for (const relation of state.projectRelations) {
    if (relation.fromType !== "task" || relation.toType !== "task") continue;
    if (relation.kind === "contains" && relation.toId === taskId) {
      return { relation, parentTaskId: relation.fromId };
    }
    if ((relation.kind === "part-of" || relation.kind === "part_of") && relation.fromId === taskId) {
      return { relation, parentTaskId: relation.toId };
    }
  }
  return null;
}

function groupParentCandidates(taskId) {
  const excluded = new Set([taskId, ...descendantTaskIds(taskId)]);
  return state.tasks
    .filter((task) => !excluded.has(task.id))
    .sort((left, right) => {
      const groupDelta = Number(isGroupTask(right.id)) - Number(isGroupTask(left.id));
      return groupDelta || left.title.localeCompare(right.title);
    });
}

function renderWorkGroupSection(task) {
  const section = node("section", "detail-section work-group-section");
  section.append(node("h3", "section-title", "Task hierarchy"));
  const directChildren = hierarchyChildren(task.id);
  const parentBinding = hierarchyRelationForChild(task.id);

  if (directChildren.length > 0) {
    const groupSummary = node("div", "work-group-current");
    const progress = state.taskHierarchy?.progressByTask?.[task.id];
    const copy = progress?.total
      ? `${directChildren.length} direct · ${progress.done}/${progress.total} done`
      : `${directChildren.length} direct task${directChildren.length === 1 ? "" : "s"}`;
    groupSummary.append(node("span", "work-group-label", "This task is a group"), node("strong", "work-group-name", copy));
    const open = node("button", "button ghost compact", "Open group");
    open.type = "button";
    open.addEventListener("click", () => void openTask(task.id));
    groupSummary.append(open);
    section.append(groupSummary);
  }

  if (parentBinding) {
    const parent = taskById(parentBinding.parentTaskId);
    const parentRow = node("div", "work-group-current");
    parentRow.append(
      node("span", "work-group-label", "In group"),
      node("strong", "work-group-name", parent?.title ?? shortId(parentBinding.parentTaskId)),
    );
    const actions = node("div", "work-group-actions");
    const openParent = node("button", "button ghost compact", "Open");
    openParent.type = "button";
    openParent.addEventListener("click", () => void openTask(parentBinding.parentTaskId));
    const remove = node("button", "button ghost compact", "Remove");
    remove.type = "button";
    remove.addEventListener("click", () => void removeTaskFromGroup(task.id, parentBinding.relation.id));
    actions.append(openParent, remove);
    parentRow.append(actions);
    section.append(parentRow);
    return section;
  }

  const candidates = groupParentCandidates(task.id);
  if (candidates.length > 0) {
    const addForm = node("form", "work-group-form");
    const select = document.createElement("select");
    select.required = true;
    select.append(option("", "Choose parent group…"));
    candidates.forEach((candidate) => {
      const suffix = isGroupTask(candidate.id) ? " · Group" : "";
      select.append(option(candidate.id, `${candidate.title}${suffix}`));
    });
    const add = node("button", "button compact", "Add to group");
    add.type = "submit";
    addForm.append(select, add);
    addForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (select.value) void addTaskToGroup(task.id, select.value);
    });
    section.append(addForm);
  }

  const createForm = node("form", "work-group-form create-group-form");
  const title = document.createElement("input");
  title.placeholder = "New group title";
  title.required = true;
  const create = node("button", "button compact", "Create group");
  create.type = "submit";
  createForm.append(title, create);
  createForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void createGroupAroundTask(task.id, title.value);
  });
  section.append(createForm);
  return section;
}

function artifactLocatorNode(locator) {
  try {
    const parsed = new URL(locator);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      const link = node("a", "evidence-locator", locator);
      link.href = parsed.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      return link;
    }
  } catch {
    // Non-URL locators such as paths, commits, and operation refs stay plain text.
  }
  return node("span", "evidence-locator", locator);
}

function shortId(value) {
  if (!value) return "?";
  return value.length > 10 ? `${value.slice(0, 8)}…` : value;
}

async function mutateClaim(taskId, action) {
  try {
    const activeClaim = state.claims.get(taskId);
    const body = action === "release" && activeClaim?.id
      ? { claimId: activeClaim.id }
      : undefined;
    await api(`/tasks/${encodeURIComponent(taskId)}/${action}`, {
      method: "POST",
      actor: true,
      ...(body ? { body } : {}),
    });
    await loadBoard();
    await openTask(taskId);
    toast(action === "claim" ? "Task claimed" : "Claim released");
  } catch (error) {
    fail(error);
  }
}

async function saveCheckpoint(taskId, payload) {
  try {
    const { resume } = await api(`/tasks/${encodeURIComponent(taskId)}/checkpoint`, {
      method: "POST",
      actor: true,
      body: payload,
    });
    await loadBoard();
    await openTask(taskId);
    const current = state.tasks.find((task) => task.id === taskId);
    const refreshedMatchesResume = Boolean(current
      && current.status === resume.status
      && current.goal === resume.goal
      && current.now === resume.now
      && current.next === resume.next
      && (current.blocked ?? null) === (resume.blocked ?? null)
      && (current.guardrail ?? null) === (resume.guardrail ?? null));
    if (!refreshedMatchesResume) {
      throw new Error("Checkpoint UI did not refresh to the saved Resume Capsule");
    }
    toast("Checkpoint saved");
  } catch (error) {
    fail(error);
  }
}


async function addNote(taskId, summary) {
  const trimmed = summary.trim();
  if (!trimmed) return;
  try {
    await api(`/tasks/${encodeURIComponent(taskId)}/activity`, {
      method: "POST",
      actor: true,
      body: { type: "note_added", summary: trimmed },
    });
    await openTask(taskId);
    toast("Note added");
  } catch (error) {
    fail(error);
  }
}

async function addArtifact(taskId, input) {
  const title = input.title.trim();
  const locator = input.locator.trim();
  if (!title || !locator) return;
  try {
    await api(`/tasks/${encodeURIComponent(taskId)}/artifacts`, {
      method: "POST",
      actor: true,
      body: {
        type: input.type,
        title,
        locator,
        description: input.description.trim(),
      },
    });
    await loadBoard();
    await openTask(taskId);
    toast("Evidence attached");
  } catch (error) {
    fail(error);
  }
}

async function addRelation(taskId, input) {
  const toId = input.toId.trim();
  const kind = input.kind.trim();
  if (!toId || !kind) return;
  try {
    await api("/relations", {
      method: "POST",
      actor: true,
      body: {
        fromType: "task",
        fromId: taskId,
        toType: input.toType,
        toId,
        kind,
        label: input.label.trim(),
      },
    });
    await loadBoard();
    await openTask(taskId);
    toast("Relation added");
  } catch (error) {
    fail(error);
  }
}

async function addTaskToGroup(taskId, parentTaskId) {
  if (!taskId || !parentTaskId) return;
  try {
    await api("/relations", {
      method: "POST",
      actor: true,
      body: {
        fromType: "task",
        fromId: parentTaskId,
        toType: "task",
        toId: taskId,
        kind: "contains",
        label: "Work group membership",
      },
    });
    await loadBoard();
    await openTask(taskId);
    toast("Added to group");
  } catch (error) {
    fail(error);
  }
}

async function removeTaskFromGroup(taskId, relationId) {
  if (!relationId) return;
  try {
    await api(`/relations/${encodeURIComponent(relationId)}`, { method: "DELETE", actor: true });
    await loadBoard();
    await openTask(taskId);
    toast("Removed from group");
  } catch (error) {
    fail(error);
  }
}

async function createGroupAroundTask(taskId, title) {
  const trimmed = title.trim();
  if (!trimmed || !state.projectId) return;
  try {
    const { task: group } = await api("/tasks", {
      method: "POST",
      actor: true,
      body: {
        projectId: state.projectId,
        title: trimmed,
        goal: trimmed,
        status: "planned",
        priority: "normal",
        tags: ["group"],
      },
    });
    await api("/relations", {
      method: "POST",
      actor: true,
      body: {
        fromType: "task",
        fromId: group.id,
        toType: "task",
        toId: taskId,
        kind: "contains",
        label: "Work group membership",
      },
    });
    await loadBoard();
    await openTask(group.id);
    toast("Group created");
  } catch (error) {
    fail(error);
  }
}

function closeDrawer() {
  const selectedTask = state.tasks.find((task) => task.id === state.selectedTaskId);
  if (selectedTask?.status === "done") markDoneTaskSeen(selectedTask.id);
  state.selectedTaskId = null;
  el["task-drawer"].classList.remove("open");
  el["task-drawer"].setAttribute("aria-hidden", "true");
  el["drawer-scrim"].classList.add("hidden");
  if (selectedTask?.status === "done" && state.viewMode === "quest") renderBoard();
}

function openTaskDialog(task = null) {
  if (!state.projectId) {
    toast("Create a project first", true);
    return;
  }
  el["task-dialog-title"].textContent = task ? "Edit task" : "New task";
  el["task-id"].value = task?.id ?? "";
  el["task-title"].value = task?.title ?? "";
  el["task-description"].value = task?.description ?? "";
  el["task-goal"].value = task?.goal ?? "";
  el["task-status"].value = task?.status ?? "inbox";
  el["task-priority"].value = task?.priority ?? "normal";
  el["task-tags"].value = task?.tags?.join(", ") ?? "";
  el["task-more"].open = Boolean(task);
  el["task-dialog"].showModal();
  queueMicrotask(() => el["task-title"].focus());
}

async function saveTask(event) {
  event.preventDefault();
  const taskId = el["task-id"].value;
  const body = {
    title: el["task-title"].value,
    description: el["task-description"].value,
    goal: el["task-goal"].value.trim() || undefined,
    status: el["task-status"].value,
    priority: el["task-priority"].value,
    tags: el["task-tags"].value.split(",").map((tag) => tag.trim()).filter(Boolean),
  };
  try {
    if (taskId) {
      await api(`/tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        actor: true,
        body,
      });
    } else {
      await api("/tasks", { method: "POST", actor: true, body: { ...body, projectId: state.projectId } });
    }
    el["task-dialog"].close();
    await loadBoard();
    if (taskId && state.selectedTaskId === taskId) await openTask(taskId);
    toast(taskId ? "Task updated" : "Task created");
  } catch (error) {
    fail(error);
  }
}

function openProjectDialog() {
  el["project-form"].reset();
  el["project-dialog"].showModal();
  queueMicrotask(() => el["project-name"].focus());
}

async function saveProject(event) {
  event.preventDefault();
  try {
    const { project } = await api("/projects", {
      method: "POST",
      actor: true,
      body: {
        name: el["project-name"].value,
        description: el["project-description"].value,
      },
    });
    state.projectId = project.id;
    localStorage.setItem("questboard.projectId", project.id);
    el["project-dialog"].close();
    await loadProjects();
    await loadBoard();
    toast("Project created");
  } catch (error) {
    fail(error);
  }
}

function saveActor() {
  const id = el["actor-id"].value.trim();
  const provider = el["actor-provider"].value.trim();
  if (!id || !provider) {
    toast("Actor ID and provider are required", true);
    return;
  }
  state.actor = { id, provider };
  localStorage.setItem("questboard.actor", JSON.stringify(state.actor));
  renderActor();
  toast("Actor identity saved");
}

function loadActor() {
  try {
    const stored = JSON.parse(localStorage.getItem("questboard.actor") ?? "null");
    if (stored?.id && stored?.provider) return stored;
  } catch {
    // Ignore malformed local preference and restore a neutral human default.
  }
  return { id: "human:local", provider: "human" };
}

function renderActor() {
  el["actor-id"].value = state.actor.id;
  el["actor-provider"].value = state.actor.provider;
}

async function api(path, options = {}) {
  const headers = new Headers({ accept: "application/json" });
  const method = options.method ?? "GET";
  if (options.actor) {
    headers.set("x-questboard-actor-id", state.actor.id);
    headers.set("x-questboard-actor-provider", state.actor.provider);
  }
  if (method !== "GET" && method !== "HEAD") {
    headers.set("x-questboard-request-id", createWebRequestId());
  }
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(path, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message ?? `${response.status} ${response.statusText}`);
    error.payload = payload;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function createWebRequestId() {
  const browserCrypto = globalThis.crypto;
  if (typeof browserCrypto?.randomUUID === "function") {
    return `web:${browserCrypto.randomUUID()}`;
  }

  if (typeof browserCrypto?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    browserCrypto.getRandomValues(bytes);
    const randomHex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `web:${randomHex}`;
  }

  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2);
  return `web:${timestamp}:${randomPart}`;
}

function showBoardLoading(show) {
  el["board-loading"].classList.toggle("hidden", !show);
  if (show) {
    el["board-error"].classList.add("hidden");
    el["project-empty"].classList.add("hidden");
    el["board-empty"].classList.add("hidden");
    el["quest-board"].classList.add("hidden");
    el["investigation-board"].classList.add("hidden");
    el["code-map-board"].classList.add("hidden");
  }
}

function setBusy(busy) {
  state.busy = busy;
  el["refresh-button"].disabled = busy;
  el["refresh-button"].classList.toggle("spinning", busy);
}

function setConnection(label) {
  el["connection-label"].textContent = label;
}

function fail(error) {
  console.error(error);
  setConnection("Local board · attention needed");
  toast(error instanceof Error ? error.message : String(error), true);
}

let toastTimer;
function toast(message, isError = false) {
  clearTimeout(toastTimer);
  el.toast.textContent = message;
  el.toast.classList.toggle("error", isError);
  el.toast.classList.remove("hidden");
  toastTimer = setTimeout(() => el.toast.classList.add("hidden"), 3200);
}

function option(value, label) {
  const element = document.createElement("option");
  element.value = value;
  element.textContent = label;
  return element;
}

function node(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
}

function text(value) {
  return document.createTextNode(value);
}

function labelForStatus(status) {
  return STATUSES.find(([value]) => value === status)?.[1] ?? status;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function shortActor(actorId) {
  const parts = actorId.split(":");
  return parts.at(-1) || actorId;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
}