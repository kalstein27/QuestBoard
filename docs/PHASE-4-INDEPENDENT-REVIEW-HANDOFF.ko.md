# QuestBoard Phase 4 Independent Review Handoff

이 문서는 구현 worker와 분리된 새 채팅이 Phase 4 `Persistent Task ↔ CodeScope binding + scope Goal/TODO UX`를 독립 검증하기 위한 handoff다.

## 1. Reviewer role

이 채팅은 implementation worker가 아니라 **independent reviewer**다.

다음을 증거가 아니라 worker claim으로 취급하고 live source/behavior로 다시 검증한다.

- 이 handoff
- `docs/PHASE-4-IMPLEMENTATION-RESULT.ko.md`
- worker가 보고한 test count와 browser result

리뷰 중 blocker/major가 발견되면 구현 source를 즉석에서 고치지 말고 finding을 남겨 Phase 4를 `review`에 유지한다.

## 2. Project / guardrails

- projectId: `questboard`
- root: `<QUESTBOARD_REPO>`
- branch: `main`
- implementation baseline HEAD: `87c34f743fffad39c3c19c7a5bf88b6314aba022`
- workspace는 Phase 3 + Phase 4 변경이 누적된 의도된 dirty tree다.

금지:

- reset / checkout / clean / revert / unrelated deletion
- commit / push
- deploy / runtime apply
- provider install / Managed MCP update
- Phase 5 구현 시작
- 다른 채팅 lane/lease/operation 조작

## 3. Canonical Task

Phase 4 Task:

`82505848-0988-4be6-ae56-1f1c4e051943`

`Code-aware 4/6: Persistent Task ↔ CodeScope binding + scope Goal/TODO UX`

시작 시 live QuestBoard Task status/revision을 반드시 다시 읽는다. Handoff보다 live state가 우선한다.

## 4. Worker implementation to review

### Persistent model

Main file:

`src/application/code-scope-binding.ts`

Binding kinds:

- `targets`
- `implemented_in`
- `affects`
- `investigates`

Persisted exact identity:

- Task ID
- raw Code node ID
- raw canonical identity
- kind
- audit actor/provider/timestamps/revision

Derived states:

- `active`
- `stale`
- `unindexed`

Reviewer must verify state is derived conservatively and no fuzzy relink exists.

### Repository / SQLite

Relevant files:

- `src/application/quest-board-repository.ts`
- `src/storage/sqlite/sqlite-quest-board-repository.ts`

Review:

- restart persistence
- FK/cascade semantics
- unique binding semantics
- revision-safe detach
- mutation/idempotency transaction behavior
- Task remains independent of code data

### Runtime / shared adapters

Relevant files:

- `src/server/main.ts`
- `src/server/runtime.ts`
- `src/server/http-api.ts`
- `src/adapters/agent-tools.ts`
- `src/adapters/mcp/mcp-server.ts`

New shared operations:

- list bindings
- attach existing Task
- detach binding
- create Task already attached to current CodeScope

Confirm Agent/MCP/HTTP use the same service and persisted semantics.

### Web

Relevant files:

- `web/app.js`
- `web/styles.css`
- `tests/code-map-explorer-web-contract.test.ts`

Code inspector:

- `Related Tasks`
- `+ Task`
- binding kind/state
- bound Task opens normal Task drawer
- related Tasks are grouped by canonical Task hierarchy Work Group, not a flat list
- a Work Group can contain its own Goal binding and multiple descendant Task/TODO bindings for the same CodeScope
- `Open Group` must expose the Work Group's accumulated descendant CodeScopes

Task drawer:

- `Code scopes`
- exact-scope attach
- detach
- explicit targetless-Task validity
- when the selected Task is a Work Group, aggregate direct + descendant CodeScope bindings, identify the owning descendant Task, and do not offer a parent-level detach that silently mutates the child binding

This Work Group grouping/descendant aggregation is explicitly Phase 4 acceptance. It must derive from the existing canonical Task hierarchy. Do not require or introduce any broader Phase 5 hierarchy/architecture beyond this Phase 4 UX.

## 5. Required acceptance checks

### A. Durable restart lifecycle

Fresh temp DB:

