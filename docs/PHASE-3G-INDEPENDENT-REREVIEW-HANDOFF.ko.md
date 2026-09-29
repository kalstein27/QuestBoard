# QuestBoard Phase 3G 독립 재리뷰 인수인계

작성 목적: Phase 3G의 첫 독립 리뷰에서 발견된 bounded/lazy 성능 major finding 수정 후, 새 채팅의 independent reviewer가 구현 채팅의 주장에 의존하지 않고 직접 재검증할 수 있도록 최소한의 canonical 문맥을 전달한다.

## 1. 역할과 범위

이 문서를 읽는 새 채팅은 **implementation worker가 아니라 independent reviewer**다.

구현 채팅의 설명, 기존 PASS 숫자, 아래 handoff 내용을 정답으로 간주하지 말고 반드시 다음을 live로 다시 확인한다.

- C2CT runtime/bootstrap
- QuestBoard canonical Task
- current repo/HEAD/dirty tree
- 관련 source/diff
- fresh targeted tests
- fresh browser/actual SCIP E2E
- 가능하면 full `npm run verify`

리뷰 중 source mutation은 하지 않는다. blocker/major 발견 시 Task를 review에 유지하고 finding만 기록한다.

## 2. 프로젝트

- projectId: `questboard`
- canonical root: `<QUESTBOARD_REPO>`
- branch: `main`
- 마지막 확인 HEAD: `87c34f743fffad39c3c19c7a5bf88b6314aba022`
- upstream: `origin/main`
- 현재 workspace는 의도적으로 dirty 상태다.
- Phase 3E / 3F / 3G 변경이 함께 존재한다.

절대 하지 말 것:

- reset
- checkout
- clean
- revert
- 기존 dirty 변경 삭제/덮어쓰기
- 다른 채팅 lane / lease / operation 건드리기
- commit
- push
- deploy
- runtime apply
- provider install
- managed MCP update

## 3. Canonical Task

- Project UUID: `e8177421-e1d9-4552-9569-4819a0ac981d`
- Phase 3G Task UUID: `42f3b28e-0f49-4816-a504-08572fb25769`
- Title: `Code-aware 3G: Technical Code explorer UI · tree + relation inspector`
- 마지막 확인 상태: `review`
- 마지막 확인 revision: `5`

반드시 live QuestBoard에서 `questboard_get_task`로 다시 읽고 current revision/status를 사용한다.

## 4. Phase 3G 원래 목표

사용자와 agent가 **동일한 raw Code Map**을 보면서 실제 source structure와 relation을 직접 추적할 수 있는 technical Code explorer를 제공한다.

핵심 불변식:

- raw `CodeGraphSnapshot`이 canonical truth다.
- UI가 containment/relation을 임의로 invent하지 않는다.
- file → symbol hierarchy는 실제 raw `contains` fact를 사용한다.
- technical drill-down은 exact raw node ID / canonical identity를 유지한다.
- manual relation은 provider fact와 분리된다.
- stale manual relation은 guessed truth가 아니다.
- coverage gap은 명시적으로 보인다.
- Architecture projection은 optional secondary lens다.
- Flow sync compatibility를 유지한다.
- Code 화면을 IDE/editor나 giant graph canvas로 확장하지 않는다.

## 5. Functional Acceptance

첫 independent review에서 아래 기능 Acceptance 1~4는 PASS였다.

1. file → class/type/function → member/method containment 탐색 및 relation navigation
2. provider가 없는 Swift/Bash/PowerShell 등 파일도 provider-neutral file inventory로 tree에 표시
3. Web UI와 agent/MCP bounded query가 동일한 raw node IDs / canonical identity / relation semantics 사용
4. provider/manual provenance, stale manual wiring, language/provider coverage gap이 UI에 표시

단, **Phase 3G 전체 acceptance는 당시 승인되지 않았다.** 아래 scalability major finding 때문이었다.

## 6. 첫 독립 리뷰 Major Finding

대상: `web/app.js` raw source tree rendering

기존 문제:

- collapsed branch는 descendant DOM을 만들지 않아 lazy collapse 자체는 정상
- 하지만 branch를 expand하면 direct children 전체를 `.forEach(...)`로 한 번에 materialize
- directory와 file/symbol 모두 direct child 수에 상한이 없었음
- symbol child는 이미 메모리에 있는 전체 raw graph의 `contains` index를 직접 사용
- 한 file/class에 direct child가 수천 개라면 한 번 expand로 수천 DOM row 생성 가능

위반한 명시적 불변식:

- `tree lazy expand/virtualization 또는 bounded child loading`
- `symbol drill-down이 bounded query contract를 사용하거나 이에 준하는 제한 유지`

Minor finding:

- coverage text가 `symbolCount/discoveredFileCount`를 `symbol-covered files`라고 표시
- 실제 covered-file count는 `indexedFileCount`

