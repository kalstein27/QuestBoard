# Code Map persisted snapshot hydration 독립 리뷰 요청

상태: independent review 요청

## 역할

이 문서를 읽는 채팅은 **구현 worker가 아니라 independent reviewer**다.
현재 working tree의 Code Map persisted snapshot hydration 변경을 독립적으로 검토하고, 구현자의 결론을 그대로 신뢰하지 말고 source/diff와 실제 regression/dogfood로 acceptance를 직접 확인한다.

결함이 발견되면 source를 고치지 말고 근거와 재현 절차를 보고한다. 리뷰 결과 문서 작성 외의 source 수정, commit, push, Managed MCP update/deploy는 하지 않는다.

## Git / working tree 기준

리뷰 요청 직전 기준:

- projectId: `questboard`
- root: `<project-root>`
- branch: `main`
- HEAD: `853edc42b0f7e776539aa3f50b1e49aefa73a4c6`
- upstream: `origin/main`
- ahead/behind: `0/0`
- staged: `0`
- 구현 candidate dirty 파일: 12개

구현 candidate 파일:

1. `src/adapters/agent-tools.ts`
2. `src/adapters/code-intelligence/file-inventory.ts`
3. `src/application/code-map-service.ts`
4. `src/index.ts`
5. `src/server/code-map-config.ts`
6. `src/server/http-api.ts`
7. `tests/code-map-explorer-web-contract.test.ts`
8. `web/app.js`
9. `docs/CODE-MAP-PERSISTED-SNAPSHOT-HYDRATION-PLAN.ko.md`
10. `src/adapters/code-intelligence/code-map-persistence.ts`
11. `src/application/code-map-persistence.ts`
12. `tests/code-map-persistence.test.ts`

이 리뷰 요청 문서 자체가 생성된 뒤에는 working tree에 이 문서가 추가되어 dirty 수가 13개로 보이는 것이 정상이다.

절대 reset / checkout / clean / delete / revert로 기존 변경을 없애지 않는다.

## 목표

Managed MCP 업데이트나 QuestBoard service 재시작 때문에 Code Map을 다시 SCIP indexing하지 않도록 한다.

성공한 provider-neutral 최종 `CodeGraphSnapshot`을 `QUESTBOARD_CODE_MAP_STORAGE_ROOT` 바깥 상태에 persist하고 다음 service/process가 이를 hydrate하여 즉시 bounded query / Investigation / Flow 연결에 사용할 수 있어야 한다.

source 변경은 **stale 신호일 뿐 자동 indexing trigger가 아니며**, 실제 provider re-index는 명시적 Refresh / Re-index에서만 실행되어야 한다.

상세 설계 기준은 `docs/CODE-MAP-PERSISTED-SNAPSHOT-HYDRATION-PLAN.ko.md`를 읽는다.

## 반드시 독립 검증할 acceptance

1. fresh index 성공 후 provider-neutral final graph가 external Code Map storage에 persist된다.
2. 새 `CodeMapService` / 새 runtime composition에서 provider `indexProject()` 호출 0회로 persisted graph를 hydrate한다.
3. hydrate 직후 `indexed=true`와 기존 bounded query 결과가 유지된다.
4. source 변경 뒤에도 provider 호출 0회이고 persisted graph는 query 가능하며 `snapshotSource=persisted`, `freshness=stale`, `staleReason=source_changed`가 된다.
5. stale graph에서도 bounded Code Map query와 기존 Investigation/Flow 소비 경로가 동작한다.
6. source 변경 자체로 background/automatic SCIP refresh가 발생하지 않는다.
7. public explicit Refresh / Re-index 경로는 실제 provider indexing을 실행하고 persisted snapshot을 새 graph로 교체한다.
8. explicit refresh 뒤 `snapshotSource=fresh-index`, `freshness=current`로 돌아온다.
9. source manifest 계산 실패는 provider indexing으로 보상하지 않고 persisted graph를 유지하면서 bounded unknown/source_check_failed 상태를 낸다.
10. corrupt snapshot은 daemon/service를 죽이지 않고 hydrate를 거부한다.
11. format/schema/project/root/provider compatibility mismatch와 graph validation failure는 fail-closed다.
12. snapshot/temp/manifest 상태는 project checkout 안에 생성되지 않는다.
13. HTTP / MCP / agent status/query 응답에서 local absolute root path, full manifest, full graph 같은 로컬 민감 상태가 새지 않는다.
14. `npm run verify`와 race/regression이 PASS한다.
15. 실제 restart/update 성격의 process recreation에서 persisted hydration이 provider 실행 없이 재현된다.

