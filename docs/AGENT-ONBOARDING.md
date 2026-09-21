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
2. **Read context**: fetch the Task, current Claim, Activity, Artifacts, and Relations before changing it.
3. **Coordinate**: Claim the Task when it is useful to tell other participants who is working on it.
4. **Work**: update Task fields/status. Normal updates do not need a revision token.
5. **Leave evidence**: add notes, Artifacts, and Relations for outputs another agent may need.
6. **Handoff**: add an `agent_handoff` Activity with a concise state/result/next-step summary.
7. **Release**: release the Claim using the observed `claimId` when available.

A Claim is a social/coordination signal. It is not a hard lock and does not grant project permissions.

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

## 5. Handoff format

Keep handoffs short and operational. A useful `agent_handoff` summary should answer:

- what was completed;
- what evidence/artifacts were produced;
- what remains;
- any blocker or decision needed;
- the most useful next action.

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

QuestBoard itself does not grant filesystem, shell, repository, or deployment permissions to an agent. Those capabilities remain the responsibility of the agent's own runtime/tooling boundary.

The HTTP server is localhost-only by default. Tailnet mode is private-network reachability, not authentication. Do not expose the server directly to the public internet without a separate authentication/authorization and transport-security layer.

## 8. Before handing back to another agent

Run the closest relevant checks. For repository changes, the default full gate is:

```bash
npm run verify
```

Then leave a handoff Activity and evidence links instead of assuming another client has access to your private transcript or local scratch state.