1. create project + Task
2. index a graph
3. attach exact CodeScope
4. restart SQLite/recreate services without indexing
5. binding must still exist and report `unindexed`
6. reindex exact same node ID + canonical identity → `active`
7. remove endpoint → `stale`
8. restore endpoint exact identity → `active`
9. same node ID but different canonical identity → `stale`
10. must not fuzzy relink to a similar node

### B. Task independence

Verify:

- Task entity itself has no provider/file/class/function/symbol field added
- targetless ordinary Task still works
- detach does not delete Task
- stale code target does not delete Task
- deleting Task cleans its persisted bindings appropriately

### C. Cardinality

Verify on fresh state:

- one Task may bind to multiple CodeScopes
- one CodeScope may bind to multiple Tasks
- same Task/node/kind does not duplicate
- different kinds may coexist if intended by schema

### D. Atomic create-for-scope

Inspect and, if practical, fault-test that create Task + binding is one shared transaction. A binding failure must not leave an orphan Task from the combined operation.

### E. Shared adapter parity

Freshly verify:

- Agent tool list/attach/detach/create-for-scope
- MCP same mutation semantics and auto request ID behavior
- HTTP same persisted result
- GET Code Map includes durable bindings for Web

### F. Actual browser UX

Run actual SCIP + headless Chrome E2E.

At minimum demonstrate:

1. select a real raw Code node
2. bind at least one descendant Task of a real Work Group to that CodeScope
3. verify `Related Tasks` groups the descendant under the Work Group
4. open the Work Group and verify the Group drawer aggregates the descendant CodeScope and names its owning child Task
5. `Related Tasks → + Task`
6. newly bound Task appears active
7. click Task and open drawer
8. `Code scopes` shows current binding
9. detach
10. Task remains targetless while the Work Group descendant binding remains intact
11. existing raw explorer navigation and Code→Flow E2E still pass

### G. Phase boundary

Verify the required Work Group grouping/descendant aggregation is derived from the existing Task hierarchy and does not create a hidden second hierarchy or broader Phase 5 architecture.

## 6. Worker evidence baseline

Do not accept these counts without fresh execution.

Worker reported:

- targeted Phase 4 gate: **14/14 PASS**
- actual SCIP + headless Chrome Phase 4 E2E: PASS
- full `npm run verify`: **167/167 PASS**
- race gate: PASS
- `git diff --check`: PASS

## 7. Findings format

Use severity:

- blocker
- major
- minor
- none

Each finding should include:

- file/symbol/scenario
- issue
- acceptance impact
- concrete evidence

Then include an acceptance matrix covering at least A-G above.

## 8. Task transition

If blocker/major or an unmet acceptance criterion remains:

- keep Phase 4 `review`
- update Now/Next with exact finding/evidence needed
- do not start Phase 5

If all acceptance criteria pass:

- transition Phase 4 to `done` using current live revision
- live-read the next canonical Task
- report it only
- **do not start Phase 5 implementation**

## 9. Mandatory result files

Before reviewer finishes, it must write a local canonical result regardless of PASS/HOLD/FAIL:

`<QUESTBOARD_REPO>/docs/PHASE-4-INDEPENDENT-REVIEW-RESULT.ko.md`

It must contain:

- date
- QuestBoard branch/HEAD/status
- final Phase 4 Task status/revision
- Findings
- acceptance matrix
- persistence/restart/stale evidence
- cardinality and Task-independence evidence
- atomicity evidence
- Agent/MCP/HTTP parity evidence
- actual browser evidence
- fresh full verify evidence
- residual risks
- next canonical Task without starting it

### Chat-tappable result is also mandatory

The reviewer must also create a user-visible copy under `/mnt/data`, for example:

`/mnt/data/QuestBoard_Phase4_Independent_Review_Result.md`

and return a `sandbox:/mnt/data/...` link so the result can be opened directly from the chat.

A local-only path or chat-only prose is incomplete.

## 10. Start order

1. `@C2CT` fresh bootstrap
2. read this handoff and worker result
3. live-read Phase 4 Task
4. inspect HEAD/dirty diff and relevant source
5. fresh persistence/cardinality/atomicity checks
6. fresh adapter parity
7. actual SCIP/headless browser E2E
8. full `npm run verify` + `git diff --check`
9. decide PASS/HOLD
10. CAS-safe Task transition
11. write canonical local review result
12. create `/mnt/data` chat-tappable result copy
13. stop without Phase 5 implementation

---

This handoff is only a starting point. Reproduce the acceptance from the current live state.