## 특히 의심해서 볼 경계조건

- 기존 `CodeMapService.refresh()`의 `changes: []` cache-hit 동작이 **public explicit refresh semantics를 약화시키지 않는지** 확인한다. public Refresh/Re-index는 acceptance 7을 만족해야 한다.
- source manifest가 file set / ignored-directory 규칙을 provider-neutral inventory와 충분히 일치시키는지 확인한다.
- snapshot write가 partial/current 파일을 만들지 않도록 temp + atomic replace 경계를 지키는지 확인한다.
- root identity / provider contract fingerprint가 지나치게 약하거나 지나치게 불안정하지 않은지 확인한다.
- persistence load/parse/source-check 실패가 QuestBoard 전체 기동 실패로 전파되지 않는지 확인한다.
- hydration 시 graph validation과 project/root/provider compatibility 검사가 provider 호출보다 먼저 fail-closed 되는지 확인한다.
- stale 상태를 읽는 status 호출 자체가 provider 실행을 유발하지 않는지 확인한다.
- Web stale UI가 provider-derived graph와 manual relation stale 의미를 혼동하지 않는지 확인한다.
- persist된 graph 안의 absolute `rootPath`가 내부 저장에는 존재하더라도 public bounded status/query 응답으로 새지 않는지 확인한다.
- 기존 12개 candidate 외의 unrelated working-tree 변경이 생기지 않았는지 before/after status를 비교한다.

## 구현 worker가 이미 얻은 증거

이 항목은 참고용이며 reviewer가 독립 재현해야 한다.

### Full verification

리뷰 직전 실행:

```text
npm run verify && git diff --check
```

결과:

- typecheck PASS
- web syntax PASS
- node tests: **183/183 PASS**, fail 0, skipped 0
- actual SCIP E2E PASS
- race gate PASS
- `git diff --check` PASS
- C2CT output ref: `out_mumwatnr_33a58ee58ec2a469`

### Source-change stale / explicit-refresh dogfood

실제 QuestBoard checkout에 고유 임시 `.ts` source를 잠시 추가한 실증 뒤 원상복구했다.

관찰:

- source 변경 후 persisted snapshot hydrate
- `snapshotSource=persisted`
- `freshness=stale`
- `staleReason=source_changed`
- 기존 query matches = 3
- 새 probe는 refresh 전 0
- `index.scip` unchanged = true
- automatic reindex = false
- 명시적 refresh 뒤 새 probe = 1
- `snapshotSource=fresh-index`
- `freshness=current`
- `index.scip` changed = true
- explicit reindex = true
- refresh 후 9,805 nodes / 25,440 relations
- 임시 source 제거 뒤 기존 dirty 12파일 / staged 0 복원 확인
- C2CT output ref: `out_mumw2akd_1f555415165f570c`

## 리뷰 절차 권장

1. fresh `agent_bootstrap(projectId=questboard)`로 현재 상태를 다시 확인한다.
2. `AGENTS.md`, 프로젝트 계획, FOUNDATION, Agent Onboarding, hydration plan을 읽는다.
3. current `repo_status`와 diff를 직접 확인하고 위 12개 candidate + 이 review request 문서 외 변경 여부를 확인한다.
4. persistence contract/store, `CodeMapService`, runtime composition, status surfaces, Web 표시, tests를 source 단위로 검토한다.
5. targeted persistence tests와 full `npm run verify`, `git diff --check`를 독립 실행한다.
6. 가능하면 provider를 실패하도록 둔 새 service/runtime에서 hydrate/query가 성공하는지 직접 확인한다.
7. source change 후 stale/query 가능/provider 실행 0을 직접 확인한다.
8. explicit refresh에서만 provider/index.scip 변화가 생기는지 확인한다.
9. 결과를 `docs/CODE-MAP-PERSISTED-SNAPSHOT-INDEPENDENT-REVIEW-RESULT.ko.md`에 PASS / NEEDS REVISION과 근거로 기록한다.
10. source는 수정하지 않는다. commit/push/deploy도 하지 않는다.

## 완료 판정

**PASS**는 위 acceptance가 source 검토와 독립 실행 증거로 모두 만족될 때만 준다.

하나라도 불명확하거나 위반되면 **NEEDS REVISION**으로 두고, 정확한 파일/코드 경계/재현 절차/기대 동작을 적는다.
