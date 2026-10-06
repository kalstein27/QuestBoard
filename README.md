# QuestBoard

A local-first work-continuity board for humans working with AI agents.

QuestBoard keeps the smallest shared state needed to answer three questions across chat, model, agent, or context boundaries:

- **Goal** — what are we trying to accomplish?
- **Now** — where did the work actually reach?
- **Next** — what is the most useful next action?

The visible UI stays deliberately simple while deeper Activity, Evidence, Flow, and Code context remains available on demand. The core stays agent/vendor-neutral.

QuestBoard deliberately does **not** replace Git/version control, Jira-style planning, Confluence-style long-form documentation, bug trackers, or an IDE. It links only the minimum context needed to keep human-AI implementation work moving.

## Mental model

- **Quest** is the canonical Task surface. It owns durable Goal / Now / Next continuity and workflow state.
- **Flow** is a visual execution map. Its Work Group hierarchy and Investigation graph are intentionally separate from canonical Task hierarchy.
- **Code** is a bounded technical source explorer backed by a provider-neutral Code Map. Raw `code:node:*` identities stay separate from derived architecture-projection `code-map:node:*` identities.
- **Agent Follow** is ephemeral presence, not durable work state. It can show where an agent is working and optionally follow meaningful navigation while user interaction always wins through Pause / Follow / Return controls.

## Project status

QuestBoard is a **pre-release MVP moving toward a v0.1.0 public milestone**. The current repository includes:

- an agent-neutral TypeScript domain and application service;
- SQLite persistence using Node's built-in `node:sqlite`;
- a local/private-network HTTP API and dependency-free Web UI;
- Quest, Flow, Code, and Agent Follow surfaces;
- SCIP-backed TypeScript/JavaScript/PHP Code Map indexing with bounded query/navigation contracts;
- persistent Task ↔ CodeScope continuity and explicit manual Code Map augmentation;
- a JSON-oriented CLI and lightweight dependency-free MCP stdio proxy;
- Task, Claim, Activity, Artifact, Relation, Investigation, Flow Work Group, and board-position persistence;
- internal optimistic concurrency, idempotent mutation receipts, stale-Claim release protection, and concurrency diagnostics;
- browser/SCIP acceptance coverage and multi-worker race tests.

The current product direction is continuity-first: keep the human-facing workflow small, preserve strong internal recovery/context links, and avoid replacing specialist tools. Start with the [documentation map](docs/README.md), the [product direction](docs/QUESTBOARD-PROJECT-PLAN.ko.md), or the [agent onboarding guide](docs/AGENT-ONBOARDING.md).

## Requirements

- Node.js **24 or newer**
- npm
- macOS, Linux, or another platform supported by Node 24 and `node:sqlite`
- Tailscale only if you want Tailnet-only access from another device

QuestBoard's foundation uses Node built-ins; Code Map keeps the pinned `@sourcegraph/scip-typescript` runtime dependency behind the code-intelligence adapter boundary and can additionally use a target Composer project's project-local `scip-php`. TypeScript and Node type definitions remain development dependencies.

## Install

```bash
git clone https://github.com/kalstein27/QuestBoard.git
cd QuestBoard
npm ci
npm run build
```

For development or before publishing changes, run the complete verification suite:

```bash
npm run verify
```

`npm run verify` runs type checking, Web JavaScript syntax validation, the full test suite, and the dedicated multi-worker race test.

## Quick start: local Web/API

For a first run, start the long-lived daemon on localhost:

```bash
npm run build
npm run daemon:local
```

Then open:

```text
http://127.0.0.1:4317
```

The default database is:

```text
.questboard/questboard.sqlite
```

On first start, that database receives a stable UUID and the daemon pins it to the local QuestBoard identity profile. MCP/CLI clients validate the daemon protocol and pinned database UUID before attaching, so a different QuestBoard database listening on the same endpoint is rejected instead of being used silently.

The Web UI exposes Quest, Flow, and Code workspaces plus Agent Follow presence controls. Use `npm run daemon` when you intentionally want the canonical Tailnet-bound mode; it binds to the machine's active Tailscale IPv4. See [`docs/NETWORK-ACCESS.md`](docs/NETWORK-ACCESS.md) before enabling access from another device.

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
| `QUESTBOARD_CODE_MAP` | Set to `1` or `true` to enable Code Map indexing; managed-service mode defaults it on when unset | disabled normally; enabled in managed-service mode |
| `QUESTBOARD_CODE_MAP_PROVIDER` | Optional single-provider override: `scip-typescript` or `scip-php` | unset |
| `QUESTBOARD_CODE_MAP_PROVIDERS` | Ordered semantic provider set | `scip-typescript,scip-php` |
| `QUESTBOARD_CODE_MAP_STORAGE_ROOT` | External Code Map index/cache directory | `~/.local/share/questboard/code-map` |
| `QUESTBOARD_SCIP_TYPESCRIPT_EXECUTABLE` | Optional override for the bundled `scip-typescript` indexer executable | local `node_modules/.bin/scip-typescript` |
| `QUESTBOARD_SCIP_PHP_EXECUTABLE` | Optional SCIP PHP executable override | target project's `vendor/bin/scip-php` |

