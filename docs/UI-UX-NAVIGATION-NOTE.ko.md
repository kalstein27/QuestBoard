# UI/UX 1/4 Navigation / Workspace note

- Sidebar owns persistent workspace navigation: Quest / Investigation / Code Map.
- Topbar owns current context and only the actions relevant to the active workspace.
- Quest: New task.
- Investigation: + Node, while undo/redo/zoom remain canvas-local controls.
- Code Map: Extract / Sync and Index/Re-index.
- Refresh remains global.
- Mobile collapses the workspace navigation into a compact three-column row.
- No domain/API changes are required; existing HTTP mutations and view state are reused.