Task는 이 리뷰 후 `review / revision 4`에 유지되었다.

## 7. 구현 채팅이 수정했다고 보고한 내용

아래는 reviewer가 직접 재검증해야 할 **worker claim**이다.

### 7.1 Bounded tree expansion

`web/app.js` raw source tree에 concrete page cap을 적용했다고 보고됨.

- page size: `80`
- root/direct child rendering도 page cap 적용
- directory expansion도 page cap 적용
- file/symbol expansion도 page cap 적용
- collapsed branch는 descendant DOM을 만들지 않음
- 최초 expand에서 최대 80 direct child만 materialize
- 다음 child 묶음은 명시적 `Load more` action으로만 증가
- exact raw node ID와 raw `contains` semantics는 유지

주의:

이 수정은 backend hierarchy query를 새로 호출하는 방식이 아니라 **client-side per-expansion page cap** 방식이다. 재리뷰에서는 이것이 Task의 “bounded child loading 또는 equivalent cap” 요구를 실제로 만족하는지 확인한다.

### 7.2 Large-child regression

`tests/code-map-explorer-web-contract.test.ts`에 large direct-child regression을 추가했다고 보고됨.

worker claim:

- 5,000 direct children fixture
- first page visible count = 80
- remaining = 4,920
- explicit page growth after Load more step only
- second bounded page visibility = 160 total

단순 정규식 존재만 확인하지 말고, 가능하면 실제 실행 결과를 확인한다.

### 7.3 Coverage label fix

`web/app.js` coverage panel이 다음을 사용하도록 수정되었다고 보고됨.

- `indexedFileCount / discoveredFileCount`
- label: `symbol-covered files`

provider registry의 실제 field contract와 일치하는지 확인한다.

### 7.4 Browser E2E 강화

`tests/code-map-sync-actual-scip-e2e.test.ts`를 강화했다고 보고됨.

기존에는 relation 아무거나 이동 후 Back 클릭만 확인했지만, 이제 다음을 fresh browser E2E에서 검증하도록 바뀌었다고 한다.

1. Code view 진입
2. `createQuestBoardHttpServer` 검색
3. exact raw node 선택
4. inspector에서 `src/server/http-api.ts` source 위치 확인
5. `Calls / Called by / References / Referenced by` 계열 중 **다른 `src/` 파일 target** 선택
6. exact target raw node로 이동
7. Back 클릭
8. 원래 inspector title `createQuestBoardHttpServer` 복원 확인
9. 원래 location `src/server/http-api.ts` 복원 확인
10. 기존 Sync to Flow path 계속 정상

cross-file relation selection이 실제로 relation kind/target 조건을 검사하는지 source와 behavior 모두 확인한다.

## 8. 구현 채팅이 보고한 fresh verification

이것 역시 reviewer가 다시 확인해야 할 worker claim이다.

- targeted bounded-tree test: PASS
- actual SCIP + headless Chrome E2E: PASS
- `npm run verify`: PASS
- Node tests: `161/161`
- fail: `0`
- claim-race gate: PASS

구현 채팅은 commit/push/deploy/runtime apply/provider install/managed MCP update를 하지 않았다고 보고했다.

## 9. 이번 재리뷰의 핵심 질문

### A. Major finding이 실제로 닫혔는가

반드시 source 기준으로 확인:

- page size가 explicit constant로 존재하는가
- 한 expand step이 direct children 전체를 즉시 materialize하지 않는가
- 최초 expand가 최대 cap까지만 row를 생성하는가
- cap 초과분은 `Load more` 같은 명시적 action 없이 추가되지 않는가
- directory/file/symbol/root 모두 같은 bounded principle을 지키는가
- recursive descendant가 collapse 상태에서 선행 materialize되지 않는가
- exact raw node ID와 raw contains fact를 보존하는가

중요:

`80 + Load more` 방식 자체가 허용되는지 평가하되, 한 번의 사용자 action이 다시 수천 개를 한꺼번에 붙이는 구조라면 major는 닫힌 것이 아니다.

### B. Large-child test가 의미 있는가

- 5,000 direct child case가 실제 page helper/renderer contract를 검증하는가
- 단지 source regex만 보는 test인지 확인
- first page 80 cap을 behavior로 증명하는지 확인
- page increase도 bounded step인지 확인

### C. Coverage 숫자가 정확한가

- provider registry contract에서 `indexedFileCount`가 semantic symbol-covered file count인가
- UI가 `indexedFileCount/discoveredFileCount`를 사용하고 있는가
- `symbolCount`를 file count처럼 표시하지 않는가

### D. Cross-file navigation + Back이 실제 강화됐는가

- exact raw node ID navigation인가
- fuzzy search로 재탐색하지 않는가
- relation kind가 calls/references 계열인가
- target이 실제 다른 source file인가
- Back 후 original title/location까지 wait/assert하는가

