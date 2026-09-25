# QuestBoard

A local-first shared work board for humans and multiple AI agents.

QuestBoard combines a guild-style quest board with an investigation/evidence board. Humans and agents can share Task status, Claims, Activity, Artifacts, Relations, and handoffs without putting any one agent vendor into the core domain.

## Project status

QuestBoard is a **pre-release MVP**. The current repository includes:

- an agent-neutral TypeScript domain and application service;
- SQLite persistence using Node's built-in `node:sqlite`;
- a localhost HTTP API and dependency-free Web UI;
- Quest/Kanban and Investigation Board views;
- a JSON-oriented CLI;
- a dependency-free MCP stdio adapter;
- Task, Claim, Activity, Artifact, Relation, and board-position persistence;
- internal optimistic concurrency, idempotent mutation receipts, stale-Claim release protection, and concurrency diagnostics;
- multi-worker race tests.

The main remaining product work includes external cross-agent E2E and richer search/filter/Investigation tooling. Agent onboarding guidance is now documented in [`docs/AGENT-ONBOARDING.md`](docs/AGENT-ONBOARDING.md). See [`docs/QUESTBOARD-PROJECT-PLAN.ko.md`](docs/QUESTBOARD-PROJECT-PLAN.ko.md) for the wider roadmap.

## Requirements

- Node.js **24 or newer**
- npm
- macOS, Linux, or another platform supported by Node 24 and `node:sqlite`
- Tailscale only if you want Tailnet-only access from another device

QuestBoard currently has **zero runtime npm dependencies**. TypeScript and Node type definitions are development dependencies.

## Install

```bash
git clone <repo-url> QuestBoard
cd QuestBoard
npm ci
npm run build
```

For development or before publishing changes, run the complete verification suite:

```bash
npm run verify
```

`npm run verify` runs type checking, Web JavaScript syntax validation, the full test suite, and the dedicated multi-worker race test.

## Quick start: shared daemon + Web/API

Build and start the long-lived daemon. The canonical scripts use Tailnet mode by default:

```bash
npm run build
npm run daemon
```

Open the Tailscale IPv4 address printed by the daemon, for example:

```text
http://100.x.y.z:4317
```

The default database is:

```text
.questboard/questboard.sqlite
```

On first start, that database receives a stable UUID and the daemon pins it to the local QuestBoard identity profile. MCP/CLI clients validate the daemon protocol and pinned database UUID before attaching, so a different QuestBoard database listening on the same endpoint is rejected instead of being used silently.

`npm run daemon` and `npm start` bind specifically to the active Tailscale IPv4 address by default. Use `npm run daemon:local` or `npm run start:local` for localhost-only operation. The Web UI lets you create Projects and Tasks, move Tasks through the seven workflow states, Claim/Release work, add Activity notes, attach evidence Artifacts, create Relations, and switch between Quest and Investigation views.

### Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `QUESTBOARD_DB_PATH` | SQLite database path | `.questboard/questboard.sqlite` |
| `QUESTBOARD_HOST` | HTTP/Web bind host for non-Tailnet/local launches | `127.0.0.1` |
| `QUESTBOARD_PORT` | HTTP/Web port | `4317` |
| `QUESTBOARD_TAILNET` | Set to `1` to force Tailnet binding when launching the entry point directly | unset |
| `QUESTBOARD_DAEMON_URL` | MCP/CLI daemon endpoint | active Tailscale IPv4 when available, otherwise `127.0.0.1` |
| `QUESTBOARD_IDENTITY_PATH` | Daemon/DB identity profile shared by daemon and local MCP/CLI clients | `~/.local/state/questboard/daemon-identity.json` |
| `QUESTBOARD_ACTOR_ID` | Default CLI actor ID | `cli:local` |
| `QUESTBOARD_ACTOR_PROVIDER` | Default CLI actor provider | `cli` |
| `QUESTBOARD_CONCURRENCY_LOG` | Set to `0` to disable concurrency JSONL diagnostics | enabled |
| `QUESTBOARD_CODE_MAP` | Set to `1` or `true` to enable Code Map indexing | disabled |
| `QUESTBOARD_CODE_MAP_PROVIDER` | Code intelligence provider: `scip-typescript` or optional `gitnexus` | `scip-typescript` |
| `QUESTBOARD_CODE_MAP_STORAGE_ROOT` | External Code Map index/cache directory | `~/.local/share/questboard/code-map` |
| `QUESTBOARD_SCIP_TYPESCRIPT_EXECUTABLE` | `scip-typescript` executable path/name | `scip-typescript` |
| `QUESTBOARD_SCIP_EXECUTABLE` | `scip` CLI executable path/name | `scip` |
| `QUESTBOARD_GITNEXUS_EXECUTABLE` | Optional GitNexus executable path/name | `gitnexus` |

