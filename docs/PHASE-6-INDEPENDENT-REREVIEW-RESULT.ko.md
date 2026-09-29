# QuestBoard Phase 6 Independent Re-review Result

- Review date: 2026-09-29 (Asia/Seoul)
- Canonical handoff: `docs/PHASE-6-INDEPENDENT-REREVIEW-HANDOFF.ko.md`
- Previous FAIL: `docs/PHASE-6-INDEPENDENT-REVIEW-RESULT.ko.md`
- Blocker fix result: `docs/PHASE-6-BLOCKER-FIX-RESULT.ko.md`
- Implementation result: `docs/PHASE-6-IMPLEMENTATION-RESULT.ko.md`
- Phase 6 Task: `29b500f8-e118-4ffe-8c60-88dd9426df9f`
- Independent verdict: **PASS / ACCEPTED**
- Live Phase 6 before re-review: `review / revision 5 / claim=null`
- Live Phase 6 after re-review: **`done / revision 6`**
- Phase 2: **`review / revision 12`**
- Parent umbrella: **unchanged (`planned / revision 5`)**

## 1. Executive summary

Phase 6 independent re-review는 **PASS**다.

이전 independent review의 FAIL 원인이었던 relink precedence blocker를 current source와 fresh regression으로 직접 재검증했다. 현재 `bindingState()`는 lower-priority fallback을 계산하기 전에 canonical identity ambiguity를 즉시 fail-closed 처리한다. 따라서 **canonical candidate가 2개 이상인 상태에서 path/signature fallback 후보가 1개뿐이어도 relinkable로 내려가지 않고 `stale / relink_ambiguous`로 남는다.** 같은 상태에서 explicit relink mutation도 `code_scope_relink_unavailable` 경로로 거부된다.

Fresh verification 결과:

- Phase 6 precedence/lifecycle focused regression: **6/6 PASS**, fail 0, skipped 0
- full `npm run verify`: **173/173 PASS**, fail 0, skipped 0
- actual SCIP + headless Chrome E2E: full verify에서 PASS, standalone fresh run도 **1/1 PASS**
- multi-worker claim/revision race gate: **PASS**
- legacy Task↔CodeScope anchor migration probe: **PASS**
- external ChatGPT2Codex read-only dogfood: **PASS**
- `git diff --check`: **PASS**

Phase 6 acceptance에 남은 blocker가 없으므로 live Phase 6 Task를 `done / revision 6`으로 전환했다.

단, Phase 2는 fresh read 기준 여전히 `review / revision 12`다. 따라서 parent Code-aware umbrella는 닫지 않았고 현재 `planned / revision 5`를 그대로 유지했다. 새 구현이나 다음 Phase는 시작하지 않았다.

---

## 2. Fresh repository / live state

Re-review는 worker 결과를 현재 사실로 간주하지 않고 live state와 current checkout을 다시 읽는 것으로 시작했다.

QuestBoard repository:

- projectId: `questboard`
- root: `<QUESTBOARD_REPO>`
- branch: `main`
- HEAD: `87c34f743fffad39c3c19c7a5bf88b6314aba022`
- upstream: `origin/main`
- staged: 0
- 기존 Phase 3~6 작업으로 인한 dirty/untracked tree가 이미 존재하며 그대로 보존함

Live QuestBoard state at re-review start:

- Phase 6: `review / revision 5 / claim=null`
- Phase 2: `review / revision 12 / claim=null`
- parent umbrella: `planned / revision 5 / claim=null`

Guardrail 준수:

- reset 없음
- checkout 없음
- clean 없음
- revert 없음
- unrelated delete 없음
- commit / push 없음
- deploy / runtime apply 없음
- provider install 없음
- Managed MCP update 없음
- 새 제품 구현 없음

Reviewer가 제품 source를 변경하지 않았고, 이번 re-review 결과 Markdown만 추가한다.

---

## 3. Previous blocker: precedence independent verification

Current source `src/application/code-scope-binding.ts`의 `bindingState()`를 직접 확인했다.

현재 실행 순서는 다음과 같다.

