# QuestBoard Phase 4 Implementation Result

- Date: 2026-09-29 (Asia/Seoul)
- Phase: Code-aware 4/6 · Persistent Task ↔ CodeScope binding + scope Goal/TODO UX
- Worker role: implementation worker, not independent reviewer
- QuestBoard branch: `main`
- Worker HEAD baseline: `87c34f743fffad39c3c19c7a5bf88b6314aba022`
- Commit / push / deploy / runtime apply / provider install: **not performed**
- Phase 5: **not started**

## 1. Implemented boundary

Phase 4 V1 now persists a vendor-neutral Task ↔ raw CodeScope binding without adding provider-specific code fields to the Task domain.

Binding kinds:

- `targets`
- `implemented_in`
- `affects`
- `investigates`

Persisted binding identity:

- QuestBoard project ID
- Task ID
- exact raw Code node ID
- exact raw Code canonical identity
- binding kind
- actor/provider audit fields
- created/updated timestamps
- revision

Derived lifecycle states:

- `active`: exact node ID exists and canonical identity still matches
- `stale`: indexed graph exists but endpoint disappeared or exact identity changed
- `unindexed`: durable binding exists after restart, but this runtime has not indexed the project yet

No fuzzy relink is performed. A disappearing code target does not delete the Task. Tasks without any CodeScope remain normal first-class Tasks.

## 2. Persistence and service semantics

New application boundary:

`src/application/code-scope-binding.ts`

It provides:

- list bindings by project, optional Task, optional Code node
- attach existing Task to exact CodeScope
- detach binding without deleting Task or Code node
- atomically create a Task and binding under the shared repository mutation transaction
- idempotent request receipts using the existing QuestBoard mutation boundary
- exact active/stale/unindexed derivation against the current cached raw Code graph

SQLite persistence:

- new `task_code_scope_bindings` table
- project and Task foreign keys
- unique `(task_id, code_node_id, kind)` constraint
- project/Task and project/node indexes
- Task deletion cascades its bindings, while code disappearance is represented as stale rather than deleting anything

## 3. Shared HTTP / Agent / MCP surface

New shared agent/MCP tools:

- `questboard_list_code_scope_bindings`
- `questboard_attach_task_code_scope`
- `questboard_detach_task_code_scope`
- `questboard_create_task_for_code_scope`

Mutating MCP calls use the existing automatic request-ID/idempotency semantics.

New HTTP surface:

- `GET /projects/:projectId/code-scope-bindings`
- `POST /projects/:projectId/code-scope-bindings`
- `POST /projects/:projectId/code-scope-tasks`
- `DELETE /code-scope-bindings/:bindingId?expectedRevision=...`

The normal `GET/POST /projects/:projectId/code-map` payload also includes `codeScopeBindings`, so the Web technical inspector uses the same persistent source.

## 4. Web UX

### Code side

The raw technical inspector now has a `Related Tasks` section.

- `+ Task` creates a normal QuestBoard Task already bound to the currently selected exact CodeScope with kind `targets`.
- Existing bound Tasks are grouped by the canonical Task hierarchy Work Group rather than rendered as one flat list.
- Each Work Group shows its linked child/Goal Tasks together; ungrouped Tasks remain in a separate independent section.
- Existing bound Tasks show title, Task status, binding kind, and binding lifecycle state.
- Clicking a related Task opens the normal Task drawer.
- `Open Group` opens the Work Group Task drawer, where the Group's own bindings plus all descendant Task bindings are aggregated as CodeScope context.

### Quest / Task side

The Task drawer now has a `Code scopes` section near the continuity context.

- attached scopes show exact Code identity/name, binding kind, and state
- `+ Attach` accepts an exact raw Code node ID and binding kind
- `Detach` removes only the binding
- after detach the Task remains and the UI explicitly states that the Task is valid without a CodeScope
- for a Work Group Task, descendant bindings are aggregated read-only with the owning child Task named; inherited descendant rows open the child Task rather than detaching its binding from the parent drawer

This is the Task-hierarchy Work Group aggregation explicitly required by Phase 4. It is computed from the existing canonical Task hierarchy (`parentByChild` / descendants) and does not introduce a new hierarchy or Phase 5 architecture.