### Code Map provider setup

Code Map is opt-in, but when enabled its default provider is **SCIP TypeScript**. QuestBoard does not bundle the SCIP executables and keeps its zero-runtime-npm-dependency foundation. Install the `scip-typescript` indexer and `scip` CLI separately, make both visible on the daemon's `PATH`, or point QuestBoard at them with `QUESTBOARD_SCIP_TYPESCRIPT_EXECUTABLE` and `QUESTBOARD_SCIP_EXECUTABLE`.

If the configured executables are missing, QuestBoard still starts normally: Task, Investigation, MCP, CLI, and Web functionality stay available while Code Map reports a fail-closed `unavailable` state with a setup hint. Generated Code Map indexes live outside the repository under `QUESTBOARD_CODE_MAP_STORAGE_ROOT`.

GitNexus remains available as an explicit optional compatibility and regression-comparison provider by setting `QUESTBOARD_CODE_MAP_PROVIDER=gitnexus` and making `gitnexus` available on `PATH` (or configuring `QUESTBOARD_GITNEXUS_EXECUTABLE`). It is not required for the default Code Map flow.
Older GitNexus PoC measurements are retained as historical comparison evidence, while current operational setup and default-provider behavior follow this section and use SCIP TypeScript unless `gitnexus` is selected explicitly.

For access from another device on the same LAN, bind to the host machine's private LAN address:

```bash
QUESTBOARD_HOST=192.168.0.20 npm run daemon:local
```

Then open `http://192.168.0.20:4317` from the other device. `QUESTBOARD_HOST=0.0.0.0` also works, but it listens on every IPv4 interface and is broader than necessary. See [`docs/NETWORK-ACCESS.md`](docs/NETWORK-ACCESS.md) for LAN, firewall, C2CT-managed MCP, Tailnet, and public-Internet guidance.

Tailnet-only access is already the default. The explicit alias remains available:

```bash
npm run start:tailnet
```

QuestBoard selects an active Tailscale IPv4 address in `100.64.0.0/10` and binds specifically to that address. Tailnet mode takes precedence over `QUESTBOARD_HOST`. This is private-network reachability, **not authentication**.

## Concurrency model: lockless outside, strict inside

QuestBoard intentionally keeps concurrency plumbing out of the normal user/agent workflow.

- **Normal Task updates do not require a lock token or revision token.** Omit `expectedRevision` in HTTP/MCP and omit `--revision` in CLI.
- Internally, Task writes use revision-based compare-and-set. If another writer wins first, QuestBoard rereads the latest Task and retries the patch with bounded internal retries.
- `expectedRevision` remains available as an **optional strict-CAS mode** when a caller explicitly wants a stale read to fail with `revision_conflict`.
- Claims are **coordination signals**, not mutation locks or permissions. A claimed Task can still be updated by another authorized client.
- Every Claim has an opaque `claimId`. Release calls should send the Claim ID they observed when available so a stale release cannot accidentally release a newer re-Claim.
- Mutations can carry a `requestId`. QuestBoard stores a mutation receipt in the same SQLite transaction so an exact retry returns the original result instead of applying the side effect twice. Reusing one request ID for different input returns `request_conflict`.

