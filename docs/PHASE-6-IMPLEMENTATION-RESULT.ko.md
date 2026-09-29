# QuestBoard Phase 6 구현 결과

작성일: 2026-09-29 (Asia/Seoul)

## 1. Worker 결론

Phase 6 구현 worker 기준 acceptance는 모두 통과했다.

- Task: `Code-aware 6/6: stale/relink lifecycle + Agent Follow + real-work E2E`
- 구현 worker 판정: 구현 완료 / 독립 리뷰 대기
- worker는 제품 source를 수정했으므로 스스로 Done 처리하지 않는다.
- Phase 6는 independent review로 넘긴다.
- 다음 새 구현은 시작하지 않는다.

## 2. Repository 기준 상태

- projectId: `questboard`
- root: `<QUESTBOARD_REPO>`
- branch: `main`
- HEAD: `87c34f743fffad39c3c19c7a5bf88b6314aba022`
- upstream: `origin/main`
- staged: 0
- 기존 Phase 3~5 intentional dirty tree를 그대로 보존했다.
- reset / checkout / clean / revert / unrelated delete 없음
- commit / push / deploy / runtime apply / provider install / Managed MCP update 없음

## 3. Persistent Task↔CodeScope stale/relink lifecycle

기존 Phase 4 binding은 exact node ID + canonical identity만 비교해 `active / stale / unindexed`를 판정했다.

Phase 6에서는 조회 시 자동으로 persistent target을 바꾸지 않으면서 conservative relink candidate를 계산한다.

상태:

- `active`
- `relinkable`
- `stale`
- `unindexed`

### 후보 순서

1. **exact stable target**
   - 기존 `codeNodeId`가 존재하고 `canonicalIdentity`도 동일하면 즉시 active.

2. **unique canonical identity**
   - 기존 ID가 사라졌어도 old `codeCanonicalIdentity`와 정확히 같은 node가 현재 graph에 하나뿐이면 `relinkable`.
   - strategy: `canonical_identity`.

3. **unique file/path anchor fallback**
   - attach 시점에 저장한 language/kind/path/signature anchor를 사용한다.
   - file node는 exact path + compatible kind/language가 하나뿐일 때 `file_path`.
   - symbol node는 exact path + compatible kind/language + exact signature가 하나뿐일 때 `path_signature`.

4. **ambiguity / no evidence**
   - 후보가 복수이면 `stale / relink_ambiguous`.
   - 후보가 없으면 기존 `target_missing` 또는 `target_identity_changed`.
   - fuzzy name similarity, nearest symbol, guessed relation은 사용하지 않는다.

### Persistence anchor

TaskCodeScopeBinding에 attach 당시 다음 optional anchor를 저장한다.

- `codeKind`
- `codeLanguage`
- `codePath`
- `codeSignature`
- `codeName`

기존 DB는 migration에서 missing column만 안전하게 추가한다.

### Explicit relink mutation

조회는 candidate만 보여주며 persistent binding을 바꾸지 않는다.

실제 변경은 명시적 `relink` mutation만 수행한다.

- normal requestId/idempotency 경계
- revision/CAS
- actor/provider audit
- revision +1
- 동일 Task/kind/target collision fail-closed
- candidate가 unique하지 않으면 mutation 거부
- Task 자체는 삭제/변경하지 않음

공유 surface:

- agent/MCP: `questboard_relink_task_code_scope`
- HTTP: `POST /code-scope-bindings/:bindingId/relink`
- Web Task drawer: `relinkable` direct binding에만 `Relink`

## 4. Ephemeral Agent Focus

새 `AgentFocusService`는 canonical work history와 완전히 분리된 process-memory state다.

최소 필드:

- `projectId`
- `sessionId`
- `taskId?`
- `workGroupId?`
- `flowNodeId?`
- `codeScopeId?`
- `updatedAt`

특성:

- SQLite persistence 없음
- 새 service/process에서는 빈 상태
- Claim이 아님
- authorization/grant가 아님
- Task Activity에 기록하지 않음
- Resume Capsule에 포함하지 않음
- tool call/history를 자동 기록하지 않음
- project별 최대 20개의 최근 session focus만 메모리에서 조회

공유 surface:

- `questboard_get_agent_focus`
- `questboard_set_agent_focus`
- `questboard_clear_agent_focus`
- `GET/POST/DELETE /projects/:projectId/agent-focus`

## 5. Watching / Follow / Free / Return to agent UX

Web toolbar에 minimal Agent Focus control을 추가했다.

기본 모드는 **Free**다.

- **Watching**: agent focus signal이 존재함을 표시한다.
- **Follow**: 새로운 focus timestamp가 들어올 때만 자동 이동한다.
- **Free**: agent가 focus를 계속 갱신해도 사용자의 현재 화면을 강제로 이동하지 않는다.
- **Return to agent**: Free 상태에서 최신 focus 위치로 한 번 이동한다.

polling:

- 1.5초 간격
- current project의 ephemeral focus만 읽음

이동 우선순위:

1. `codeScopeId` → exact Code node
2. `workGroupId / flowNodeId` → Flow
3. `taskId` → Quest Task

Phase 5의 derived Flow focus/lens를 재사용하며 Flow membership이나 Code binding을 focus 때문에 수정하지 않는다.

## 6. Targeted lifecycle / focus verification

Fresh targeted command:

`npm run build && node --test dist/tests/code-scope-binding.test.js dist/tests/agent-focus.test.js && npm run check:web`

결과:

- 8/8 PASS
- fail 0
- skip 0
- Web syntax PASS

검증 내용:

- repository restart 후 binding 유지
- reindex 전 unindexed
- read-only relink candidate 계산이 persisted identity를 수정하지 않음
- unique canonical identity relink
- unique path+signature fallback relink
- ambiguous fallback stale/fail-closed
- explicit relink revision 증가
- Task preservation
- Agent Focus session isolation
- focus set/clear
- focus가 Activity를 늘리지 않음
- focus가 Resume Capsule에 들어가지 않음
- 새 AgentFocusService에서 이전 focus가 사라짐
- Agent / HTTP 동일 focus state

## 7. Actual SCIP + headless Chrome acceptance

Fresh actual QuestBoard source SCIP E2E:

- Code Map technical explorer 유지
- 기존 Phase 4/5 Flow↔Code behavior 유지
- 실제 `createQuestBoardHttpServer` raw CodeScope 사용
- 실제 visual Flow Group + child Task binding 사용

Phase 6 browser acceptance:

1. server-side Agent Focus를 real CodeScope/Task/Group에 publish
2. browser에서 `Watching · actual-scip-agent` 확인
3. `Follow` 선택
4. exact `createQuestBoardHttpServer` Code inspector로 이동
5. `Free` 선택 후 Quest로 이동
6. `Return to agent`로 같은 exact CodeScope 복귀
7. existing real binding의 persistent ID만 pre-refactor synthetic ID로 변경
8. canonical identity / anchors는 실제 symbol evidence 그대로 유지
9. Task drawer에서 `relinkable` + `Relink` 확인
10. Relink 클릭
11. exact actual SCIP node ID로 active 복구
12. 기존 Phase 5 Group↔Flow↔Code, Code→Flow Item focus, Code Map sync, MCP/HTTP parity 계속 PASS

focused actual browser set:

- 13/13 PASS
- fail 0
- skip 0

## 8. External ChatGPT2Codex read-only dogfood

Fixture:

- root: `<CHATGPT2CODEX_REPO>`
- branch: `docs/windows-install-refresh`
- HEAD: `49d34c44d2e158965062552e40ef1ce9b98c89e0`

중요: fixture는 실행 전부터 unrelated work 때문에 clean이 아니었다.

baseline:

- dirty: `src/runtime/tool-progress.ts` 1개
- staged: 0

모든 QuestBoard DB / SCIP generated state는 temp path에 생성했고 fixture source는 수정하지 않았다.

fresh actual index:

- files: **540**
- raw nodes: **20,466**
- raw relations: **47,685**
- representative real symbol: `scanWorkspace`
- path: `src/workspace/registry.ts`

실제 검증:

- real symbol binding 생성
- persistent node ID를 synthetic pre-refactor ID로 변경
- unique `canonical_identity` candidate 확인
- explicit relink
- active 복구
- relinked revision: 3
- Agent Focus publish
- Task Activity 증가 없음
- Resume Capsule에 Agent Focus 없음
- 새 AgentFocusService에 focus 없음

fixture after:

- branch/HEAD unchanged
- dirty exactly `src/runtime/tool-progress.ts` 1개
- staged 0

즉 baseline dirty set 자체가 전후 동일했다.

## 9. Full regression

Fresh final command:

`npm run verify && git diff --check`

결과:

- typecheck: PASS
- Web syntax: PASS
- Node tests: **173/173 PASS**
- fail: 0
- skipped: 0
- actual SCIP/headless Chrome E2E: PASS
- multi-worker claim/revision race: PASS
- `git diff --check`: PASS

## 10. Independent review focus

독립 reviewer는 최소 아래를 fresh하게 다시 확인해야 한다.

1. current Phase 6 Task / repo / HEAD / dirty baseline
2. anchor columns가 existing DB migration을 안전하게 통과하는지
3. exact target active semantics가 유지되는지
4. unique canonical identity만 relinkable인지
5. fallback이 exact file/path + signature/kind/language 기반인지
6. ambiguous candidate가 stale로 남고 mutation이 거부되는지
7. 조회가 자동으로 persisted binding을 바꾸지 않는지
8. explicit relink가 CAS/idempotency/audit/revision을 지키는지
9. Task가 target loss/relink 실패에도 보존되는지
10. Agent/MCP/HTTP/Web surface 의미가 같은지
11. Agent Focus가 process-memory only인지
12. Agent Focus가 claim/auth/Task Activity/Resume에 섞이지 않는지
13. Watching / Follow / Free / Return to agent UX
14. iPad/mobile toolbar/focus control이 bounded하게 유지되는지
15. actual SCIP/headless Chrome E2E
16. external ChatGPT2Codex read-only dogfood와 baseline dirty integrity
17. fresh full verify/race/diff-check

## 11. Worker final state

Worker evidence는 모두 green이다.

제품 source를 변경한 worker가 스스로 Phase 6를 Done으로 전환하지 않는다.

Canonical handoff:

`docs/PHASE-6-INDEPENDENT-REVIEW-HANDOFF.ko.md`

Independent reviewer가 PASS할 경우에만 Phase 6를 Done으로 전환한다.

Phase 6는 6/6 final slice이므로 reviewer는 Phase 1~6 전체가 모두 accepted인지 확인한 후에만 parent/umbrella Task 종료 여부를 결정한다.

새 Phase나 후속 구현을 자동 시작하지 않는다.

최종 live QuestBoard Task 상태:

- status: `review`
- revision: `4`
- claim: null
