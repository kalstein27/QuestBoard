# QuestBoard Agent Onboarding

This guide is intentionally provider-neutral. It describes how an AI agent or automation client should join a QuestBoard workspace without depending on ChatGPT, Claude, Codex, or any other specific runtime.

## 1. Build and start the shared daemon

QuestBoard requires Node.js 24 or newer.

```bash
npm ci
npm run build
```

The QuestBoard daemon is the single normal runtime owner of SQLite and `QuestBoardService`. Its default database is:

```text
.questboard/questboard.sqlite
```

To choose another file, set this on the daemon process:

```bash
export QUESTBOARD_DB_PATH=/absolute/path/to/questboard.sqlite
```

Do not commit the live database to Git.

The database carries a stable UUID. The first daemon started for a local QuestBoard profile pins that UUID together with the daemon's canonical workspace path and canonical SQLite path in `~/.local/state/questboard/daemon-identity.json`. MCP/CLI clients require the health handshake to report the same protocol, database UUID, workspace path, and database path before attaching. A legacy v1 identity profile is upgraded only when the current daemon opens the same database UUID. If you intentionally operate a separate QuestBoard workspace/database, give that profile a separate `QUESTBOARD_IDENTITY_PATH` rather than silently reusing the existing profile.

Start one daemon before launching agent clients:

```bash
npm run daemon
```

By default the canonical daemon script serves Web/API and the client bridge on the machine's active Tailscale IPv4 at port `4317`. Use `npm run daemon:local` for localhost-only operation.

### Managed host service contract

QuestBoard declares its optional persistent service contract in `package.json` under `chatgpt2codex.managedService`. The declaration is repository metadata rather than a core-domain dependency: a generic managed-MCP host may read it to start the long-lived daemon, wait for its bounded health endpoint, and manage update/restart lifecycle without QuestBoard-specific host code.

The declared service launches `dist/src/server/main.js --tailnet --managed-service`. In managed-service mode, an existing pinned daemon identity is authoritative for `workspacePath` and `databasePath`, so running code from a managed installation checkout does not silently create a second SQLite database. If no identity is pinned yet, the normal `QUESTBOARD_DB_PATH` / current-workspace defaults establish the first profile.

Managed-MCP installation is also the Code Map provisioning boundary. The repository declares `@sourcegraph/scip-typescript` as a pinned runtime dependency, so the host's normal dependency installation provisions the SCIP TypeScript indexer automatically. Managed-service mode enables Code Map by default when `QUESTBOARD_CODE_MAP` is unset, and QuestBoard decodes `.scip` indexes in-process with the decoder shipped by that package. A separate global `scip-typescript` install, `scip` CLI install, PATH edit, or post-install feature toggle is therefore unnecessary. Set `QUESTBOARD_CODE_MAP=0` (or another non-enabling value) only when an operator intentionally wants Code Map disabled.

The Tailnet Web/API remains on the normal QuestBoard port (`4317` by default). Managed lifecycle health uses a separate loopback-only endpoint at `http://127.0.0.1:4318/health`, so a host can verify the persistent process without needing to know the machine's current Tailscale IPv4 address. MCP remains a stdio proxy to this daemon and never becomes the authoritative state owner.

## 2. Choose an adapter

### MCP stdio proxy