### E. 기존 3G invariants가 수정으로 깨지지 않았는가

- raw graph canonical
- no guessed containment
- no invented relations
- UI / agent semantic parity
- manual/provider provenance separation
- stale manual remains stale
- unsupported-language files visible
- coverage gaps visible
- Architecture lens secondary
- Flow sync compatibility

## 10. 최소 fresh verification

반드시 fresh 실행:

```text
npm run typecheck
npm run check:web
```

그리고 Phase 3G 관련 targeted tests를 fresh 실행한다.

반드시 포함 권장:

- `code-map-explorer-web-contract`
- `code-map-query`
- `code-map-http`
- `code-map-augmentation`
- `code-map-provider-registry`
- `code-map-sync-actual-scip-e2e`

가능하면:

```text
npm run verify
```

worker의 `161/161` 숫자는 증거가 아니라 비교 기준일 뿐이다.

## 11. 리뷰 결과 형식

### Findings

severity:

- blocker
- major
- minor
- none

각 finding마다:

- file/symbol
- 실제 문제
- acceptance 영향
- concrete evidence

### Acceptance matrix

- Acceptance 1: PASS / FAIL
- Acceptance 2: PASS / FAIL
- Acceptance 3: PASS / FAIL
- Acceptance 4: PASS / FAIL
- Bounded/lazy invariant: PASS / FAIL

### Verification evidence

- command
- exit status
- test count
- browser/SCIP evidence

### Residual risks

acceptance를 막지 않는 후속 개선은 분리해서 적는다.

## 12. QuestBoard 상태 전환 규칙

### blocker / major가 남아 있으면

- Task를 `review`에 유지
- current revision을 다시 읽고 CAS-safe update
- Now/Next에 finding과 수정 요구사항 기록
- Done 금지
- 다음 Code-aware phase 시작 금지

### major가 닫히고 전체 acceptance가 PASS면

- independent re-review acceptance를 Task에 기록
- Phase 3G를 `Done`으로 전환 가능
- current live revision을 사용
- Phase 3 parent/umbrella Task를 live로 읽고 canonical next task를 확인
- **다음 Phase 구현은 시작하지 말고 보고만 한다.**

사용자가 별도로 `고고` 해야 다음 구현을 시작한다.

## 13. 결과 파일 기록은 필수

리뷰는 채팅 응답만으로 끝내지 않는다. 최종 판단과 검증 evidence를 반드시 아래 로컬 Markdown 파일에도 남긴다.

`docs/PHASE-3G-INDEPENDENT-REREVIEW-RESULT.ko.md`

결과 파일은 최소한 다음을 포함해야 한다.

- review date
- branch / HEAD
- reviewed Task title / UUID
- 리뷰 시작 시 Task status / revision
- 최종 Task status / revision
- Findings와 severity
- Acceptance matrix
- bounded/lazy invariant 판정
- fresh verification commands와 결과
- actual SCIP / browser E2E evidence
- repository integrity 확인
- commit / push / deploy / runtime apply / provider install / managed MCP update 수행 여부
- QuestBoard 상태 전환 내역
- 확인된 canonical next task와 그 상태
- 다음 구현을 시작하지 않았다는 확인

파일 기록은 **QuestBoard Task 상태 전환까지 완료한 뒤의 최종 상태**를 기준으로 작성한다. 리뷰가 FAIL/HOLD여도 동일하게 결과 파일을 남겨야 하며, finding과 다음 수정 요구사항을 포함한다.

기존 결과 파일이 이미 있으면 내용을 무조건 덮어쓰지 말고 current task/review 목적에 맞는 파일인지 먼저 확인한다. 동일 재리뷰의 최신 결과를 갱신하는 경우에만 안전하게 업데이트한다.

채팅 최종 응답에는 장문의 리뷰를 다시 복제하지 말고, 결과 요약과 위 결과 파일 경로를 명시한다.

## 14. 리뷰어 시작 순서

1. `@C2CT` live bootstrap
2. current repo status / HEAD / dirty tree 확인
3. `questboard_get_task`로 3G Task live read
4. 이 handoff와 live 상태가 다르면 live 상태 우선
5. 관련 source/diff 직접 읽기
6. fresh targeted tests
7. fresh actual SCIP browser E2E
8. 가능하면 full verify
9. 결과에 따라 Task review 유지 또는 Done 전환
10. 결과 파일 `docs/PHASE-3G-INDEPENDENT-REREVIEW-RESULT.ko.md` 작성/갱신
11. parent/next task는 3G Done 후에만 확인하고, 다음 구현은 시작하지 않기

---

이 문서의 목적은 구현 결과를 보증하는 것이 아니라 **검증 시작점을 압축해서 전달하는 것**이다. Reviewer는 handoff의 모든 worker claim을 독립적으로 다시 증명해야 한다.
