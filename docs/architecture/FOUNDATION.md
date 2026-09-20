# QuestBoard foundation decisions

This document records the smallest implementation decisions needed to begin the project. The product direction remains defined by `docs/QUESTBOARD-PROJECT-PLAN.ko.md`.

## Runtime and tooling

- Node.js 24 or newer
- TypeScript in strict mode
- SQLite through Node's built-in `node:sqlite` module
- `node:test` for the initial test suite
- no runtime framework, ORM, HTTP framework, agent SDK, or vendor-specific dependency in the foundation

The only initial development dependencies are TypeScript and Node.js type definitions. Using built-in SQLite, HTTP, test, stream, and readline modules keeps the runtime dependency surface at zero while allowing HTTP, Web, CLI, and MCP adapters to evolve independently.

## Dependency direction

```text
Adapters / UI
      ↓
Shared agent-tool boundary (CLI / MCP)
      ↓
Application service
      ↓
Core domain

Storage adapter
      ↓
Application repository port + Core domain
```

The core contains only vendor-neutral concepts. `QuestBoardService` is the application boundary, and `QuestBoardRepository` is the persistence port. SQLite is one adapter for that port. HTTP, CLI, MCP, and Web code must not move vendor-specific concepts into the domain.

## Current schema

The SQLite database now contains twelve primary tables:

- `projects`: human-readable project identity and optional local root metadata
- `tasks`: title, description, status, priority, tags, actor, timestamps, and revision
- `claims`: one current coordination Claim per task with an opaque claim identity; release is explicit and claim history remains in Activity
- `activities`: append-only task history with actor/provider and before/after task revision metadata
- `mutation_receipts`: idempotency receipts keyed by client request ID and mutation fingerprint
- `artifacts`: Task-attached evidence such as files, URLs, commits, screenshots, operation references, and logs
- `relations`: directed, vendor-neutral edges between Task/Artifact endpoints inside one project
- `investigation_nodes`: project-flow/component/topic nodes with title, description, optional kind, and revision
- `investigation_items`: ordered, independently described entries inside an Investigation Node
- `investigation_item_links`: directed flow edges from a specific Item to another Investigation Node
- `investigation_item_tasks`: many-to-many overlay from Investigation Items to canonical QuestBoard Tasks
- `board_positions`: free-layout Task/Artifact/Investigation-Node canvas coordinates, stored separately from workflow revision/history

Task mutations and their Activity rows are written in one SQLite transaction. Claim/release, Artifact attachment, and Relation creation are also paired with their Activity rows transactionally. When a mutation carries a request ID, its result receipt is persisted in the same transaction as the side effect.

The initial Task states are `inbox`, `planned`, `ready`, `in_progress`, `blocked`, `review`, and `done`, matching the project plan. Claims have no TTL in this first slice.

## Local HTTP boundary

The local API uses Node's built-in `node:http` module and calls `QuestBoardService`; the HTTP adapter does not import SQLite. The runnable composition root binds to `127.0.0.1` only by default. Mutation callers provide vendor-neutral actor id/provider headers so Activity and Claim records remain portable across human and agent clients.

Project and Task list/get/update queries are application/repository operations rather than HTTP-specific SQL. This lets CLI and MCP use the same application semantics without going through HTTP.

Task concurrency is intentionally hidden from normal callers. The repository still performs revision-based compare-and-set writes, while `QuestBoardService` rereads and retries a normal Task patch when another writer wins first. Callers may optionally provide `expectedRevision` when they explicitly want strict compare-and-set semantics and a stale read to fail instead of retrying.

Mutations can carry an idempotency `requestId`. SQLite stores the operation, actor, input fingerprint, and serialized result in `mutation_receipts`; an exact retry returns the original result and reusing the same ID for different input fails closed. HTTP accepts `x-questboard-request-id` or `Idempotency-Key`; Web, CLI, and MCP adapters generate request IDs automatically for ordinary mutation calls.

## Local Web Quest Board

The first Web adapter is deliberately framework-free HTML, CSS, and JavaScript served by the same HTTP process. It adds no runtime dependency and talks only to the public HTTP boundary rather than importing core or SQLite modules.

