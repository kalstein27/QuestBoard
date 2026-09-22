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

const state = {
  projects: [],
  projectId: null,
  viewMode: loadViewMode(),
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
  boardPositions: new Map(),
  displayPositions: new Map(),
  investigationZoom: loadInvestigationZoom(),
  investigationPan: loadInvestigationPan(),
  investigationPointers: new Map(),
  investigationGesture: null,
  investigationUndo: [],
  investigationRedo: [],
  investigationHistoryBusy: false,
  actor: loadActor(),
  busy: false,
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
    "project-select", "new-project-button", "new-task-button", "refresh-button",
    "actor-id", "actor-provider", "save-actor-button", "board-loading", "board-empty",
    "project-empty", "kanban-board", "empty-new-task-button", "empty-new-project-button",
    "investigation-board", "investigation-canvas", "investigation-edges", "investigation-nodes",
    "investigation-controls", "investigation-undo", "investigation-redo", "investigation-zoom-out",
    "investigation-zoom-reset", "investigation-zoom-in", "investigation-add-node",
    "workspace-title", "view-switch",
    "task-drawer", "drawer-status", "drawer-title", "drawer-body", "close-drawer-button",
    "drawer-scrim", "task-dialog", "task-form", "task-dialog-title", "task-id", "task-title",
    "task-description", "task-status", "task-priority", "task-tags", "project-dialog",
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
    void loadBoard();
  });
  el["new-project-button"].addEventListener("click", openProjectDialog);
  el["empty-new-project-button"].addEventListener("click", openProjectDialog);
  el["new-task-button"].addEventListener("click", () => openTaskDialog());
  el["empty-new-task-button"].addEventListener("click", () => openTaskDialog());
  el["refresh-button"].addEventListener("click", () => void refreshAll());
  el["view-switch"].querySelectorAll("[data-board-view]").forEach((button) => {
    button.addEventListener("click", () => setViewMode(button.dataset.boardView));
  });
  el["investigation-undo"].addEventListener("click", () => void undoInvestigationMove());
  el["investigation-redo"].addEventListener("click", () => void redoInvestigationMove());
  el["investigation-zoom-out"].addEventListener("click", () => setInvestigationZoom(state.investigationZoom - 0.15));
  el["investigation-zoom-reset"].addEventListener("click", resetInvestigationViewport);
  el["investigation-zoom-in"].addEventListener("click", () => setInvestigationZoom(state.investigationZoom + 0.15));
  el["investigation-add-node"].addEventListener("click", () => void createInvestigationNodeFromPrompt());
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
    setConnection("Local board · connected");
  } catch (error) {
    fail(error);
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
    state.tasks = [];
    state.claims.clear();
    state.projectArtifacts = [];
    state.projectRelations = [];
    state.investigationGraphNodes = [];
    state.investigationGraphItems = [];
    state.investigationItemLinks = [];
    state.investigationItemTaskLinks = [];
    state.boardPositions.clear();
    state.displayPositions.clear();
    resetInvestigationHistory();
    renderBoard();
    return;
  }
  showBoardLoading(true);
  const { tasks, claims, artifacts, relations, positions, nodes, items, itemLinks, itemTaskLinks } = await api(
    `/projects/${encodeURIComponent(state.projectId)}/investigation/graph`,
  );
  state.tasks = tasks;
  state.projectArtifacts = artifacts;
  state.projectRelations = relations;
  state.investigationGraphNodes = nodes;
  state.investigationGraphItems = items;
  state.investigationItemLinks = itemLinks;
  state.investigationItemTaskLinks = itemTaskLinks;
  state.boardPositions = new Map(positions.map((position) => [boardNodeKey(position.entityType, position.entityId), position]));
  resetInvestigationHistory();
  state.claims = new Map(claims.map((claim) => [claim.taskId, claim]));
  renderBoard();
}

function renderBoard() {
  showBoardLoading(false);
  const noProject = !state.projectId;
  const hasQuestContent = state.tasks.length > 0;
  const hasCurrentContent = state.viewMode === "investigation" ? Boolean(state.projectId) : hasQuestContent;
  el["project-empty"].classList.toggle("hidden", !noProject);
  el["board-empty"].classList.toggle("hidden", noProject || hasCurrentContent);
  el["kanban-board"].classList.toggle("hidden", noProject || !hasQuestContent || state.viewMode !== "quest");
  el["investigation-board"].classList.toggle("hidden", noProject || state.viewMode !== "investigation");
  renderViewSwitch();
  if (noProject || !hasCurrentContent) {
    if (state.viewMode === "quest") el["kanban-board"].replaceChildren();
    else clearInvestigationBoard();
    return;
  }

  if (state.viewMode === "investigation") {
    renderInvestigationBoard();
    return;
  }

  const columns = STATUSES.map(([status, label]) => {
    const column = node("section", "kanban-column");
    column.dataset.status = status;
    const tasks = state.tasks.filter((task) => task.status === status);
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
    return column;
  });
  el["kanban-board"].replaceChildren(...columns);
}

