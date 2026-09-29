# QuestBoard Phase 4 독립 리뷰 결과

- 리뷰 일시: 2026-09-29 KST
- 리뷰 역할: independent reviewer
- 최종 판정: **PASS**
- Phase 4 최종 상태: **Done**
- Phase 4 Task: `82505848-0988-4be6-ae56-1f1c4e051943`
- Task revision: `3 (review) → 4 (done)`
- 검증 기준 branch / HEAD: `main` / `87c34f743fffad39c3c19c7a5bf88b6314aba022`
- upstream: `origin/main`, 시작 시 ahead 0 / behind 0
- 리뷰 시작 시 staged: 0
- 리뷰 시작 시 dirty files: 35

## 1. 결론

Phase 4 acceptance를 worker/handoff의 주장과 독립적으로 현재 source, live QuestBoard Task, SQLite persistence 경계, adapter wiring, 실제 테스트 및 실제 SCIP/headless browser E2E로 재검증했다.

**Blocker 0 / Major 0 / Minor 0.**

Phase 4의 핵심 계약인 persistent vendor-neutral `Task ↔ CodeScope` binding, exact identity 기반 lifecycle, many-to-many cardinality, transactional create-Task+binding, Agent/MCP/HTTP parity, Code/Quest 양방향 UX, canonical Task hierarchy 기반 Work Group Related Tasks 및 descendant CodeScope aggregation이 현재 source에서 일관되며 fresh 검증을 통과했다.

따라서 live Phase 4 Task를 strict CAS (`expectedRevision=3`)로 `review → done` 전환했다. 최종 revision은 `4`다.

Phase 5는 **시작하지 않았다**. 다음 canonical Task는 읽기만 했다.

## 2. 리뷰 기준 및 guardrail 준수

먼저 `docs/PHASE-4-INDEPENDENT-REVIEW-HANDOFF.ko.md`를 직접 읽었지만, handoff와 worker result는 절차/검증 목록으로만 사용했다. 실제 판정은 현재 repo/source/live Task와 fresh execution evidence에 기반했다.

리뷰 중 아래 guardrail을 유지했다.

- 기존 intentionally dirty Phase 3+4 tree를 보존했다.
- unrelated 변경을 reset / checkout / clean / revert / delete 하지 않았다.
- commit / push 하지 않았다.
- runtime apply / deploy 하지 않았다.
- provider install 하지 않았다.
- Managed MCP update/reinstall 하지 않았다.
- Phase 5 구현 또는 Task mutation을 하지 않았다.
- Work Group aggregation은 기존 canonical Task hierarchy를 사용하며 별도 code/work hierarchy를 만들지 않았다.

## 3. 시작 시 live 상태

### Repo

- branch: `main`
- HEAD: `87c34f743fffad39c3c19c7a5bf88b6314aba022`
- upstream: `origin/main`
- ahead / behind: `0 / 0`
- staged: `0`
- dirty files: `35`

Phase 4 관련 source/test/Web 변경은 이미 dirty tree에 존재했다. 리뷰는 이를 그대로 보존한 상태에서 수행했다.
리뷰 결과 문서를 작성한 뒤 최종 repo status를 다시 확인했다. HEAD/upstream/staged 상태는 변하지 않았고 dirty files는 `35 → 36`이 되었다. 증가한 1개는 이 리뷰가 새로 생성한 `docs/PHASE-4-INDEPENDENT-REVIEW-RESULT.ko.md`뿐이다.


### Canonical QuestBoard Task

리뷰 시작 시 Phase 4 Task는:

- status: `review`
- revision: `3`
- claim: `null`

이었다.

### Managed QuestBoard 설치 상태

현재 installed Managed QuestBoard revision은 `7a56464b06a74bd755f518cdec9dca1318870b75`로, Phase 4 dirty source보다 이전 설치본이다. 따라서 installed Managed MCP catalog에는 Phase 4 CodeScope mutation tools가 아직 없다.

