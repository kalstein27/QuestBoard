# QuestBoard foundation decisions

This document records the smallest implementation decisions needed to begin the project. The product direction remains defined by `docs/QUESTBOARD-PROJECT-PLAN.ko.md`.

## Runtime and tooling

- Node.js 24 or newer
- TypeScript in strict mode
- SQLite through Node's built-in `node:sqlite` module
- `node:test` for the initial test suite
- no runtime framework, ORM, HTTP framework, agent SDK, or vendor-specific dependency in the foundation/core layers

The foundation/core runtime continues to use Node built-ins for SQLite, HTTP, streams, readline, and tests. Code Map is an optional adapter capability behind the code-intelligence boundary. Managed installation pins `@sourcegraph/scip-typescript` for the TypeScript SCIP indexer and `google-protobuf` 4.0.3 for secure binary decoding; the adapter installs a narrow compatibility shim for the v3-generated SCIP decoder methods removed by protobuf v4. This keeps the managed-MCP install self-contained without moving provider-specific concepts into the core domain.

The provider-neutral `CodeGraphSnapshot` is the canonical Code Map read model. Human architecture projection remains a derived compatibility lens only: a project is considered indexed when a valid raw graph snapshot exists, even when that lens contains zero nodes. Refresh results therefore report raw `changedCodeNodeIds` independently from compatibility `changedArchitectureNodeIds`, so source changes outside the fixed architecture classifier remain observable.

Code Map also merges a provider-independent repository file inventory into each semantic provider snapshot. Every regular project file outside bounded dependency/generated directories receives a stable `file:<relative-path>` node even when no installed parser understands its language. Provider-native symbol containment is preserved; otherwise only top-level located symbols are attached to their owning file, while SCIP `enclosingSymbol` or conservative enclosing-range evidence supplies symbol-to-symbol `contains` edges. Missing semantic support therefore reduces relation fidelity instead of making source files disappear.

Provider lifecycle is separate from indexing. `CodeMapProviderRegistry` reports configured/installed/available state, executable health, pinned version metadata, per-language discovered/indexed/symbol counts, observed relation kinds, and explicit coverage-gap reasons. The Web-facing HTTP boundary and agent/MCP tools consume the same registry report. A trusted install option is only a declarative request containing its pinned source/version, required permissions, `approvalRequired=true`, and `executionBoundary=external-host`; QuestBoard never shells out to install a package or executable and indexing never triggers installation. The current trusted install manifest is the project-pinned `@sourcegraph/scip-typescript@0.4.0`; languages without a trusted provider remain visible as concrete `no_trusted_provider_available` gaps. After an external approved install changes executable availability, registry reads reflect the new health and a normal full re-index can increase semantic coverage. Existing last-good graph data remains independent of provider availability.

Agents consume the raw graph through one bounded application query contract rather than preloading the project graph. `questboard_query_code_map` and `POST /projects/:projectId/code-map/query` share the same cached `CodeMapService` semantics for node search/exact lookup, containment traversal, relation views (`callers`, `callees`, `references`, `referenced_by`), and bounded neighborhoods. Every query has a hard result limit and traversal depth cap; ambiguous searches return candidates while exact ambiguous identities fail explicitly. The query envelope identifies the current semantic index provider and preserves raw relation confidence/evidence. Per-fact provenance remains a separate graph-fidelity concern rather than being inferred by the query layer.

Manual Code Map wiring is a persistent augmentation overlay, not a provider fact. Each manual relation stores exact endpoint node IDs plus their canonical identities, actor/provider attribution, rationale, timestamps, revision, and `provenance=manual`. Active manual relations are injected only into bounded query evaluation; the cached provider-neutral `CodeGraphSnapshot` remains unchanged. Re-indexing preserves a manual relation only while both exact endpoints retain their stored canonical identities. Missing or identity-changed endpoints remain visible as stale augmentation state and are never fuzzy-relinked. Create/update/delete operations use the normal SQLite transaction, mutation-receipt idempotency, and revision-CAS conventions, and the shared HTTP/MCP agent-tool boundaries call the same augmentation service.

