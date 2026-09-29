# QuestBoard Phase 5 Independent Review Handoff

이 문서는 구현 worker와 분리된 새 채팅이 Phase 5 `Flow + Code lens · Group/Scope aggregation + navigation`을 독립 검증하기 위한 handoff다.

## 1. Reviewer role

이 채팅은 implementation worker가 아니라 **independent reviewer**다.

다음은 증거가 아니라 worker claim으로 취급한다.

- 이 handoff
- `docs/PHASE-5-IMPLEMENTATION-RESULT.ko.md`
- worker가 보고한 test count / browser result

반드시 current live QuestBoard Task, current source/diff, fresh test/e2e로 재검증한다.

Blocker/major가 발견되면 구현 source를 즉석에서 고치지 말고 finding을 남기고 Phase 5를 `review`에 유지한다.

## 2. Project / guardrails

- projectId: `questboard`
- root: `<QUESTBOARD_REPO>`
- branch: `main`
- implementation HEAD baseline: `87c34f743fffad39c3c19c7a5bf88b6314aba022`
- workspace는 Phase 3+4+5가 누적된 의도된 dirty tree다.

금지:

- reset / checkout / clean / revert / unrelated deletion
- commit / push
- deploy / runtime apply
- provider install / Managed MCP update
- Phase 6 구현 시작
- 다른 채팅 lane / lease / operation 조작

## 3. Canonical Task

Phase 5 Task UUID:

`ec621b53-d393-40e8-960a-f873419fbd97`

Title:

`Code-aware 5/6: Flow + Code lens · Group/Scope aggregation + navigation`

시작 시 live Task status/revision을 반드시 다시 읽는다. 이 문서보다 live state가 우선한다.

## 4. Product boundaries to preserve

QuestBoard에는 서로 다른 정본 topology가 있다.

1. canonical Task hierarchy
2. human-authored visual Flow Work Group hierarchy/membership
3. Investigation Nodes / Items / Item↔Task links
4. provider-neutral raw Code graph
5. Phase 4 persistent Task↔CodeScope bindings

Phase 5는 이들을 합치지 않는다.

리뷰 중 특히 다음을 경계한다.

- Flow Group를 canonical Task Group과 동일시하면 안 됨
- Flow Node를 Group으로 자동 변환하면 안 됨
- Code hierarchy를 Investigation DB/model에 복제하면 안 됨
- full symbol graph를 Flow canvas에 렌더하면 안 됨
- derived UI focus가 canonical membership/binding을 mutation하면 안 됨

## 5. Worker implementation to inspect

Main implementation files:

- `web/app.js`
- `web/index.html`
- `web/styles.css`

Main tests changed:

- `tests/code-map-explorer-web-contract.test.ts`
- `tests/code-map-sync-actual-scip-e2e.test.ts`

No new Phase 5 persistence/service table was intentionally introduced.

### Flow lens model

Key concepts/functions to inspect include:

- `FLOW_CODE_LENS_SCOPE_LIMIT = 40`
- `FLOW_CODE_LENS_INLINE_LIMIT = 6`
- `flowWorkGroupTaskIds`
- `flowCodeScopeLensForTaskIds`
- `flowWorkGroupCodeLens`
- `relatedFlowContextForCodeScope`
- `flowCodeFocus`
- `renderFlowWorkGroupCodeLens`
- `applyFlowCodeFocus`
- `jumpToCodeScope`
- `showCodeScopeInFlow`
- `codeMapRelatedFlowSection`

Confirm these remain derived views over canonical state.

## 6. Required acceptance matrix

### A. Flow Work Group independence

Freshly prove visual Flow Work Groups remain rendered when:

- Flow Work Groups exist
- Tasks exist
- `investigationGraphNodes.length === 0`

The fallback Flow render path must not clear the Work Group layer.

This was a real bug found by worker E2E and fixed during Phase 5.

### B. Group → Code aggregation

For a visual Flow Work Group:

- collect Task memberships from the visual Group subtree
- include linked canonical Task context without changing hierarchy ownership
- aggregate Phase 4 CodeScope bindings
- dedupe exact Code node IDs
- keep binding/source identity intact

Verify nested visual Groups work and unrelated Groups do not leak scopes into the result.

### C. Bounded behavior / large Group

Freshly test thousands of related bindings.

Required invariant:

- aggregate result hard cap: **40 CodeScopes**
- inline rendered chips: **6 CodeScopes**
- remainder represented by count only
- no full graph traversal/rendering triggered by the lens

Worker used 5,000 bindings in VM regression. Reproduce independently or use an equally strong stress case.

### D. Flow → Code navigation

Fresh browser proof:

1. show Flow code lens
2. select/focus a visual Group with a real active CodeScope
3. scope chip appears
4. click scope chip
5. Code workspace opens the exact raw node ID
6. Code inspector identity/location matches the expected node