1. cached graph가 없으면 `unindexed`
2. persisted exact `codeNodeId`가 존재하고 canonical identity도 동일하면 즉시 `active`
3. stored canonical identity와 일치하는 current candidate를 모두 계산
4. canonical candidate가 정확히 1개이면 `relinkable / canonical_identity`
5. canonical candidate가 2개 이상이면 즉시 `stale / relink_ambiguous`
6. **canonical candidate가 0개일 때만** file/path/signature anchor fallback 계산
7. fallback candidate가 정확히 1개이면 `relinkable`
8. fallback candidate가 2개 이상이면 `stale / relink_ambiguous`
9. 그 외에는 `target_missing` 또는 `target_identity_changed`

즉 higher-priority canonical ambiguity가 lower-priority fallback으로 해소될 수 없다.

### Required precedence cases

| Case | Fresh result | Evidence |
| --- | --- | --- |
| 1. exact ID + canonical exact | **PASS → active** | initial attach/restart test에서 exact persisted target이 active. source에서도 exact ID + canonical match를 가장 먼저 반환. |
| 2. canonical candidate 1개 | **PASS → canonical relinkable** | moved node 1개 fixture에서 `relink.strategy === canonical_identity`, explicit relink 후 active / revision 2. |
| 3. canonical candidate 2개 이상 + fallback 1개 | **PASS → stale / relink_ambiguous** | prior blocker exact fixture에서 one candidate만 path/signature anchor까지 일치하지만 `state=stale`, `staleReason=relink_ambiguous`, `relink=undefined`. |
| 4. canonical candidate 0개 + fallback 1개 | **PASS → fallback relinkable** | refactored canonical + same path/signature fixture에서 `relink.strategy === path_signature`, explicit relink 후 active / revision 3. |

### Previous blocker exact mutation rejection

Case 3 fixture에서 fresh assertions:

- `higherPriorityAmbiguous.state === "stale"`
- `higherPriorityAmbiguous.staleReason === "relink_ambiguous"`
- `higherPriorityAmbiguous.relink === undefined`
- explicit `scopes.relink(...)` throws `no unique relink target`

`relink()` source도 view가 `relinkable`이 아니거나 unique `view.relink`가 없으면 mutation 전에 `code_scope_relink_unavailable`을 throw한다.

따라서 이전 FAIL blocker는 current source에서 독립적으로 해소되었음을 확인했다.

---

## 4. Persistent stale/relink lifecycle acceptance

### Conservative fallback anchors

Attach 시 다음 optional anchor가 persistent binding에 저장된다.

- `codeKind`
- `codeLanguage`
- `codePath`
- `codeSignature`
- `codeName`

Fallback은 fuzzy name/nearest-symbol 추측을 하지 않는다.

- common filter: exact path + compatible kind/language
- file: exact file path candidate만 `file_path`
- non-file symbol: exact signature까지 일치해야 `path_signature`

### Existing DB migration

SQLite initialization은 `PRAGMA table_info(task_code_scope_bindings)`로 existing columns를 읽고 missing anchor column만 `ALTER TABLE ... ADD COLUMN`한다.

Fresh independent legacy-schema probe에서 anchor column이 전혀 없는 pre-Phase-6 형태의 temp `task_code_scope_bindings` table을 만든 뒤 current `SqliteQuestBoardRepository`로 reopen했다.

Result:

`legacy-anchor-migration: PASS code_kind,code_language,code_path,code_signature,code_name`

### Read-only candidate calculation

Restart/relink regression에서 read가 candidate를 계산한 뒤에도 persisted fields는 unchanged였다.

- old `codeNodeId` 유지
- old `codeCanonicalIdentity` 유지
- Task title/status 보존

즉 단순 조회가 persistent target을 자동 이동시키지 않는다.

### Explicit relink mutation

Current source/repository에서 fresh 확인:

- optional requestId → normal mutation receipt/idempotency boundary
- `expectedRevision` → revision CAS
- actor/provider audit 갱신
- revision +1
- same Task/kind/target collision fail-closed
- unique relink target이 없으면 mutation 거부
- Task 자체는 relink 실패/target loss 때문에 삭제 또는 재생성되지 않음

Focused test에서도 ambiguous relink 실패 뒤 canonical Task title이 그대로 유지됨을 확인했다.

---

## 5. Shared surface acceptance