이 상태는 handoff guardrail의 `Managed MCP update 금지`와 일치한다. Phase 4 source parity는 현재 local source에서 생성되는 Agent/MCP/HTTP 경계와 fresh local E2E로 검증했고, Managed MCP는 live canonical Task 상태를 읽고 CAS-safe하게 전환하는 용도로만 사용했다. 배포 convergence는 이번 리뷰 범위가 아니다.

## 4. Acceptance A: persistence / restart / stale lifecycle

**PASS**

`src/application/code-scope-binding.ts`의 현재 계약을 직접 확인했다.

- binding kind: `targets`, `implemented_in`, `affects`, `investigates`
- persisted identity: project, Task id, raw Code node id, canonical identity, kind, actor/provider, timestamps, revision
- 상태: `active`, `stale`, `unindexed`
- graph가 아직 없으면 `unindexed / code_map_not_indexed`
- raw node id가 사라지면 `stale / target_missing`
- 같은 raw node id라도 canonical identity가 바뀌면 `stale / target_identity_changed`
- raw id + canonical identity가 정확히 일치할 때만 `active`
- fuzzy/semantic/path 기반 자동 재부착 없음

SQLite persistence와 FK도 직접 확인했다.

- `PRAGMA foreign_keys=ON`
- project FK cascade
- task FK cascade
- `(task_id, code_node_id, kind)` unique
- binding revision 유지

기존 suite만으로 문서의 lifecycle 모든 중간 전환이 한 테스트에서 명시적으로 드러나지 않아, 독립 reviewer 전용 일회성 probe를 추가로 실행했다.

결과:

```json
{
  "restart": "unindexed",
  "sameExactReindex": "active",
  "missingTarget": "stale/target_missing",
  "exactRestore": "active",
  "identityChange": "stale/target_identity_changed",
  "sameIdentityDifferentRawId": "stale/target_missing",
  "taskIndependent": true
}
```

즉:

1. binding 저장 후 repository restart, Code Map 미인덱싱 상태에서 `unindexed`
2. 같은 exact node 재인덱싱 후 `active`
3. target 제거 후 `stale/target_missing`
4. exact target 복원 후 `active`
5. 같은 raw id의 canonical identity 변경 시 `stale/target_identity_changed`
6. 같은 semantic-looking identity라도 다른 raw id로 대체하면 자동 relink 없이 기존 binding은 `stale/target_missing`
7. Task 자체는 binding lifecycle과 독립적으로 유지

을 fresh하게 재현했다.

Evidence:

- operation: `bg_c678e53e-3433-4d95-9cb8-c8601353e111`
- output: `out_mum5wy5c_83d51fc56dcf2411`

## 5. Acceptance B: Task-domain independence

**PASS**

`src/core/domain.ts`의 canonical Task에는 provider-specific `filePath`, symbol, class/function 같은 CodeScope 필드가 추가되지 않았다.

CodeScope는 별도 persistent binding layer에 존재한다. binding detach 후에도 Task는 삭제되지 않고 targetless Task로 정상 유지된다. 실제 browser E2E에서도 scoped Task를 detach한 뒤 Task가 유지되고 `No code scope linked yet` 상태가 확인된다.

## 6. Acceptance C: many-to-many / cardinality / CAS

**PASS**

독립 reviewer probe에서 다음을 직접 검증했다.

```json
{
  "sameTaskNodeDifferentKinds": true,
  "manyToMany": true,
  "exactTripleIdempotent": true,
  "staleRevisionDetachRejected": true,
  "taskDeleteCascadesBinding": true,
  "createTaskForScopeRollback": true,
  "bindingCount": 3
}
```

확인 내용:

- 하나의 Task가 여러 CodeScope를 가질 수 있음
- 하나의 CodeScope가 여러 Task에 연결될 수 있음
- 같은 Task/node라도 서로 다른 kind는 공존 가능
- exact `(task,node,kind)` 중복은 새 row를 만들지 않음
- stale revision으로 detach 시도 시 거부
- Task 삭제 시 Task-owned binding FK cascade

Evidence:

- operation: `bg_78df9761-c783-4e25-bf3a-ca1d3ae61593`
- output: `out_mum5xqmo_07b35bf0037e9d87`

## 7. Acceptance D: atomic create Task + binding

**PASS**