For lockless concurrent updates, both callers can succeed. If both change the same field, the later successful update is the final value. Callers that require compare-and-set semantics should use `expectedRevision` explicitly.

### Request IDs by adapter

- **Web:** generates a request ID for every mutation.
- **CLI:** generates one automatically. Use `--request-id ID` only when replaying/debugging an exact request across invocations.
- **MCP:** generates one automatically for mutating tool calls. For retry safety across an MCP process restart, supply your own stable `requestId`.
- **HTTP:** custom clients should send `x-questboard-request-id` or `Idempotency-Key` and reuse the same value only when retrying the exact same mutation.

Request IDs must be 8-128 characters and use letters, numbers, `.`, `_`, `:`, or `-`.

## Actor identity

Mutations are attributed to a neutral actor. Actor metadata is used for Activity and Claim attribution and has **no authorization meaning**.

HTTP mutations require:

```text
x-questboard-actor-id: agent:example
x-questboard-actor-provider: my-agent
```

Do not treat these headers as authentication credentials.

## CLI

Build first, then point the CLI at the same SQLite database used by the Web/API server.

```bash
npm run build
npm run cli -- projects
npm run cli -- tasks --status ready
npm run cli -- create-task --project PROJECT_ID --title "Investigate issue" --status ready
npm run cli -- update-task TASK_ID --status in_progress
npm run cli -- claim TASK_ID --actor-id agent:worker-1 --actor-provider local-agent
npm run cli -- claim-status TASK_ID
npm run cli -- add-activity TASK_ID --type agent_handoff --summary "Implementation complete"
npm run cli -- add-artifact TASK_ID --type log --title "Test log" --locator logs/test.log
npm run cli -- add-relation --from-type task --from TASK_ID --to-type artifact --to ARTIFACT_ID --kind evidence_for
npm run cli -- release TASK_ID --claim-id CLAIM_ID --actor-id agent:worker-1 --actor-provider local-agent
```

Use `--revision N` on `update-task` only when you intentionally want strict stale-write rejection. Override the default CLI actor with `QUESTBOARD_ACTOR_ID` / `QUESTBOARD_ACTOR_PROVIDER` or per-command `--actor-id` / `--actor-provider`.

Run `npm run cli -- help` for the command summary.

## MCP

QuestBoard uses one long-lived local daemon and lightweight per-session clients. The daemon is the only normal runtime process that opens SQLite and owns `QuestBoardService`; it also serves the Web UI/API. MCP clients may still launch one stdio process per chat/session, but those processes are proxies and do not open the database or bind the Web port. Build and start the daemon first:

```bash
npm run build
npm run daemon
```

