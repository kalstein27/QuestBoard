# QuestBoard Phase 6 Blocker Fix Result

작성일: 2026-09-29 (Asia/Seoul)

## 1. 배경

Phase 6 independent review는 `canonical identity ambiguity + unique lower-priority fallback` 조합에서 fail-closed가 깨지는 blocker를 발견해 FAIL 처리했다.

문제 조건:

- `canonical.length > 1`
- `anchored.length === 1`
- 기존 구현: lower-priority fallback 1개를 `relinkable`로 반환
- 요구 계약: higher-priority canonical ambiguity가 발생한 즉시 `stale / relink_ambiguous`

Phase 6 Task는 review / rev4에 유지됐고 parent umbrella도 닫히지 않았다.

## 2. 수정

`src/application/code-scope-binding.ts`의 `bindingState()` 우선순위를 수정했다.

현재 순서:

1. exact node ID + exact canonical identity => `active`
2. canonical identity candidate exactly 1 => `relinkable / canonical_identity`
3. canonical identity candidate > 1 => 즉시 `stale / relink_ambiguous`
4. canonical candidate가 0일 때만 path/signature 또는 file-path fallback 평가
5. fallback exactly 1 => `relinkable`
6. fallback > 1 => `stale / relink_ambiguous`
7. evidence 없음 => 기존 stale reason 유지

따라서 higher-priority semantic ambiguity는 lower-priority evidence로 우회될 수 없다.

## 3. Regression gap 보완

`tests/code-scope-binding.test.ts`에 reviewer가 지적한 정확한 조합을 추가했다.

fixture:

- persisted binding canonical identity와 동일한 current node 2개
- 그중 하나만 persisted exact path + signature anchor와 일치
- 다른 하나는 다른 path/signature

검증:

- state = `stale`
- staleReason = `relink_ambiguous`
- `relink` candidate 없음
- explicit relink mutation도 `no unique relink target`으로 거부

즉 `canonical.length === 2 && anchored.length === 1`가 직접 회귀 테스트로 고정됐다.

## 4. Fresh verification

### Blocker targeted

`npm run build && node --test dist/tests/code-scope-binding.test.js`

- 6/6 PASS
- fail 0
- skipped 0

### Full

`npm run verify && git diff --check`

- typecheck PASS
- Web syntax PASS
- Node tests: **173/173 PASS**
- fail 0
- skipped 0
- actual SCIP + headless Chrome E2E PASS
- multi-worker claim/revision race PASS
- `git diff --check` PASS

## 5. Repository guardrails

- branch: `main`
- HEAD unchanged: `87c34f743fffad39c3c19c7a5bf88b6314aba022`
- staged: 0
- cumulative intentional dirty tree preserved
- reset / checkout / clean / revert / unrelated delete 없음
- commit / push / deploy / runtime apply / provider install / Managed MCP update 없음

## 6. Review state

이 수정은 구현 worker의 blocker remediation이며 self-acceptance가 아니다.

Phase 6는 independent re-review 전까지 `review` 상태를 유지한다.

Reviewer는 특히 다음을 fresh하게 확인해야 한다.

- canonical ambiguity check가 fallback 계산보다 먼저 종료되는지
- `canonical > 1 + fallback == 1`가 stale/ambiguous인지
- canonical == 0일 때 기존 unique fallback은 여전히 relinkable인지
- canonical == 1일 때 canonical strategy가 우선하는지
- full Phase 6 Agent Focus / relink acceptance가 회귀하지 않았는지
- fresh full verify / actual SCIP / race / diff-check

Phase 2가 별도로 아직 review라면 Phase 6가 PASS하더라도 parent umbrella는 Phase 1~6 전체 live 상태를 확인하기 전까지 닫지 않는다.