## 5. Targeted verification

Fresh targeted gate:

- `npm run check:web`: PASS
- `npm run build`: PASS
- `tests/code-map-explorer-web-contract.test.ts`
- `tests/code-scope-binding.test.ts`
- **14/14 PASS**

Covered behavior includes:

- SQLite restart persistence
- `unindexed` after restart before Code Map refresh
- exact identity drift → `stale`
- no fuzzy relink
- Task survives stale/detach
- attach request idempotency
- many-to-many cardinality: one Task may bind multiple CodeScopes and one CodeScope may bind multiple Tasks
- duplicate exact Task/node/kind triples stay single
- combined Task+binding creation rolls back the Task if binding persistence is forced to fail
- shared Agent/MCP/HTTP semantics
- HTTP Code Map payload includes bindings
- Web Code and Quest surfaces expose create/attach/detach
- Work Group related Tasks are grouped from the canonical Task hierarchy and descendant CodeScopes aggregate in the Group drawer

## 6. Actual SCIP + browser E2E

The existing real SCIP / headless Chrome E2E was extended with Phase 4 behavior and passed.

Actual browser flow:

1. index real QuestBoard source with SCIP
2. open raw Code explorer
3. select a real source symbol
4. pre-bind a child Task in a real Task Work Group to that raw Code node
5. verify Code inspector groups the child under its Work Group rather than a flat list
6. open the Work Group and verify its drawer aggregates the child's CodeScope and attributes it to the child Task
7. return to the Code inspector and use `Related Tasks → + Task`
8. verify the newly created Task appears as an active `targets` binding
9. open that Task drawer
10. verify the `Code scopes` section shows the active scope
11. detach the scope
12. verify the Task remains as a targetless Task while the Work Group child's binding remains intact
13. continue the existing Code→Flow sync E2E

Result: **PASS**.

## 7. Full regression gate

Fresh `npm run verify && git diff --check`:

- typecheck: PASS
- Web syntax: PASS
- Node tests: **167/167 PASS**
- failures: 0
- skipped: 0
- actual SCIP browser E2E: PASS
- multi-worker claim/revision race gate: PASS
- `git diff --check`: PASS

## 8. Existing dirty tree preservation

QuestBoard remains intentionally dirty with the accumulated Phase 3 plus Phase 4 work. No reset, checkout, clean, revert, deletion, commit, push, deployment, runtime replacement, Managed MCP update, or provider installation was performed.

The implementation worker added Phase 4 source/tests on top of the existing tree and did not treat older dirty changes as disposable.

## 9. Independent review focus

Because this worker changed product source, it must not mark its own Phase 4 acceptance Done.

Independent review should especially verify:

1. persistent binding survives repository restart
2. restart-before-reindex is `unindexed`, not falsely stale
3. reindex with same exact identity returns `active`
4. endpoint disappearance or identity drift returns `stale` without fuzzy relink
5. stale/detach never deletes the Task
6. targetless Tasks remain first-class
7. one CodeScope can have multiple Tasks and one Task can have multiple scopes
8. Task core remains provider-neutral and contains no file/class/function/provider fields
9. Agent, MCP, HTTP, and Web share the same persisted semantics
10. Code `+ Task` and Quest attach/detach work in actual browser behavior
11. Related Tasks are grouped by the canonical Task Work Group and Group selection aggregates descendant CodeScopes without inventing a second hierarchy
12. descendant binding ownership remains explicit and parent Group UX does not silently mutate child bindings
13. no broader Phase 5 architecture slipped into Phase 4
14. full verify remains green

## 10. Worker conclusion

Implementation acceptance evidence is green, but canonical status should be `review` until a separate independent reviewer reproduces the important persistence/stale/UI semantics.

Next implementation after independent acceptance would be the canonical Phase 5 task only. The current worker stops before Phase 5.

Final canonical worker transition:

- Phase 4 Task: `review`
- revision: `3`
- independent review handoff: `docs/PHASE-4-INDEPENDENT-REVIEW-HANDOFF.ko.md`
- Phase 5 implementation: **not started**