The Web Code surface defaults to a technical source explorer over that same raw snapshot. Repository directories and file nodes form the visible root tree, explicit `contains` facts expand into symbol children, and collapsed branches do not materialize descendant symbol rows into the DOM. Symbol/path/kind/language search and the selected-node inspector use the same bounded `/code-map/query` contract as agents; the inspector resolves exact node identity, hierarchy, relations, source location, and per-fact provider/manual provenance before allowing relation-to-relation navigation. Coverage gaps remain visible, while the architecture projection is retained only as a secondary collapsible compatibility lens and for the existing Flow-sync projection.

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

The SQLite database now contains fourteen primary tables:

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
- `flow_work_groups`: first-class visual/spatial Flow containers with optional parent Group and optional linked canonical Task; their hierarchy is independent of Task hierarchy
- `flow_work_group_memberships`: explicit direct membership from one canonical Task or Investigation Node to one visual Flow Work Group; membership is allowed at any Group depth rather than leaf-only
- `board_positions`: free-layout Task/Artifact/Investigation-Node canvas coordinates, stored separately from workflow revision/history

Task mutations and their Activity rows are written in one SQLite transaction. Claim/release, Artifact attachment, and Relation creation are also paired with their Activity rows transactionally. When a mutation carries a request ID, its result receipt is persisted in the same transaction as the side effect.

The initial Task states are `inbox`, `planned`, `ready`, `in_progress`, `blocked`, `review`, and `done`, matching the project plan. Claims have no TTL in this first slice.

## Local HTTP boundary

The local API uses Node's built-in `node:http` module and calls `QuestBoardService`; the HTTP adapter does not import SQLite. The long-lived daemon composition root is the single normal runtime owner of SQLite and `QuestBoardService`. The canonical npm daemon/start scripts use Tailnet binding by default, while explicit `:local` scripts retain localhost-only operation. Mutation callers provide vendor-neutral actor id/provider headers so Activity and Claim records remain portable across human and agent clients.

Project and Task list/get/update queries are application/repository operations rather than HTTP-specific SQL. Web uses the public HTTP routes, while local CLI/MCP clients use daemon bridge routes that dispatch the same shared agent-tool/MCP handlers inside the daemon. Neither client opens SQLite directly.

The daemon bridge is transport plumbing, not an authentication boundary. Bridge POSTs require the non-simple `x-questboard-daemon-client: 1` header so an unrelated browser origin cannot reach them with a simple cross-origin request; this is a CSRF-style transport guard, not caller authentication. When the daemon HTTP listener is intentionally bound to LAN or Tailnet, those bridge routes still inherit the same trusted-private-network assumption as the rest of the unauthenticated HTTP API.

Daemon discovery is fail-closed against workspace/database mix-ups. SQLite stores a persistent `database_id`; daemon startup pins that ID together with the canonical daemon workspace path and canonical SQLite path to a local identity profile. MCP/CLI health checks require the current daemon protocol plus all three pinned identity values to match before any bridge call is sent. A legacy v1 profile may be upgraded only by a current daemon opening the same database ID, while a healthy-looking endpoint backed by another workspace or SQLite path is refused before bridge calls are sent.

Task concurrency is intentionally hidden from normal callers. The repository still performs revision-based compare-and-set writes, while `QuestBoardService` rereads and retries a normal Task patch when another writer wins first. Callers may optionally provide `expectedRevision` when they explicitly want strict compare-and-set semantics and a stale read to fail instead of retrying.

Mutations can carry an idempotency `requestId`. SQLite stores the operation, actor, input fingerprint, and serialized result in `mutation_receipts`; an exact retry returns the original result and reusing the same ID for different input fails closed. HTTP accepts `x-questboard-request-id` or `Idempotency-Key`; Web, CLI, and MCP adapters generate request IDs automatically for ordinary mutation calls.

## Local Web Quest Board

The first Web adapter is deliberately framework-free HTML, CSS, and JavaScript served by the same HTTP process. It adds no runtime dependency and talks only to the public HTTP boundary rather than importing core or SQLite modules.

The UI exposes three product surfaces: Quest, Flow, and Code. Quest renders the seven planned Task states as one flat horizontal Kanban board. Flow is a project-work execution map: first-class Investigation Nodes contain multiple described Items, an Item can overlay multiple canonical Tasks, and a directed flow edge originates from a specific Item and targets another Node. Standalone unconnected Nodes remain valid first-class state.