`createTaskForScope()`는 repository `runIdempotentMutation`의 한 transaction 경계 안에서 Task 생성과 binding 생성을 수행한다.

SQLite implementation은 outer mutation에서 `BEGIN IMMEDIATE`를 열고 성공 시 COMMIT, 오류 시 ROLLBACK한다. nested mutation은 같은 transaction depth를 재사용한다.

독립 probe에서 binding persistence를 강제로 실패시켰고, Task가 orphan으로 남지 않는 것을 직접 확인했다.

- binding failure 발생
- 생성 중 Task rollback
- before/after Task count 동일
- 실패한 제목의 orphan Task 없음

## 8. Acceptance E: Agent / MCP / HTTP parity

**PASS**

현재 source에서 세 surface가 동일한 `CodeScopeBindingService` semantics를 공유한다.

### Agent

다음 neutral tools가 현재 source에 존재한다.

- list CodeScope bindings
- attach binding
- detach binding
- create Task for scope

### MCP

MCP는 Agent catalog/executor를 공유한다. mutation requestId가 없을 때 MCP가 session + RPC/tool/args 기반 stable automatic requestId를 생성해 exact retry idempotency를 보존한다.

### HTTP

현재 source에는 동일 service를 사용해 다음 경계가 존재한다.

- `GET /projects/:projectId/code-scope-bindings`
- `POST /projects/:projectId/code-scope-bindings`
- `POST /projects/:projectId/code-scope-tasks`
- `DELETE /code-scope-bindings/:id`

Code Map GET payload에도 binding context가 노출된다.

Fresh regression의 `agent, MCP, and HTTP share persistent Task↔CodeScope semantics`가 PASS했다.

중요: installed Managed MCP는 Phase 4 이전 revision이므로 이 새 tools를 live installed catalog에서 검증했다고 주장하지 않는다. 이번 parity 판정은 **현재 Phase 4 source에서 실제 생성되는 MCP boundary + fresh tests/E2E**에 대한 판정이다.

## 9. Acceptance F: Work Group Related Tasks / descendant CodeScope aggregation / actual browser

**PASS**

### Web source semantics

현재 `web/app.js`를 직접 확인했다.

Code inspector의 Related Tasks는 현재 raw Code node의 binding을 읽고 canonical Task hierarchy에서 가장 가까운 Work Group으로 묶는다.

- Related Task row는 실제 canonical Task를 연다.
- Work Group header에서 `Open Group` 가능.
- Work Group drawer는 descendant Task들의 CodeScope를 집계한다.
- descendant binding에는 owning child Task가 표시된다.
- child에서 상속된 binding은 parent drawer에서 직접 detach하지 않고 `Open Task`만 제공한다.
- direct binding만 해당 Task에서 detach 가능하다.
- scope를 모두 떼어도 Task는 1급 entity로 유지된다.

이 집계는 기존 canonical Task hierarchy에서 파생되며 별도 hidden hierarchy를 만들지 않는다.

### Actual SCIP + real headless Chrome/CDP E2E

`tests/code-map-sync-actual-scip-e2e.test.ts`를 직접 읽고 fresh 실행했다.

이 테스트는 mock UI가 아니다.

- 실제 `@sourcegraph/scip-typescript`로 현재 QuestBoard repo 인덱싱
- 실제 raw CodeScope 선택
- 실제 canonical Work Group Task + child Task와 `contains` relation 생성
- child Task에 실제 CodeScope binding
- Chrome/CDP를 실제로 시작
- Chrome이 없으면 skip이 아니라 실패
- Code inspector Related Tasks에서 Work Group grouping 검증
- `Open Group` 후 descendant CodeScope count/owner child 표시 검증
- Code에서 `+ Task` 생성 후 `targets · active` 검증
- 일반 Task drawer 진입 검증
- Detach 후 scoped Task는 targetless로 유지
- 기존 Work Group child binding은 유지
- 기존 Code explorer / Code→Flow sync 경로도 같은 scenario에서 회귀 검증

Fresh `npm test`와 최종 `npm run verify` 모두에서 이 실제 SCIP/headless browser 시나리오가 PASS했다.

테스트 이름:

`actual SCIP indexes 6/5, Web syncs to Investigation, and MCP/HTTP agree`

## 10. Acceptance G: phase boundary

**PASS**

- 기존 Task hierarchy가 Work Group aggregation의 canonical source다.
- Flow visual Work Group, Task hierarchy, Code hierarchy를 하나로 합치지 않았다.
- Phase 4 review 중 Phase 5 구현을 시작하지 않았다.
- Phase 5 Task를 수정하거나 claim하지 않았다.

## 11. Fresh verification 결과

### Fresh `npm test`

- operation: `bg_87725939-5fc5-48f2-911d-6d4b12079fa6`
- output: `out_mum5vzf5_6226e26eb8504c42`
- tests: **167**
- pass: **167**
- fail: **0**
- skipped: **0**

Phase 4 관련 주요 regression 모두 PASS:

- persistent binding restart/unindexed/stale/no-fuzzy
- attach idempotency + atomic createTaskForScope
- Agent/MCP/HTTP parity
- many-to-many + no duplicate exact triple
- rollback on binding failure

### Reviewer lifecycle probe

- PASS
- exact restart/reindex/remove/restore/identity-change/no-fuzzy 전환 직접 재현

### Reviewer cardinality/atomicity probe

- PASS
- many-to-many / multi-kind / exact idempotency / stale-revision reject / FK cascade / rollback 직접 재현

### `git diff --check`

- operation: `bg_68191fc6-1c79-49d2-b08d-064d9278a4a4`
- exit code: **0**
- whitespace error: 없음

### Final `npm run verify`

- operation: `bg_42ed7477-b0ad-4f30-b92a-51bdb9a1444d`
- output: `out_mum5yk5c_8d50e718e3eebad7`
- `npm run typecheck`: PASS
- `npm run check:web`: PASS
- `npm test`: **167/167 PASS, skipped 0**
- actual SCIP/headless Chrome E2E: PASS
- `npm run test:race`: PASS
- stderr: 없음

Race gate에서도 strict revision conflict 및 claim conflict가 예상대로 동작했다.

## 12. Findings / residual risk

### Blocking findings

없음.

### Non-blocking notes

1. Phase 4 구현은 아직 intentionally dirty local tree에 있으며 commit/push되지 않았다. 이번 리뷰 guardrail에 따라 그대로 보존했다.
2. Installed Managed QuestBoard는 Phase 4 이전 revision `7a56464b...`다. Phase 4 source를 live installed runtime으로 publish/converge하는 작업은 이번 독립 리뷰 범위가 아니며 수행하지 않았다.
3. lifecycle 전체 전환은 이번 independent reviewer probe로 직접 재현했다. 기존 committed regression도 restart/unindexed/stale/no-fuzzy 핵심을 보호하지만, 모든 세부 전환을 하나의 전용 permanent test로 표현하는 것은 향후 유지보수 품질 개선 후보일 수 있다. 현재 acceptance blocker는 아니다.

## 13. Live Task 최종 상태

모든 acceptance가 PASS한 뒤 fresh `questboard_get_task`로 revision 3 / review / claim null을 다시 읽고, strict CAS로 다음 변경만 수행했다.

- Task: `82505848-0988-4be6-ae56-1f1c4e051943`
- `expectedRevision`: `3`
- status: `done`
- final revision: `4`
- requestId: `phase4-independent-review-20260929`

Phase 4는 **Done**이다.

## 14. 다음 canonical Task

읽기만 수행했다.

- Task: `ec621b53-d393-40e8-960a-f873419fbd97`
- title: `Code-aware 5/6: Flow + Code lens · Group/Scope aggregation + navigation`
- status: `planned`
- revision: `1`

**Phase 5는 이 리뷰에서 시작하지 않았다.**

## 15. 최종 판정

**PASS · Phase 4 Done**

Persistent Task↔CodeScope binding의 storage/lifecycle/cardinality/atomicity, shared adapter semantics, Work Group Related Tasks 및 descendant aggregation, actual SCIP/headless browser E2E, full regression/race gate까지 fresh independent verification을 통과했다. 현재 확인된 blocker 또는 major defect는 없다.