By default the daemon/Web endpoint is the machine's active Tailscale IPv4 on port `4317`. MCP/CLI clients auto-discover the same active Tailscale IPv4 when `QUESTBOARD_DAEMON_URL` is unset, with localhost as the fallback when no Tailscale IPv4 exists. An MCP client can then launch the compiled stdio proxy directly:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/QuestBoard/dist/src/adapters/mcp/main.js"],
  "env": {}
}
```

Multiple MCP stdio proxies and the CLI can attach to the same daemon concurrently. Closing an MCP session closes only that proxy; the daemon, Web UI, database connection, and other sessions remain alive. `QUESTBOARD_DB_PATH`, `QUESTBOARD_HOST`, `QUESTBOARD_PORT`, and Tailnet binding configure the daemon. `QUESTBOARD_DAEMON_URL` overrides MCP/CLI endpoint auto-discovery when needed. See [`docs/NETWORK-ACCESS.md`](docs/NETWORK-ACCESS.md) before exposing the daemon beyond the Tailnet.

The adapter exposes:

- `questboard_list_projects`
- `questboard_create_project`
- `questboard_list_tasks`
- `questboard_get_task`
- `questboard_create_task`
- `questboard_update_task`
- `questboard_get_claim`
- `questboard_claim_task`
- `questboard_release_task`
- `questboard_list_activity`
- `questboard_add_activity`
- `questboard_list_artifacts`
- `questboard_get_artifact`
- `questboard_add_artifact`
- `questboard_list_relations`
- `questboard_add_relation`

Mutating tools require a neutral actor object:

```json
{
  "id": "agent:worker-1",
  "provider": "my-agent"
}
```

See [`docs/AGENT-ONBOARDING.md`](docs/AGENT-ONBOARDING.md) for the recommended cross-agent workflow.

## Recommended agent workflow

1. List Projects and Ready/Planned Tasks.
2. Read the Task, current Claim, Activity, Artifacts, and Relations before editing.
3. Claim the Task when useful as a coordination signal.
4. Update status/content without carrying revision plumbing unless strict CAS is intentionally needed.
5. Add notes, evidence, and Relations as work progresses.
6. Write an `agent_handoff` Activity before handing work to another agent.
7. Release using the observed `claimId` when available.

## Diagnostics

QuestBoard emits structured concurrency diagnostics as one JSON object per line on **stderr**. Events include request receipt/replay/conflict, internal Task update retries/conflicts, Claim acquisition/release/conflict, and stale release attempts.

Disable these diagnostics with:

```bash
QUESTBOARD_CONCURRENCY_LOG=0 npm start
```

The diagnostics intentionally avoid logging mutation payload bodies, but they can contain actor IDs, Task IDs, Claim IDs, request IDs, and revisions. Treat logs accordingly if those identifiers are sensitive in your environment.

## Verification

```bash
npm run typecheck
npm run check:web
npm test
npm run test:race
# or all of the above:
npm run verify
```

The dedicated race scenario uses a disposable temporary SQLite database and independent worker-thread database connections. It verifies:

- exactly one winner for simultaneous Claim attempts;
- handoff/release/re-Claim flow;
- strict-CAS stale-write rejection when both writers explicitly use the same revision;
- two simultaneous normal Task updates succeeding without exposing revision tokens, ending at revision 3.

Normal QuestBoard data is never touched by the race test.

## Known pre-release limitations

- External real-client cross-agent E2E is still pending.
- Search/filter and richer Investigation Board navigation are not complete.
- Mutation receipts are currently retained without an automatic pruning policy; long-lived/high-volume installations should monitor DB growth until retention policy is added.
- There is no built-in authentication/authorization layer, backup scheduler, or public-internet deployment mode.

## Repository layout

```text
src/core/                 vendor-neutral domain and errors
src/application/          service boundary and repository port
src/storage/sqlite/       SQLite adapter and migrations
src/server/               HTTP/Web composition and Tailnet binding
src/adapters/             shared agent tools, CLI, and MCP adapters
src/observability/        concurrency diagnostics
src/testing/              dedicated race-test harness
web/                      dependency-free browser UI
tests/                    automated tests
docs/                     architecture, plan, and agent onboarding
```

## Security and exposure

QuestBoard is designed as a local-first coordination service.

- Localhost is the default network boundary.
- Tailnet mode is intended for trusted private Tailscale networks.
- Actor IDs/providers are attribution metadata, not authentication.
- QuestBoard currently has no multi-user authentication/authorization layer.
- **Do not expose the HTTP server directly to the public internet** without adding an appropriate authentication, authorization, and transport-security boundary in front of it.
- Local DB files, logs, environment files, build output, and C2CT scratch data are ignored by Git.

## GitHub/publication notes

This repository intentionally keeps runtime data and local tooling state out of Git through `.gitignore`. Before a public release, choose and add the project license that matches the intended distribution policy. No license is selected in the repository yet.

## Documentation

- [`AGENTS.md`](AGENTS.md): repository rules and quick-start contract for coding agents
- [`docs/AGENT-ONBOARDING.md`](docs/AGENT-ONBOARDING.md): neutral agent connection and handoff guide
- [`docs/architecture/FOUNDATION.md`](docs/architecture/FOUNDATION.md): implementation architecture and invariants
- [`docs/QUESTBOARD-PROJECT-PLAN.ko.md`](docs/QUESTBOARD-PROJECT-PLAN.ko.md): product direction and staged plan