Flow also owns a separate first-class **visual Work Group hierarchy**. A Work Group may contain child Work Groups plus directly assigned canonical Tasks and Investigation Nodes, and those direct members are valid at any hierarchy depth. A parent Group may therefore contain both unclassified/direct Tasks and more specific child Groups at the same time. The Flow Group hierarchy must not be inferred as the canonical Task hierarchy: `linkedTaskId` is optional context, and Task hierarchy may be used as a recommendation or migration seed without forcing visual membership. Group boundaries are presentation/spatial containers rather than graph-routing obstacles. Moving a Group moves its descendant Groups and explicitly grouped Investigation Nodes as one undoable spatial operation while preserving their relative positions; the contained Nodes remain independently movable.

Node and Group dragging persists coordinates through the application/repository boundary without changing Task revision or writing Activity events. The Web adapter keeps a bounded move history so position changes can be undone/redone through that same persistence boundary, and the canvas supports 50–150% zoom with drag deltas normalized back into logical board coordinates. Code remains a distinct code-context surface rather than being folded into either Task hierarchy or Flow visual hierarchy.

Only the fixed assets `/`, `/app.js`, and `/styles.css` are served. The server applies a same-origin Content Security Policy and `nosniff`; Web mutation calls still use the neutral actor id/provider headers. Actor identity in browser local storage is attribution metadata, not authentication.

The canonical composition mode binds the HTTP process specifically to the machine's Tailscale IPv4 address rather than to all LAN interfaces. Explicit `:local` scripts restore localhost-only binding. This is private-network reachability, not an authentication boundary.

## Shared agent-tool boundary

`src/adapters/agent-tools.ts` defines the neutral callable operations shared by non-HTTP agent clients. It delegates all behavior to `QuestBoardService` and contains no persistence access. The current operations cover project create/read, task reads/create/update, current Claim, Claim/Release, Activity reads, `note_added` / `agent_handoff` Activity creation, Artifact reads/attachment, Relation reads/creation, Investigation Graph snapshot/Node/Item/Task-link/flow-link operations, and visual Flow Work Group create/update/delete/membership operations. MCP exposes the same definitions through `tools/list` and dispatches the same executor through `tools/call`.

Mutation inputs carry an explicit neutral actor with `id` and `provider`. These values are attribution metadata used by Claim and Activity; provider names have no privileged meaning in the core. Claims are coordination signals rather than mutation locks, and a Claim does not prevent another client from updating the Task.

## CLI adapter

The CLI is a thin JSON-oriented daemon client over the shared agent-tool boundary. Its executable sends one neutral tool invocation to the daemon, prints JSON, and exits. It does not open SQLite or construct `QuestBoardService`; business validation and Claim semantics execute inside the daemon service/tool boundary.

## MCP adapter

The MCP adapter remains a dependency-free stdio JSON-RPC surface implemented with Node built-ins, but its executable is now a lightweight daemon proxy. Each MCP process owns only stdin/stdout translation plus one random session id; it forwards JSON-RPC envelopes to the daemon and never opens SQLite or binds the Web port. The daemon runs the existing MCP handler against its single `QuestBoardService` instance. Multiple MCP sessions therefore share one database/service process without port collisions, and a proxy exiting does not stop the daemon.

MCP tool errors are returned as tool-level `isError` results with stable neutral error codes. Claims remain cooperative coordination signals; using MCP does not grant filesystem, process, or project-write permission. Automatic mutation request IDs still include the proxy lifetime session id, preserving exact-retry behavior and preventing reused JSON-RPC ids in different MCP sessions from colliding. Callers can provide their own stable request ID when replay must survive an MCP process restart.

## Concurrency diagnostics

The daemon installs the process concurrency diagnostic sink because it owns all service/database mutation work. It writes structured JSONL to stderr for mutation receipt/replay/conflict, Task CAS retry/conflict/apply, and Claim acquire/release/conflict/stale-release events. MCP/CLI proxy processes do not duplicate those service diagnostics. Mutation payload bodies are not logged. Set `QUESTBOARD_CONCURRENCY_LOG=0` on the daemon to disable this stream.

## Boundary deliberately deferred

Agent-specific adapters, authentication/authorization, public internet exposure, first-class Note graph nodes, dedicated canvas pan controls, polished search/filter/navigation, Item reorder, and richer graph editing ergonomics are not part of this slice. Artifact/Relation persistence, first-class Investigation Nodes/Items, Task overlays, Item-origin flow links, internal optimistic concurrency with optional strict CAS, mutation idempotency receipts, legacy-layout compatibility, move undo/redo, and canvas zoom are implemented.