Each agent session may launch the compiled MCP entry point. It is a lightweight stdio proxy to the already-running daemon and does not open SQLite or own the Web/API listener:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/QuestBoard/dist/src/adapters/mcp/main.js"],
  "env": {}
}
```

Every proxy generates a stable session id for its lifetime, so automatic MCP mutation request IDs stay isolated by session. Closing one proxy does not stop the daemon or any other MCP session.

### CLI

```bash
npm run cli -- tasks --status ready
```

The CLI is also a daemon client. Without `QUESTBOARD_DAEMON_URL`, MCP/CLI clients auto-discover the active Tailscale IPv4 and fall back to localhost only when Tailscale is unavailable. Set `QUESTBOARD_DAEMON_URL` to override that endpoint.

Endpoint discovery does not imply trust: clients compare the daemon's protocol, persistent database UUID, canonical workspace path, and canonical SQLite path with the local pinned profile and fail closed on any mismatch or on an older daemon that does not expose the current identity handshake.

Set a stable neutral actor identity if desired:

```bash
export QUESTBOARD_ACTOR_ID=agent:my-worker
export QUESTBOARD_ACTOR_PROVIDER=my-agent
```

### Daemon / Web/API

`npm run daemon` is the canonical long-lived runtime. `npm start` remains an alias-compatible way to launch the same Web/API + database owner:

```bash
npm run daemon
```

HTTP mutations require attribution headers:

```text
x-questboard-actor-id: agent:my-worker
x-questboard-actor-provider: my-agent
```

Those values are attribution only. They do not authenticate the caller.

## 3. Recommended work loop

1. **Discover**: list Projects and Tasks. Prefer `ready`, `planned`, or explicitly assigned work.
2. **Resume cheaply**: read the Task's current goal/state/next action first. Do not fetch the entire history by default.
3. **Drill down only as needed**: read Claim, Activity, Artifacts, Relations, Investigation, or Code Map only when they are needed to perform or verify the next action. Before source navigation, call `questboard_get_code_map_status` when index freshness/availability is unknown. If a fresh index is needed, call `questboard_refresh_code_map`; it always uses the Project's canonical `rootPath`, never installs providers, and returns immediately with a bounded background-job receipt. While its state is `running`, poll `questboard_get_code_map_refresh_status` at a reasonable cadence rather than replaying refresh; a repeated refresh for the same project reuses the in-flight job. Continue when the receipt reaches `succeeded`; on `failed`, inspect its bounded error and retain the last-good snapshot when available. HTTP clients use `POST /projects/:projectId/code-map/refresh` (202 Accepted) to start/reuse and `GET /projects/:projectId/code-map/refresh` to read the latest receipt; `GET /projects/:projectId/code-map/status` remains the snapshot lifecycle read. Then prefer bounded `questboard_query_code_map` calls: find a node first, then follow containment, callers/callees, references, or a small neighborhood. Do not fetch the full raw graph merely to answer one source question. When language coverage looks incomplete, call `questboard_get_code_map_provider_capabilities` before guessing. It distinguishes missing/degraded/file-only/partial coverage and returns trusted install options when one exists. `questboard_request_code_map_provider_install` only returns an approval-required external-host plan; it never installs anything or triggers indexing. Do not turn that plan into a shell/package install without the user's explicit host approval. When verified runtime evidence exposes a real relation that providers missed, use the manual-relation tools only with exact indexed endpoint IDs and a useful rationale. Manual wiring is an explicit overlay with `provenance=manual`; stale endpoints stay stale after re-indexing instead of being guessed onto a similar symbol.
4. **Coordinate**: Claim the Task when it is useful to tell other participants who is working on it.
5. **Work**: update Task fields/status. Normal updates do not need a revision token.
6. **Checkpoint**: record only meaningful state changes, blockers, decisions, and evidence another session may need.
7. **Handoff**: leave a concise resume state that makes the next action obvious.
8. **Release**: release the Claim using the observed `claimId` when available.

A Claim is a social/coordination signal. It is not a hard lock and does not grant project permissions.

The optimization target is **minimum reads, minimum tokens, correct resume** rather than exhaustive history reconstruction.

## 4. Concurrency contract

QuestBoard's intended external experience is **lockless outside, strict inside**.

### Normal updates

Omit `expectedRevision`. The service:

1. reads the current Task;
2. applies the requested patch;
3. writes with an internal revision compare-and-set;
4. rereads/retries on a concurrent writer, up to a bounded attempt limit.

This keeps revision plumbing out of normal agent prompts and tool calls.

### Strict compare-and-set

If a workflow must guarantee that the Task has not changed since a particular read, pass `expectedRevision`. A mismatch fails with `revision_conflict` instead of retrying.

### Idempotent retries

Mutations may carry `requestId`.

- Replaying the same operation, actor, and input with the same ID returns the stored result without duplicating the side effect.
- Reusing the ID for different input fails with `request_conflict`.
- CLI and MCP generate request IDs automatically for ordinary calls.
- Across an uncertain network/process restart, a client that needs deterministic replay should supply and retain its own request ID.
- HTTP clients may use `x-questboard-request-id` or `Idempotency-Key`.

Never generate a new request ID merely because the response to an already-sent mutation was lost if you intend to retry that exact mutation.

### Claim generation

Each Claim has an opaque `claimId`. If a Task is released and re-Claimed, the new Claim gets a different identity. A release carrying the older `claimId` fails rather than releasing the newer Claim.

## 5. Resume / handoff format

Keep handoffs short and operational. Conceptually, a useful resume capsule answers:

- **Goal**: what this work is trying to achieve;
- **Now**: the current verified state or last meaningful checkpoint;
- **Next**: the most useful next action;
- **Next Task**: only when `Next` has an explicit canonical child pointer, an opaque `nextTaskId` reference that lets the next session jump there without listing Tasks;
- **Blocked**: only when something currently prevents progress;
- **Code**: only the relevant file/symbol/component anchors when code context is needed;
- **Evidence**: only the tests/logs/screenshots/operations needed to trust the current state;
- **Guardrail**: only when a constraint or "do not repeat" fact must survive the handoff.

Do not fill every field mechanically. Leave the smallest capsule that lets the next session act correctly. Activity, Artifacts, Relations, Investigation, and Code Map are drill-down context, not a mandatory pre-read bundle. Task hierarchy membership is canonicalized as `contains` from parent → child for new writes; compatibility reads still accept legacy `part-of` and `part_of` child → parent relations. `nextTaskId` is derived rather than persisted as a second workflow state: when `Next` is explicitly recorded, the parent has a `next-task` relation to exactly one active canonical child in that normalized hierarchy, Resume may expose that child's id; missing, stale, non-child, done, or ambiguous pointers are omitted fail-closed.

Do not put secrets into Activity text or Artifact locators.

## 6. Diagnostics

QuestBoard executable entry points emit structured concurrency JSONL to stderr by default. Useful event families include:

- mutation receipt persisted/replayed/conflict;
- Task update applied/retry/conflict;
- Claim acquired/conflict/released/stale release.

Disable with:

```bash
QUESTBOARD_CONCURRENCY_LOG=0 npm start
```

Logs avoid mutation payload bodies but can include actor, Task, Claim, request IDs, and revision values.

## 7. Security boundary

QuestBoard does not grant generic filesystem, shell, repository-write, or deployment permissions to an agent. Code Map refresh is one narrow read/index capability: a trusted lifecycle caller may ask the configured provider to read the canonical `rootPath` already stored on a Project. The refresh call cannot supply an alternate root path, does not install providers, and returns only bounded lifecycle counts; detailed source navigation remains behind bounded Code Map queries. Treat access to Code Map refresh as read/index access to registered Project roots and do not expose it to untrusted callers.

The HTTP server is localhost-only by default. Tailnet mode is private-network reachability, not authentication. Do not expose the server directly to the public internet without a separate authentication/authorization and transport-security layer.

## 8. Before handing back to another agent

Run the closest relevant checks. For repository changes, the default full gate is:

```bash
npm run verify
```

Then leave a handoff Activity and evidence links instead of assuming another client has access to your private transcript or local scratch state.
