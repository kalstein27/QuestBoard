# Agent Rules

QuestBoard is a local-first shared work board for humans and multiple AI agents. Keep the core vendor-neutral and make changes in a way that remains usable from ChatGPT/C2CT, Codex, Claude, Antigravity, CLI, HTTP, MCP, and future adapters.

## Project independence

- QuestBoard is an independent project and is not subordinate to ChatGPT2Codex or any other agent runtime.
- Do not embed agent-specific state, assumptions, permissions, or product concepts directly in the core domain.
- Isolate provider-specific behavior behind adapter boundaries.
- QuestBoard Claims are coordination signals. They are not filesystem permissions, mutation locks, or authorization grants.

## Before changing anything

1. Inspect current Git/repository status and existing changes.
2. Read `docs/QUESTBOARD-PROJECT-PLAN.ko.md` for product direction.
3. Read `docs/architecture/FOUNDATION.md` for implementation invariants.
4. For agent integration or handoff work, read `docs/AGENT-ONBOARDING.md`.
5. Preserve the actual working tree if it differs from handoff prose or an older plan.

Never reset, revert, delete, clean, overwrite, or otherwise discard another agent's changes without explicit user authorization.

## Local setup

QuestBoard requires Node.js 24 or newer.

```bash
npm ci
npm run build
npm run verify
```

Start the Web/API server in the default Tailnet mode with:

```bash
npm start
```

Default URL: `http://<TAILSCALE-IP>:4317`

Use `npm run start:local` for localhost-only access at `http://127.0.0.1:4317`.

Default SQLite DB: `.questboard/questboard.sqlite`

Useful scripts:

```bash
npm run typecheck
npm run check:web
npm test
npm run test:race
npm run verify
npm run cli -- help
npm run mcp
```

## Agent operating contract

A normal agent workflow is:

1. list Projects/Tasks;
2. read the Task, current Claim, Activity, Artifacts, and Relations;
3. Claim when useful to advertise ownership of the work;
4. update the Task;
5. attach evidence and notes as work progresses;
6. add an `agent_handoff` Activity before transferring work;
7. release the Claim using the observed `claimId` when available.

### Concurrency

- Normal Task updates should **omit `expectedRevision`**. QuestBoard performs revision-based CAS internally and retries a concurrent update against the latest Task state.
- Use `expectedRevision` only when strict compare-and-set behavior is intentionally required.
- Do not invent external lock/lease UX around Task mutation. The desired public model is lockless outside and strict inside.
- A Claim does not block another client from updating a Task.
- If releasing a Claim, pass the `claimId` you observed when the adapter supports it. This protects against stale release of a newer re-Claim.
- Mutating adapters should use a stable `requestId` for exact retries. Reuse an ID only for the exact same operation/input/actor. A different mutation with the same ID is a conflict.
- MCP and CLI generate request IDs automatically. HTTP clients should send `x-questboard-request-id` or `Idempotency-Key` when retry safety matters.

### Actor identity

Actor `id` and `provider` are neutral attribution metadata. They are not authentication credentials and must not be treated as authorization.

## Architecture boundaries

Keep dependency direction approximately:

```text
Web / HTTP / CLI / MCP adapters
              ↓
       application service
              ↓
          core domain

SQLite adapter → repository port + core domain
```

- HTTP/CLI/MCP/Web must not bypass `QuestBoardService` to implement business rules directly.
- Core/application code must not depend on a specific AI vendor.
- SQLite remains behind the repository port.
- Board layout metadata is separate from Task workflow revision/Activity history.
- Activity is append-only evidence of work history.

## Verification expectations

For ordinary source changes, run the closest targeted check and then the full verification suite before handoff when practical:

```bash
npm run verify
```

`npm run verify` currently covers TypeScript type checking, Web JavaScript syntax, automated tests, and the dedicated multi-worker concurrency race scenario.

If changing concurrency behavior, preserve tests for:

- strict-CAS stale writer rejection;
- normal lockless concurrent updates;
- exact request replay without duplicate side effects;
- request ID reuse with different input failing closed;
- Claim contention;
- stale `claimId` release protection.

## Logging and diagnostics

Concurrency diagnostics are structured JSONL written to stderr by the executable server/CLI/MCP composition roots. They may contain actor/task/claim/request IDs and revision numbers, but mutation payload bodies should not be logged. Set `QUESTBOARD_CONCURRENCY_LOG=0` to disable these diagnostics.

## Repository hygiene

- Do not add secrets, credentials, private environment files, local SQLite databases, logs, build outputs, or machine-specific private data.
- `.questboard/`, `.chatgpt2codex/`, `dist/`, `node_modules/`, `*.sqlite*`, `.env` / `.env.*` (except the allowed `.env.example`), and `*.log` are intentionally ignored.
- Do not commit or push unless the user explicitly requests it.
- Do not add a license on the user's behalf. The project currently has no selected license; license choice is a publication decision for the owner.

## Source of direction

`docs/QUESTBOARD-PROJECT-PLAN.ko.md` remains the product-direction source. If the plan conflicts with the actual repository state, inspect and preserve the actual state first, then update/report the stale documentation rather than forcing the code back to the old plan.