function setViewMode(mode) {
  if (mode !== "quest" && mode !== "investigation") return;
  state.viewMode = mode;
  localStorage.setItem("questboard.viewMode", mode);
  closeDrawer();
  renderBoard();
}

function loadViewMode() {
  return localStorage.getItem("questboard.viewMode") === "investigation" ? "investigation" : "quest";
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

function renderViewSwitch() {
  el["view-switch"].querySelectorAll("[data-board-view]").forEach((button) => {
    const active = button.dataset.boardView === state.viewMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const investigation = state.viewMode === "investigation";
  el["investigation-controls"].classList.toggle("hidden", !investigation);
  el["workspace-title"].textContent = investigation ? "Investigation" : "Quest";
  renderInvestigationControls();
}

function renderInvestigationBoard() {
  const canvas = el["investigation-canvas"];
  const nodesLayer = el["investigation-nodes"];
  const canvasWidth = 1800;
  const graphMode = state.investigationGraphNodes.length > 0;
  const entityCount = graphMode ? state.investigationGraphNodes.length : state.tasks.length + state.projectArtifacts.length;
  const canvasHeight = Math.max(1000, 420 + Math.ceil(entityCount / 4) * 230);
  canvas.style.width = `${canvasWidth}px`;
  canvas.style.height = `${canvasHeight}px`;
  applyInvestigationViewport();
  state.displayPositions = new Map();

  if (graphMode) {
    const graphNodes = state.investigationGraphNodes.map((graphNode, index) => {
      const position = investigationPosition("investigation_node", graphNode.id, index, false);
      const card = investigationGraphNode(graphNode, position);
      state.displayPositions.set(boardNodeKey("investigation_node", graphNode.id), position);
      return card;
    });
    nodesLayer.replaceChildren(...graphNodes);
    requestAnimationFrame(drawInvestigationEdges);
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
  drawInvestigationEdges();
}

function investigationPosition(entityType, entityId, index, artifact) {
  const saved = state.boardPositions.get(boardNodeKey(entityType, entityId));
  if (saved) return { x: saved.x, y: saved.y };
  const column = index % 4;
  const row = Math.floor(index / 4);
  return artifact
    ? { x: 180 + column * 360, y: 570 + row * 170 }
    : { x: 80 + column * 360, y: 90 + row * 180 };
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
  setInvestigationNodePosition(card, position);

  const head = node("div", "investigation-node-head");
  const identity = node("div", "investigation-graph-identity");
  identity.append(node("strong", "investigation-node-title", graphNode.title));
  const edit = node("button", "graph-icon-button", "✎");
  edit.type = "button";
  edit.title = "Edit node";
  edit.addEventListener("click", () => void editInvestigationNodeFromPrompt(graphNode));
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
  return card;
}

function investigationGraphItem(item) {
  const wrapper = node("section", "investigation-item");
  wrapper.dataset.investigationItemId = item.id;
  const head = node("div", "investigation-item-head");
  const title = node("strong", "investigation-item-title", item.title);
  const actions = node("div", "investigation-item-actions");
  const edit = graphActionButton("✎", "Edit item", () => void editInvestigationItemFromPrompt(item));
  const task = graphActionButton("+", "Link or create a Task", () => void addTaskToInvestigationItem(item));
  const connect = graphActionButton("↗", "Connect this item to another Node", () => void connectInvestigationItemToNode(item));
  actions.append(edit, task, connect);
  head.append(title, actions);
  wrapper.append(head);

  const taskLinks = state.investigationItemTaskLinks
    .filter((link) => link.itemId === item.id)
    .sort((a, b) => a.sortOrder - b.sortOrder);
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
      open.addEventListener("click", () => void openTask(linkedTask.id));
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

function graphActionButton(label, title, onClick) {
  const button = node("button", "graph-item-action", label);
  button.type = "button";
  button.title = title;
  button.addEventListener("click", onClick);
  return button;
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
  if (await applyInvestigationHistoryPosition(entry, entry.from)) {
    state.investigationUndo.pop();
    state.investigationRedo.push(entry);
  }
  renderInvestigationControls();
}

async function redoInvestigationMove() {
  if (state.investigationHistoryBusy || state.investigationRedo.length === 0) return;
  const entry = state.investigationRedo[state.investigationRedo.length - 1];
  if (await applyInvestigationHistoryPosition(entry, entry.to)) {
    state.investigationRedo.pop();
    state.investigationUndo.push(entry);
  }
  renderInvestigationControls();
}

async function applyInvestigationHistoryPosition(entry, position) {
  state.investigationHistoryBusy = true;
  renderInvestigationControls();
  const key = boardNodeKey(entry.entityType, entry.entityId);
  state.displayPositions.set(key, { ...position });
  const card = [...el["investigation-nodes"].children].find((candidate) => (
    candidate.dataset.entityType === entry.entityType && candidate.dataset.entityId === entry.entityId
  ));
  if (card) setInvestigationNodePosition(card, position);
  drawInvestigationEdges();
  const saved = await persistInvestigationPosition(entry.entityType, entry.entityId, position);
  state.investigationHistoryBusy = false;
  return Boolean(saved);
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
}

function applyInvestigationViewport() {
  if (!el["investigation-canvas"]) return;
  el["investigation-canvas"].style.transform = `translate3d(${state.investigationPan.x}px, ${state.investigationPan.y}px, 0) scale(${state.investigationZoom})`;
  el["investigation-canvas"].style.transformOrigin = "top left";
  el["investigation-board"].style.backgroundSize = `${24 * state.investigationZoom}px ${24 * state.investigationZoom}px`;
  el["investigation-board"].style.backgroundPosition = `${state.investigationPan.x}px ${state.investigationPan.y}px`;
}

function setInvestigationNodePosition(card, position) {
  card.style.left = `${position.x}px`;
  card.style.top = `${position.y}px`;
}

function drawInvestigationEdges() {
  const svg = el["investigation-edges"];
  svg.setAttribute("width", String(el["investigation-canvas"].clientWidth || 1800));
  svg.setAttribute("height", String(el["investigation-canvas"].clientHeight || 1000));
  const children = [];
  if (state.investigationGraphNodes.length > 0) {
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
      const x1 = source.x + sourceCard.offsetWidth;
      const y1 = source.y + itemElement.offsetTop + itemElement.offsetHeight / 2;
      const x2 = target.x;
      const y2 = target.y + Math.min(targetCard.offsetHeight / 2, 72);
      const line = svgNode("line");
      line.setAttribute("x1", String(x1));
      line.setAttribute("y1", String(y1));
      line.setAttribute("x2", String(x2));
      line.setAttribute("y2", String(y2));
      line.setAttribute("class", "investigation-edge-line investigation-flow-line");
      children.push(line);
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
  state.displayPositions.clear();
  el["investigation-nodes"].replaceChildren();
  el["investigation-edges"].replaceChildren();
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
  card.append(title, taskStatusIcon(task.status));
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
    const [{ task }, { claim }, { activities }, { artifacts }, { relations }] = await Promise.all([
      api(`/tasks/${encodeURIComponent(taskId)}`),
      api(`/tasks/${encodeURIComponent(taskId)}/claim`),
      api(`/tasks/${encodeURIComponent(taskId)}/activity`),
      api(`/tasks/${encodeURIComponent(taskId)}/artifacts`),
      api(`/tasks/${encodeURIComponent(taskId)}/relations`),
    ]);
    state.claims.set(taskId, claim);
    state.activities = activities;
    state.artifacts = artifacts;
    state.relations = relations;
    renderDrawer(task, claim, artifacts, relations);
    el["task-drawer"].classList.add("open");
    el["task-drawer"].setAttribute("aria-hidden", "false");
    el["drawer-scrim"].classList.remove("hidden");
    renderBoard();
  } catch (error) {
    fail(error);
  }
}

function renderDrawer(task, claim, artifacts, relations) {
  el["drawer-status"].textContent = `${labelForStatus(task.status)} · ${task.priority}`;
  el["drawer-title"].textContent = task.title;
  const body = document.createDocumentFragment();

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

  body.append(summary, claimSection, evidenceSection, activitySection);
  el["drawer-body"].replaceChildren(body);
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

function closeDrawer() {
  state.selectedTaskId = null;
  el["task-drawer"].classList.remove("open");
  el["task-drawer"].setAttribute("aria-hidden", "true");
  el["drawer-scrim"].classList.add("hidden");
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
  el["task-status"].value = task?.status ?? "inbox";
  el["task-priority"].value = task?.priority ?? "normal";
  el["task-tags"].value = task?.tags?.join(", ") ?? "";
  el["task-dialog"].showModal();
  queueMicrotask(() => el["task-title"].focus());
}

async function saveTask(event) {
  event.preventDefault();
  const taskId = el["task-id"].value;
  const body = {
    title: el["task-title"].value,
    description: el["task-description"].value,
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
    throw new Error(payload?.error?.message ?? `${response.status} ${response.statusText}`);
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
    el["project-empty"].classList.add("hidden");
    el["board-empty"].classList.add("hidden");
    el["kanban-board"].classList.add("hidden");
    el["investigation-board"].classList.add("hidden");
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