Persistent CodeScope relink semantics는 하나의 `CodeScopeBindingService`를 기준으로 공유된다.

Fresh source/test 확인:

- Agent tool: `questboard_relink_task_code_scope`
- MCP catalog/dispatch: same shared agent tool
- HTTP: `POST /code-scope-bindings/:bindingId/relink` → same service `relink()`
- Web: Task drawer의 `relinkable` binding에만 Relink action 노출, same HTTP route 사용

`tests/code-scope-binding.test.ts`의 agent/MCP/HTTP parity test가 fresh focused run에서 PASS했다.

Actual SCIP browser E2E는 synthetic old persistent ID로 relinkable state를 만든 뒤 browser Task drawer에서 `Relink`을 눌러 actual current SCIP node ID로 active 복구하는 경로까지 fresh PASS했다.

---

## 6. Ephemeral Agent Focus acceptance

Current `src/application/agent-focus.ts`를 직접 확인했다.

`AgentFocusService` state는 process-memory `Map`이며 SQLite table에 저장되지 않는다. Repository는 project/task validation에만 사용된다.

Verified properties:

- project/session scoped
- project별 최신 session 최대 20개 read
- new `AgentFocusService` instance에는 이전 focus 없음
- Claim 아님
- authorization/grant 아님
- Task Activity write 없음
- Resume Capsule field 아님
- canonical work history에 포함되지 않음

Fresh full regression에서 다음 두 test가 PASS했다.

- `Agent Focus is ephemeral, session-scoped, and never writes Task Activity`
- `agent and HTTP surfaces share the same ephemeral Agent Focus state`

### Watching / Follow / Free / Return to agent

Current Web source에서 직접 확인:

- polling: 1500 ms
- single timer guard 존재
- focus display: `Watching · <session>`
- Follow mode에서만 `changed && mode === follow`일 때 자동 navigation
- Free에서는 agent focus update가 화면을 강제로 이동시키지 않음
- Return to agent는 최신 focus로 one-shot 이동
- current project와 focus project가 다르면 apply하지 않음
- navigation priority: CodeScope → Work Group / Flow Node → Task

Actual SCIP headless Chrome E2E가 Watching → Follow → exact `createQuestBoardHttpServer` Code inspector → Free → Quest 이동 → Return to agent → same CodeScope 복귀를 fresh하게 통과했다.

Responsive source/contract도 확인했다.

- <=1024px focus status max width 제한
- <=720px focus status를 더 축소하고 control은 bounded
- full Web contract / responsive regression PASS

이번 independent re-review에서 별도 physical iPad Safari를 직접 조작하지는 않았다. 따라서 physical-device fresh PASS라고 과장하지 않는다. iPad/mobile acceptance는 source/contract regression 및 headless browser path 수준에서 PASS다.

---

## 7. Fresh verification results

### A. Precedence / CodeScope focused regression

Fresh command:

`npm run build && node --test dist/tests/code-scope-binding.test.js`

Result:

- tests: 6
- pass: 6
- fail: 0
- skipped: 0

특히 previous blocker exact combination `canonical=2 + fallback=1`의 stale/ambiguity/explicit rejection assertion이 포함되어 실제로 PASS했다.

### B. Full regression + race

Fresh command:

`npm run verify`

Result:

- typecheck: PASS
- Web syntax: PASS
- Node tests: **173/173 PASS**
- fail: 0
- skipped: 0
- actual SCIP/headless Chrome E2E: PASS
- race gate: PASS

Race gate에서 fresh 확인된 내용:

- concurrent Claim: one winner, one `claim_conflict`
- strict expectedRevision race: one apply, one `revision_conflict`
- lockless Task updates: both sequentially applied, revision advanced 2 → 3

### C. Actual SCIP + headless Chrome standalone

Fresh standalone command:

`node --test dist/tests/code-map-sync-actual-scip-e2e.test.js`

Result:

- tests: 1
- pass: 1
- fail: 0
- skipped: 0

This test uses actual `scip-typescript`, launches headless Chrome with CDP, and exercises Flow/Code sync, Agent Follow/Free/Return, real CodeScope navigation, browser relink, and MCP/HTTP parity.

### D. `git diff --check`

Fresh command completed exit 0 with no output.