Stale/unindexed scopes must not silently navigate to a different node.

### E. Task → Code navigation

Task drawer CodeScope row must expose `Open Code` for active binding.

Verify:

- exact Code node opens
- detach semantics remain independent
- inherited descendant binding still exposes its owning Task action
- stale/unindexed binding cannot fuzzy-navigate

### F. Code → Flow navigation

For an exact CodeScope with Task bindings:

- Code inspector shows `Related Flow`
- related visual Work Groups are derived from Flow memberships / linked Task context
- `Show in Flow` switches to Flow
- lens becomes active
- related Group/Task context is highlighted

No Flow membership is rewritten by navigation.

### G. Connected Flow Item highlight

Create or reuse a real Investigation Item with Item↔Task link to a Task bound to the selected CodeScope.

Then verify `Show in Flow` highlights:

- that Flow Item
- its owning Investigation Node
- related visual Flow Group context when applicable

Unrelated Items/Nodes should not be highlighted.

### H. iPad / responsive UX

Freshly inspect contract and, if practical, browser viewport behavior.

Required:

- Flow CodeScope list uses bounded horizontal scrolling
- iPad media range does not allow the lens to expand without bound
- existing mobile Flow controls remain usable
- no new fixed-width panel makes the canvas unusable

### I. Topology separation

Inspect source/diff and confirm:

- no Phase 5 DB table/model duplication
- no Code graph copied into Investigation
- no Flow Node→Group auto conversion
- no generic graph framework added
- `Show code` is a derived overlay/focus only

### J. Existing behavior regression

Freshly run:

- targeted Web/Flow tests
- actual SCIP/headless Chrome E2E
- full `npm run verify`
- race gate (included by verify)
- `git diff --check`

Worker baseline, not evidence:

- targeted: **15/15 PASS**
- full verify: **169/169 PASS**, skip 0
- actual SCIP/headless Chrome E2E: PASS
- Flow Item highlight: PASS
- race: PASS
- diff-check: PASS

## 7. Actual browser scenario expected

Worker extended the existing real SCIP test to demonstrate:

1. actual QuestBoard source indexing
2. real `createQuestBoardHttpServer` raw Code node
3. scoped canonical Task
4. human-authored visual Flow Group + Task membership
5. Code `Related Flow`
6. `Show in Flow`
7. related visual Group highlight
8. bounded scope lens
9. exact scope chip → same Code node round-trip
10. existing Phase 4 Group/CodeScope UX
11. existing Code→Flow sync
12. real synced Flow Item linked to scoped Task
13. CodeScope → Flow Item + Group highlight
14. existing MCP/HTTP parity remains green

Reviewer should reproduce the semantic behavior, not merely assert that test source contains those words.

## 8. Findings format

Use severity:

- blocker
- major
- minor
- none

Each finding should include:

- file / symbol / scenario
- issue
- acceptance impact
- concrete evidence

Then include an acceptance matrix A-J.

## 9. Task transition

If blocker/major or unmet acceptance remains:

- keep Phase 5 `review`
- update Now/Next with exact finding/evidence needed
- do not start Phase 6

If all acceptance passes:

- transition Phase 5 to `done` using current live revision
- live-read the next canonical Task
- report it only
- **do not start Phase 6 implementation**

## 10. Mandatory canonical result file

Before finishing, reviewer must create/update:

`docs/PHASE-5-INDEPENDENT-REVIEW-RESULT.ko.md`

It must contain at least:

- review date
- branch / HEAD / dirty/staged status
- initial Phase 5 Task status/revision
- final Phase 5 Task status/revision
- Findings with severity
- A-J acceptance matrix
- Flow Work Group no-Investigation-graph evidence
- large-group bounded evidence
- exact Group/Task→Code evidence
- Code→Flow Group/Item highlight evidence
- actual SCIP/headless Chrome evidence
- full verify/race/diff-check results
- repository integrity / prohibited operations confirmation
- next canonical Task and status
- explicit confirmation Phase 6 was not started

If review is HOLD/FAIL, still write the result file with findings and required fixes.

Do not blindly overwrite unrelated reviewer work if a result file already exists.

## 11. Mandatory chat-tappable copy

The review is **not complete** if the result exists only at a local repository path.

After the canonical result is finalized, create a user-facing copy under `/mnt/data`, for example:

`/mnt/data/QuestBoard_Phase5_Independent_Review_Result.md`

Final chat reply must include a direct sandbox link so the owner can tap and open it immediately.

## 12. Final chat response

Keep the chat response compact.

Report:

- PASS / HOLD / FAIL
- final Phase 5 Task status/revision
- fresh verify count
- actual browser result
- canonical local result path
- chat-tappable result link
- next canonical Task name/status only

Do not start Phase 6.
