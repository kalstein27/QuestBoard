# QuestBoard Phase 6 Independent Review Handoff

작성일: 2026-09-29 (Asia/Seoul)

## 1. Reviewer 역할

이 문서는 Phase 6 구현 worker와 분리된 새 채팅이 current live 상태를 독립 검증하기 위한 handoff다.

이 문서와 worker result는 정답이 아니다. 반드시 다음을 fresh하게 직접 읽고 재검증한다.

- current QuestBoard live Task
- current Git branch / HEAD / dirty / staged
- actual source / current diff
- fresh tests / actual browser behavior

PASS/FAIL은 reviewer가 독립적으로 판정한다.

## 2. Canonical project

- projectId: `questboard`
- root: `<QUESTBOARD_REPO>`
- branch: `main`
- worker baseline HEAD: `87c34f743fffad39c3c19c7a5bf88b6314aba022`
- upstream: `origin/main`
- workspace는 Phase 3~6 cumulative intentional dirty 상태다.

금지:

- reset / checkout / clean / revert / unrelated delete
- unrelated dirty file 수정
- commit / push / deploy
- runtime apply / provider install / Managed MCP update
- 다음 새 구현 시작

## 3. Phase 6 Task

Task ID:

`29b500f8-e118-4ffe-8c60-88dd9426df9f`

Title:

`Code-aware 6/6: stale/relink lifecycle + Agent Follow + real-work E2E`

Worker가 review로 넘길 때 기대 상태:

- status: `review`
- revision: `4`
- claim: null

Reviewer는 반드시 live Task를 직접 읽어 확인한다.

## 4. Phase 6 acceptance intent

Phase 6는 다음 두 축과 final dogfood를 마감한다.

### A. stale/relink lifecycle

CodeScope binding이 refactor/reindex 후에도 Task를 보존하면서 conservative하게 복구 가능해야 한다.

우선순위:

1. exact stable target
2. unique canonical/semantic identity
3. unique exact file/path + signature/kind/language fallback
4. ambiguity 또는 evidence 부족 시 stale

중요:

- read/list만으로 binding을 자동 변경하면 안 된다.
- fuzzy name matching 금지.
- ambiguous candidate 임의 선택 금지.
- Task/Group 삭제 금지.
- explicit relink mutation에서만 persistent target 변경.

### B. ephemeral Agent Focus

최소 상태:

- projectId
- sessionId
- taskId?
- workGroupId?
- flowNodeId?
- codeScopeId?
- updatedAt

반드시 canonical history와 분리한다.

- claim 아님
- authorization 아님
- SQLite durable state 아님
- Task Activity 아님
- Resume Capsule 아님

UX:

- Watching
- Follow
- Free
- Return to agent

### C. real-work acceptance

- QuestBoard actual SCIP + headless Chrome
- 외부 실제 repository read-only dogfood
- responsive/iPad path
- existing Phase 1~5 regressions

## 5. Worker-reported source changes to inspect

### `src/application/code-scope-binding.ts`

Worker reports:

- state에 `relinkable` 추가
- attach 시 anchors 저장:
  - kind
  - language
  - path
  - signature
  - name
- exact ID+canonical active
- unique canonical identity → relinkable
- unique exact path/signature fallback → relinkable
- multiple candidate → stale `relink_ambiguous`
- explicit `relink()` mutation
- collision fail-closed
- actor/audit/revision/CAS 유지

Reviewer가 특히 확인할 것:

- name은 relink matching에 사용하지 않아 fuzzy behavior가 없는지
- non-file fallback이 signature 없는 상태에서 이름으로 연결되지 않는지
- canonical identity duplicate가 fallback 하나와 섞일 때 잘못 선택하지 않는지
- same ID identity drift가 exact evidence 없이 자동 active가 되지 않는지

### `src/application/quest-board-repository.ts`

- `updateTaskCodeScopeBinding` 추가 여부

### `src/storage/sqlite/sqlite-quest-board-repository.ts`

- new anchor columns
- existing DB migration
- insert/map/update parity
- CAS update
- UNIQUE(Task,node,kind) collision semantics 보존

### shared surfaces

- `src/adapters/agent-tools.ts`
- `src/adapters/mcp/mcp-server.ts`
- `src/server/http-api.ts`
- `web/app.js`

Expected relink surface:

- `questboard_relink_task_code_scope`
- POST `/code-scope-bindings/:bindingId/relink`
- Web direct relinkable row only

Agent/MCP/HTTP가 같은 service semantics를 사용해야 한다.

## 6. Agent Focus source to inspect

New module:

`src/application/agent-focus.ts`

Expected:

- process-memory Map only
- no repository persistence write
- project validation
- optional Task project validation
- session focus set/list/latest/clear
- bounded list

Integration:

- `src/index.ts`
- `src/adapters/agent-tools.ts`
- `src/server/http-api.ts`
- `src/server/runtime.ts`
- `src/server/main.ts`

Expected tools:

- `questboard_get_agent_focus`
- `questboard_set_agent_focus`
- `questboard_clear_agent_focus`

Expected HTTP:

- GET `/projects/:projectId/agent-focus`
- POST `/projects/:projectId/agent-focus`
- DELETE `/projects/:projectId/agent-focus?sessionId=...`

Reviewer must verify these focus actions do NOT append Task Activity, alter Claim, or enter Resume Capsule.

Also inspect whether MCP auto mutation receipt behavior accidentally treats focus as canonical mutation. Worker intentionally kept focus tools outside the normal `MUTATING_TOOLS` set because focus is ephemeral. Confirm this is coherent and safe.

## 7. Web UX to inspect

Files:

- `web/index.html`
- `web/app.js`
- `web/styles.css`

Expected behavior:

- default `Free`
- focus exists → Watching control visible
- Follow only auto-navigates on newer focus timestamp
- Free does not let subsequent focus updates steal navigation
- Return to agent applies latest focus once
- priority:
  1. CodeScope
  2. Flow Group/Node
  3. Task
- 1500ms polling is bounded and single-interval
- project switch does not follow another project's focus
- no Activity/history write

Responsive:

- focus control remains bounded at iPad and phone widths
- toolbar keeps scroll/no-overflow behavior from existing responsive contract

Reviewer may strengthen a dedicated viewport assertion if current coverage is insufficient.

## 8. Worker-reported targeted verification

Command:

`npm run build && node --test dist/tests/code-scope-binding.test.js dist/tests/agent-focus.test.js && npm run check:web`

Reported:

- 8/8 PASS
- fail 0
- skip 0

Reviewer should rerun fresh.

## 9. Worker-reported actual SCIP/headless Chrome acceptance

Focused set:

`npm run build && node --test dist/tests/code-map-explorer-web-contract.test.js dist/tests/code-map-sync-actual-scip-e2e.test.js`

Reported:

- 13/13 PASS
- fail 0
- skip 0

Actual real symbol used:

- `createQuestBoardHttpServer`

Reported browser proof:

- Agent Focus Watching visible
- Follow → exact CodeScope
- Free prevents forced continuation
- Return to agent → exact same CodeScope
- synthetic old binding ID creates relinkable state
- Web Relink restores actual SCIP node
- existing Phase 4/5 Group↔Flow↔Code paths still pass

Reviewer must rerun and inspect behavior, not only contract regexes.

## 10. External ChatGPT2Codex read-only dogfood

Fixture root:

`<CHATGPT2CODEX_REPO>`

Worker baseline and after status reported identical:

- branch: `docs/windows-install-refresh`
- HEAD: `49d34c44d2e158965062552e40ef1ce9b98c89e0`
- pre-existing dirty: `src/runtime/tool-progress.ts`
- staged: 0

Important: do NOT claim fixture is clean. It was already dirty before dogfood.

Worker reports all DB/SCIP generated state used temp paths and fixture source was read-only.

Fresh actual measurement reported:

- files: 540
- nodes: 20,466
- relations: 47,685
- representative symbol: `scanWorkspace`
- source: `src/workspace/registry.ts`
- candidate strategy: `canonical_identity`
- relink active revision: 3
- focus ephemeral: true

Reviewer may reproduce with temp state only. Preserve baseline dirty set exactly.

## 11. Fresh-agent Resume acceptance

Reviewer must verify:

- focus publish does not increase Activity count
- `resumeTask()` output does not gain `agentFocus` or navigation data
- creating a fresh AgentFocusService/process does not recover old focus from SQLite

This proves Resume remains canonical work continuity, not live cursor state.

## 12. Full regression reported by worker

Fresh command:

`npm run verify && git diff --check`

Reported:

- typecheck PASS
- Web syntax PASS
- Node tests **173/173 PASS**
- fail 0
- skip 0
- actual SCIP/headless Chrome PASS
- multi-worker claim/revision race PASS
- git diff --check PASS

Reviewer must rerun fresh.

## 13. Reviewer decision rules

### PASS

PASS only if:

- conservative relink is fail-closed
- no ambiguous/fuzzy silent binding movement
- explicit relink persistence/CAS works
- Task survives stale/relink failure
- Agent Focus is genuinely ephemeral/noncanonical
- Follow UX does not steal control in Free
- actual SCIP browser acceptance passes
- external fixture integrity holds
- fresh full regression green

Then:

1. Phase 6 → Done
2. inspect parent umbrella live state
3. only if Phase 1~6 all independently accepted/Done, parent umbrella may be transitioned to Done
4. do not start any new phase or product implementation

### Finding

If any material lifecycle/focus issue exists:

- keep Phase 6 in review
- record exact source/test evidence
- do not force Done
- do not start follow-up implementation in the independent review chat unless explicitly instructed

## 14. Mandatory result artifacts

Review completion requires both:

1. local canonical result:

`docs/PHASE-6-INDEPENDENT-REVIEW-RESULT.ko.md`

2. same useful result as a chat-directly-openable file, e.g. `/mnt/data/QuestBoard_Phase6_Independent_Review_Result.md`

The chat result must be directly tappable/openable.

## 15. Worker reference only

Worker result:

`docs/PHASE-6-IMPLEMENTATION-RESULT.ko.md`

Again, use it only as a checklist. Current source/live evidence is authoritative.