### Code Map provider setup

Code Map is opt-in for ordinary daemon launches, while ChatGPT2Codex managed-service mode enables it by default unless `QUESTBOARD_CODE_MAP` is explicitly set to a disabling value. The default semantic set is **SCIP TypeScript + SCIP PHP**. QuestBoard declares `@sourcegraph/scip-typescript` as a pinned runtime dependency, while PHP indexing intentionally uses the target Composer project's own `vendor/bin/scip-php`. QuestBoard reads both providers' `.scip` output through the same provider-neutral decoder/normalizer path.

If a semantic indexer is unavailable, QuestBoard still starts normally and preserves file-only coverage. TypeScript provisioning remains self-contained. PHP semantic indexing requires the target project to have `composer.json`, `composer.lock`, installed `vendor/autoload.php`, and the trusted `davidrjenni/scip-php` development dependency that provides `vendor/bin/scip-php`. Provider-install requests are approval-only external-host plans and never install dependencies or start indexing by themselves. Generated Code Map indexes are retained under `QUESTBOARD_CODE_MAP_STORAGE_ROOT`; the temporary root `index.scip` produced by SCIP PHP is copied out and removed, and a pre-existing project `index.scip` is never overwritten.

Use `QUESTBOARD_CODE_MAP_PROVIDER` only when intentionally forcing one provider. Mixed TypeScript/JavaScript/PHP repositories should normally keep the default plural provider set so unsupported or unprepared languages remain explicit coverage gaps instead of disappearing from the file hierarchy.

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

The adapter exposes the shared agent-tool catalog rather than a separate MCP-only feature set. It includes:

- Project and Task workflow tools such as `questboard_list_projects`, `questboard_list_tasks`, `questboard_resume_task`, and `questboard_checkpoint_task`;
- Claim, Activity, Artifact, Relation, Investigation, and Flow Work Group tools;
- bounded Code Map lifecycle/query, Task ↔ CodeScope, manual-relation, and Investigation-sync tools;
- ephemeral Agent Follow presence through `questboard_get_agent_focus`, `questboard_set_agent_focus`, and `questboard_clear_agent_focus`.

Use MCP `tools/list` as the authoritative live catalog for exact tool names and schemas.

Mutating tools require a neutral actor object:

```json
{
  "id": "agent:worker-1",
  "provider": "my-agent"
}
```

See [`docs/AGENT-ONBOARDING.md`](docs/AGENT-ONBOARDING.md) for the recommended cross-agent workflow.

## Recommended agent workflow

1. List Projects and active/Ready/Planned Tasks.
2. Read the Task's current goal/state/next action first.
3. Read Activity, Artifacts, Relations, Investigation, or Code Map only when the next action needs more context.
4. Claim the Task when useful as a coordination signal.
5. Work and record only meaningful checkpoint/blocker/evidence changes.
6. Before handing work to another session/agent, leave a concise resume state with the next action.
7. Release using the observed `claimId` when available.

The target is not maximum history capture. It is the smallest shared state that lets a human understand progress and lets an AI resume correctly.

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

This repository intentionally keeps runtime data and local tooling state out of Git through `.gitignore`.

**No open-source license is currently granted.** The repository is publicly readable, but no standard license for reuse, modification, or redistribution has been selected. This is intentional for now and should not be interpreted as a missing license file that downstream users may replace with an assumed license.

## Documentation

- [`docs/README.md`](docs/README.md): documentation map and current-truth entry points
- [`AGENTS.md`](AGENTS.md): repository rules and quick-start contract for coding agents
- [`docs/AGENT-ONBOARDING.md`](docs/AGENT-ONBOARDING.md): neutral agent connection and handoff guide
- [`docs/architecture/FOUNDATION.md`](docs/architecture/FOUNDATION.md): implementation architecture and invariants
- [`docs/QUESTBOARD-PROJECT-PLAN.ko.md`](docs/QUESTBOARD-PROJECT-PLAN.ko.md): product direction and staged plan
- [`docs/NETWORK-ACCESS.md`](docs/NETWORK-ACCESS.md): localhost, LAN, Tailnet, and public-Internet exposure guidance
