# QuestBoard Phase 6 Independent Re-review Handoff

작성일: 2026-09-29 (Asia/Seoul)

## 역할

이 문서는 Phase 6 independent review에서 발견된 blocker 수정 후, 구현 worker와 분리된 새 reviewer가 remediation만 믿지 않고 current live source를 fresh하게 재검증하도록 하기 위한 handoff다.

## Canonical inputs

반드시 직접 읽을 것:

- `docs/PHASE-6-INDEPENDENT-REVIEW-RESULT.ko.md`
- `docs/PHASE-6-BLOCKER-FIX-RESULT.ko.md`
- `docs/PHASE-6-IMPLEMENTATION-RESULT.ko.md`
- current live Phase 6 QuestBoard Task
- current repo / HEAD / dirty diff

Worker 문서는 증거 목록일 뿐 정답이 아니다.

## Repository

- projectId: `questboard`
- root: `<QUESTBOARD_REPO>`
- branch: `main`
- baseline HEAD: `87c34f743fffad39c3c19c7a5bf88b6314aba022`
- cumulative intentional dirty tree 보존

금지:

- reset / checkout / clean / revert / unrelated delete
- commit / push / deploy
- runtime apply / provider install / Managed MCP update
- 새로운 후속 구현 시작

## Previous blocker

Independent review가 확인한 blocker:

`bindingState()`에서 higher-priority canonical identity가 ambiguous해도 lower-priority fallback candidate가 1개이면 fallback을 `relinkable`로 선택할 수 있었다.

정확한 실패 조합:

- `canonical.length > 1`
- `anchored.length === 1`

요구 계약:

- canonical ambiguity가 확인되는 순간 즉시 `stale / relink_ambiguous`
- lower-priority fallback을 평가/선택하지 않음

## Worker remediation claim

현재 worker는 source를 다음 순서로 변경했다고 보고한다.

1. exact ID + canonical exact => active
2. canonical exactly 1 => canonical relinkable
3. canonical > 1 => immediate stale / relink_ambiguous
4. canonical == 0일 때만 fallback 계산
5. fallback 1 => relinkable
6. fallback > 1 => stale / relink_ambiguous

또한 `canonical == 2 && fallback == 1` exact regression을 추가했다고 보고한다.

이 claim을 직접 source/test로 확인해야 한다.

## Mandatory blocker re-review

최소 다음 4개 precedence case를 fresh하게 검증해라.

### A. exact active

- same node ID
- same canonical identity
- expected: active

### B. unique canonical

- exact target 없음/identity drift
- canonical identity 후보 정확히 1개
- fallback 상황이 존재하더라도 canonical candidate가 우선
- expected: relinkable / canonical_identity

### C. canonical ambiguous + fallback unique

- canonical identity 후보 2개 이상
- persisted path/signature fallback에는 정확히 1개만 일치
- expected: stale / relink_ambiguous
- relink candidate 없음
- explicit relink mutation 거부

이게 이전 blocker의 핵심 acceptance다.

### D. canonical absent + fallback unique

- canonical identity 후보 0
- exact path + kind/language + signature 또는 file-path 후보 1개
- expected: relinkable via fallback

즉 blocker를 고치면서 fallback 자체를 죽이지 않았는지도 확인해야 한다.

## Broader Phase 6 regression

blocker 외에도 Phase 6 acceptance가 그대로 유지되는지 fresh 확인해라.

- SQLite anchor migration
- CAS / revision / idempotency / audit
- Task preservation on target loss/relink failure
- Agent/MCP/HTTP/Web relink parity
- Agent Focus process-memory only
- Focus가 Claim / authorization / Task Activity / Resume / SQLite durable history와 분리
- Watching / Follow / Free / Return to agent
- Free mode에서 agent update가 화면을 steal하지 않음
- responsive/iPad contract
- actual SCIP + headless Chrome E2E
- race gate
- `git diff --check`

## Mandatory commands

Fresh하게 최소:

- blocker-focused CodeScope binding test
- `npm run verify`
- actual SCIP/headless Chrome test가 full verify에서 실제 PASS인지 확인
- `git diff --check`

Worker reported baseline after fix:

- blocker targeted: 6/6 PASS
- full Node tests: 173/173 PASS
- skipped: 0
- actual SCIP/headless Chrome PASS
- race PASS
- diff-check PASS

직접 재실행하지 않은 항목은 PASS라고 쓰지 마라.

## Live task transition

Re-review 시작 시 Phase 6 Task는 `review` 상태여야 한다.

모든 blocker 및 Phase 6 acceptance가 fresh PASS하면:

- Phase 6를 Done으로 전환

실패하면:

- review 유지
- exact blocker / evidence / Next를 Task에 기록

Parent umbrella는 Phase 2 포함 Phase 1~6 전체 live 상태가 모두 accepted/Done임을 직접 확인한 경우에만 닫는다. Phase 2가 여전히 review라면 umbrella는 닫지 않는다.

## Required result artifacts

반드시:

- `docs/PHASE-6-INDEPENDENT-REREVIEW-RESULT.ko.md`
- `/mnt/data/QuestBoard_Phase6_Independent_Rereview_Result.md`

두 곳에 결과를 남긴다.