The UI provides two views. Quest Board renders the seven planned Task states as a horizontal Kanban board. Investigation Board is a project-flow execution map: first-class Investigation Nodes contain multiple described Items, an Item can overlay multiple canonical Tasks, and a directed flow edge originates from a specific Item and targets another Node. Standalone unconnected Nodes are valid first-class state. When a project has no first-class Investigation Nodes yet, the existing Task/Artifact free-layout Relation visualization remains as a compatibility view rather than being migrated or deleted automatically. Node dragging persists coordinates through the application/repository boundary without changing Task revision or writing Activity events. The Web adapter keeps a bounded move history so node-position changes can be undone/redone through that same persistence boundary, and the canvas supports 50–150% zoom with drag deltas normalized back into logical board coordinates.

Only the fixed assets `/`, `/app.js`, and `/styles.css` are served. The server applies a same-origin Content Security Policy and `nosniff`; Web mutation calls still use the neutral actor id/provider headers. Actor identity in browser local storage is attribution metadata, not authentication.

For another device on the same Tailnet, the optional `start:tailnet` composition mode binds the HTTP process specifically to the machine's Tailscale IPv4 address rather than to all LAN interfaces. This is private-network reachability, not an authentication boundary.

## Shared agent-tool boundary

`src/adapters/agent-tools.ts` defines the neutral callable operations shared by non-HTTP agent clients. It delegates all behavior to `QuestBoardService` and contains no persistence access. The current operations cover project create/read, task reads/create/update, current Claim, Claim/Release, Activity reads, `note_added` / `agent_handoff` Activity creation, Artifact reads/attachment, Relation reads/creation, and Investigation Graph snapshot/Node/Item/Task-link/flow-link operations. MCP exposes the same definitions through `tools/list` and dispatches the same executor through `tools/call`.

Mutation inputs carry an explicit neutral actor with `id` and `provider`. These values are attribution metadata used by Claim and Activity; provider names have no privileged meaning in the core. Claims are coordination signals rather than mutation locks, and a Claim does not prevent another client from updating the Task.

## CLI adapter

The CLI is a thin JSON-oriented adapter over the shared agent-tool boundary. Its executable composition root opens the configured SQLite repository, creates `QuestBoardService`, invokes one command, prints JSON, and closes the repository. Business validation and Claim semantics remain in the service/tool boundary.

## MCP adapter

The MCP adapter is a dependency-free stdio JSON-RPC adapter implemented with Node built-ins. It exposes the shared `questboard_*` tools through `initialize`, `tools/list`, and `tools/call`, with protocol data written only to stdout. The MCP executable composition root is also the normal full QuestBoard runtime: it starts the local Web/API server in the same process and against the same `QuestBoardService`/SQLite repository, defaulting to `127.0.0.1:4317`. Web/API startup diagnostics are written to stderr so the stdio protocol remains clean. LAN binding is an explicit opt-in through `QUESTBOARD_HOST`; Tailnet binding remains explicit through `QUESTBOARD_TAILNET=1` or `--tailnet` and takes precedence over the custom host.

MCP tool errors are returned as tool-level `isError` results with stable neutral error codes. Claims remain cooperative coordination signals; using MCP does not grant filesystem, process, or project-write permission. The adapter synthesizes an idempotency request ID for ordinary mutating calls, while callers can provide their own stable request ID when replay must survive an MCP process restart.

## Concurrency diagnostics

Executable Web/API, CLI, and MCP composition roots install the process concurrency diagnostic sink. It writes structured JSONL to stderr for mutation receipt/replay/conflict, Task CAS retry/conflict/apply, and Claim acquire/release/conflict/stale-release events. Mutation payload bodies are not logged. Set `QUESTBOARD_CONCURRENCY_LOG=0` to disable this stream.

## Boundary deliberately deferred

Agent-specific adapters, authentication/authorization, public internet exposure, first-class Note graph nodes, dedicated canvas pan controls, polished search/filter/navigation, Item reorder, and richer graph editing ergonomics are not part of this slice. Artifact/Relation persistence, first-class Investigation Nodes/Items, Task overlays, Item-origin flow links, internal optimistic concurrency with optional strict CAS, mutation idempotency receipts, legacy-layout compatibility, move undo/redo, and canvas zoom are implemented.