Result: PASS.

---

## 8. External ChatGPT2Codex read-only dogfood

Worker의 과거 dogfood 수치나 dirty baseline을 현재 사실로 재사용하지 않았다. Current external fixture를 fresh하게 읽고 temp-only state로 dogfood를 다시 실행했다.

Fixture:

- projectId: `chatgpt2codex`
- root: `<CHATGPT2CODEX_REPO>`
- branch before: `docs/windows-install-refresh`
- HEAD before: `49d34c44d2e158965062552e40ef1ce9b98c89e0`
- staged before: 0
- current dirty before: 4 files
  - `src/exec/mobile-approval.ts`
  - `src/runtime/tool-progress.ts`
  - `src/server/connection-recovery-classification.ts`
  - `src/server/tools.ts`

모든 QuestBoard DB 및 SCIP generated state는 temp directory에 만들었고 external source checkout은 read-only로 사용했다.

Fresh current index measurement:

- files: **540**
- raw nodes: **20,478**
- raw relations: **47,712**
- representative symbol: `scanWorkspace`
- source: `src/workspace/registry.ts`

Fresh scenario:

1. actual current ChatGPT2Codex source를 SCIP로 index
2. real `scanWorkspace` symbol을 exact path와 함께 unique하게 찾음
3. real symbol에 persistent Task↔CodeScope binding attach → active
4. persistent `codeNodeId`만 synthetic pre-refactor ID로 변경하고 canonical identity/anchors 유지
5. read → `relinkable / canonical_identity`
6. candidate exact current node가 real `scanWorkspace` node임을 확인
7. explicit relink → active
8. relink revision: **3**
9. Agent Focus publish 후 Task Activity 증가 없음, Resume에 focus 없음, new AgentFocusService에서 focus 없음
10. temp DB/SCIP state cleanup

Result:

- dogfood: **PASS**
- candidate strategy: `canonical_identity`
- relink active revision: 3
- focus ephemeral: true

After status:

- branch: `docs/windows-install-refresh` — unchanged
- HEAD: `49d34c44d2e158965062552e40ef1ce9b98c89e0` — unchanged
- staged: 0 — unchanged
- dirty files: same 4 files — unchanged

따라서 independent re-review가 external fixture source를 변경하지 않았음을 확인했다.

Worker handoff의 과거 index 수치 `20,466 / 47,685`와 이번 fresh current 수치가 다른 것은 external repository가 그 이후 다른 작업으로 변경된 current baseline이기 때문이다. 이번 판정은 current live fixture의 fresh 수치와 before/after integrity를 기준으로 한다.

---

## 9. Phase 1~6 / parent umbrella gate

Fresh live state 확인 결과:

| Slice | Live state |
| --- | --- |
| Phase 1 | done |
| Phase 2 | **review / revision 12** |
| Phase 3 | done |
| Phase 4 | done |
| Phase 5 | done |
| Phase 6 | **done / revision 6** |

Parent umbrella:

- Task: `eb27a868-3aae-48fa-be66-a323925b144d`
- current status: `planned`
- revision: 5

Phase 2가 아직 independent acceptance/Done 상태가 아니므로 umbrella 종료 조건을 만족하지 않는다.

따라서 parent umbrella는 **전환하지 않았다.**

---

## 10. Final verdict

**PASS / ACCEPTED**

Previous FAIL의 핵심 blocker인 canonical ambiguity precedence는 current source와 exact regression으로 독립적으로 수정 완료를 확인했다. Higher-priority canonical ambiguity는 lower-priority fallback으로 절대 해소되지 않으며 explicit relink mutation도 거부된다.

Phase 6 전체 stale/relink lifecycle, persistent anchors/migration, CAS/idempotency/audit, Task preservation, shared Agent/MCP/HTTP/Web semantics, ephemeral Agent Focus, Follow/Free/Return UX, actual SCIP/headless Chrome, external real-work dogfood, race gate, full regression, diff-check가 fresh verification에서 모두 acceptance를 통과했다.

따라서 Phase 6 Task를 **Done / revision 6**으로 전환했다.

Phase 2는 여전히 **review / revision 12**이므로 parent umbrella는 닫지 않았다.

새 구현은 시작하지 않았다.
