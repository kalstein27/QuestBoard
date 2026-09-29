# QuestBoard Phase 3H Independent Review Handoff

작성 목적: 실제 ChatGPT2Codex repository dogfood 중 발견된 Phase 3H correctness 문제를 수정한 뒤, 구현 worker와 분리된 새 채팅이 최종 Phase 3 acceptance를 독립 검증하도록 한다.

## 1. Reviewer role

이 문서를 읽는 채팅은 **implementation worker가 아니라 independent reviewer**다.

다음을 worker claim으로만 취급하고 live 상태/source/behavior로 다시 검증한다.

- 이 handoff 문서
- `docs/PHASE-3H-REAL-WORK-ACCEPTANCE-RESULT.ko.md`
- worker가 보고한 test counts와 실제 repo measurements

리뷰 중 implementation source를 고치지 않는다. blocker/major가 있으면 finding을 기록하고 Phase 3H를 `review`에 유지한다.

## 2. Project and guardrails

QuestBoard:

- projectId: `questboard`
- root: `<QUESTBOARD_REPO>`
- branch: `main`
- worker acceptance HEAD: `87c34f743fffad39c3c19c7a5bf88b6314aba022`
- workspace는 Phase 3E/3F/3G/3H 변경이 함께 있는 의도된 dirty tree다.

Acceptance fixture:

- C2CT projectId: `chatgpt2codex`
- root: `<CHATGPT2CODEX_REPO>`
- expected branch at worker run: `docs/windows-install-refresh`
- expected HEAD at worker run: `49d34c44d2e158965062552e40ef1ce9b98c89e0`
- worker run 전/후 clean이었다.

절대 하지 말 것:

- reset / checkout / clean / revert
- 기존 dirty 변경 삭제/덮어쓰기
- 다른 채팅 lane/lease/operation 조작
- commit / push
- deploy / runtime apply
- provider install
- Managed MCP update
- ChatGPT2Codex fixture source mutation
- Phase 4 구현 시작

ChatGPT2Codex는 read-only acceptance fixture로만 사용하고 temp DB/Code Map storage에서 index한다.

## 3. Canonical Tasks

Phase 3H:

- UUID: `313e25f4-bbd2-4c37-8999-b2da13df1dab`
- title: `Code-aware 3H: ChatGPT2Codex mixed-language real-work acceptance`
- reviewer는 시작 시 `questboard_get_task`로 live status/revision을 다시 읽는다.

Phase 3 parent:

- UUID: `3fbedb9e-731a-45f7-a27a-1b91aed98cd5`
- parent metadata도 live로 읽는다.

Worker 완료 후 의도된 상태는 3H `review`다. handoff보다 live QuestBoard state가 우선한다.

## 4. Worker result to independently re-check

먼저 다음 파일을 직접 읽는다.

`<QUESTBOARD_REPO>/docs/PHASE-3H-REAL-WORK-ACCEPTANCE-RESULT.ko.md`

Worker는 실제 ChatGPT2Codex dogfood에서 두 correctness bug를 발견해 수정했다고 보고했다.

### Fix A: semantic node language recovery

Files:

- `src/application/code-map-hierarchy.ts`
- `tests/code-map-hierarchy.test.ts`

Worker claim:

- SCIP semantic node가 exact `location.path`는 가지지만 language를 생략한 경우 coverage가 TypeScript symbols를 `unknown`으로 잃고 있었다.
- hierarchy materialization에서 **language가 없는 node만** exact source path의 canonical file language 또는 extension inference로 채운다.
- raw node ID/canonical identity/containment/relation/provenance는 변경하지 않는다.
- ChatGPT2Codex-specific architecture rule은 없다.

Reviewer checks:

- annotation이 missing-language node에만 적용되는가
- exact path 기반인가
- supported extension table이 provider-neutral인가
- existing explicit language를 overwrite하지 않는가
- containment/identity/relation을 invent하지 않는가
- unrelated provider facts를 바꾸지 않는가

### Fix B: internal file-inventory provenance excluded from semantic providerIds

Files:

- `src/application/code-map-provider-registry.ts`
- `tests/code-map-provider-registry.test.ts`

Worker claim:

- raw node provenance의 `questboard:file-inventory`가 coverage `providerIds`에 semantic provider처럼 노출됐다.
- capability report에서 legacy `file-inventory` 및 internal `questboard:file-*`만 제외한다.
- raw provenance 자체는 삭제하지 않는다.

Reviewer checks:

- 실제 semantic provider `scip-typescript`가 남는가
- internal file inventory만 capability-provider list에서 제외되는가
- raw graph provenance는 보존되는가
- future legitimate provider ID가 과도하게 걸러지지 않는가

## 5. Actual ChatGPT2Codex acceptance measurements reported by worker

독립 fresh run에서 다시 측정한다. Fixture HEAD가 worker run과 같을 때는 아래 숫자가 합리적으로 재현되는지 확인한다.

### Inventory

- total files: 540
- TypeScript: 315
- JavaScript: 12
- Swift: 3
- Shell: 23
- PowerShell: 20
- C#: 1
- unknown/non-language: 166

Fresh inventory count와 raw file-node count가 동일해야 한다.

At minimum, real Swift/Bash/PowerShell files must appear as file nodes.

### Raw graph

Worker result:

- raw nodes: 20,461
- raw relations: 47,678
- architecture projection nodes: 1
- architecture projection relations: 0

The important acceptance is not the exact macro count itself but that raw navigation remains available even with a nearly-empty compatibility projection.

### TypeScript coverage

Worker result:

- discovered TS files: 315
- semantic-covered files: 137
- semantic symbols: 19,921
- fidelity: `semantic-call`
- providerIds: `["scip-typescript"]`
- gap: `partial_coverage`

Review that `partial_coverage` is truthful rather than treating it as a failure or hiding it.

### Unsupported semantic languages

Worker result:

- Swift: 3 discovered, 0 indexed, `no_trusted_provider_available`, no install option
- Shell: 23 discovered, 0 indexed, same
- PowerShell: 20 discovered, 0 indexed, same

Confirm they remain visible as file-only coverage and are not silently absent.

Do not install providers during review.

## 6. Representative raw identity/query parity

Worker selected real symbol:

- `registerTools`
- `src/server/tools.ts`
- function
- raw ID `code:node:76dfb2290b950e8304249049`
- canonical SCIP identity retained

Worker measured:

- callers: 1
- callees: 20
- references: 20
- referenced-by: 1
- containment parent chain present

Agent query and HTTP `/code-map/query` were asserted to return the same:

- exact selected raw node ID
- parent raw node IDs
- relation ID + target raw node ID sequence

Re-run with the same symbol if fixture HEAD is unchanged, or choose another well-connected real TS symbol if necessary. Exact raw identity/parity matters more than the symbol name.

Also fresh-run the actual SCIP headless-browser E2E that exercises Web technical explorer navigation/Back and Code→Flow compatibility.

## 7. Manual wiring: key review question

Worker mechanically verified on real indexed ChatGPT2Codex endpoints:

- exact from/to raw node IDs
- manual query visibility
- manual provenance separate from provider facts
- raw cached graph excludes manual overlay
- reindex with preserved endpoints keeps manual relation active

Fresh regression suite verifies:

- endpoint removal → stale
- no fuzzy relink
- stale relation excluded from active query facts

However there is one explicit review question:

The worker's real-repo overlay used a relation kind chosen to make the edge unambiguous in bounded query results. It did **not independently prove from source/runtime evidence that the relation itself was a true provider-missed code relation**.

Phase 3H text says `실제 누락된 code-to-code relation 하나를 manual wiring으로 추가`.

Reviewer must decide using evidence, not convenience:

- If the acceptance requires a semantically genuine provider miss, identify one real relation from source/runtime evidence that the provider does not expose, add it only in the temporary acceptance state using exact indexed endpoints, and verify query/reindex behavior.
- If no defensible real provider miss can be established, record a finding and keep Phase 3H in review.
- Do not invent a semantic edge merely to satisfy the test.

This is the most important independent-review focus.

## 8. Required fresh regression verification

At minimum:

- `npm run typecheck`
- `npm run check:web`
- build
- focused Code Map tests covering:
  - hierarchy/language inference
  - provider registry coverage
  - manual augmentation active/stale/restart
  - bounded query parity
  - actual SCIP + headless-browser E2E
- `npm run verify`
- `git diff --check`

Worker baseline after fixes:

- targeted acceptance set: 10/10 PASS
- full Node tests: 161/161 PASS
- claim-race gate: PASS
- actual SCIP headless browser E2E: PASS
- `git diff --check`: PASS

Do not accept these counts without fresh execution.

## 9. Fixture integrity

Before and after real-repo indexing, check ChatGPT2Codex repo status.

Acceptance requires:

- no fixture source mutation
- no new staged/dirty changes caused by review
- generated SCIP/index state must stay outside the fixture repo or in already-ignored/non-mutating locations according to the provider contract

If the fixture is already dirty for unrelated reasons when review begins, record the exact pre-existing state and prove review did not add to it.

## 10. Findings and decision format

Report:

### Findings

severity:

- blocker
- major
- minor
- none

For each finding include:

- file/symbol/scenario
- issue
- acceptance impact
- concrete evidence

### Acceptance matrix

Evaluate at least:

1. real mixed-language file inventory
2. TS raw hierarchy/call/reference navigation
3. unsupported Swift/Shell/PowerShell visibility
4. explicit coverage gaps/provider state
5. install-option semantics/no-provider state
6. genuine manual-wiring acceptance
7. reindex persistence + stale behavior
8. raw graph independence from architecture projection
9. full Quest/Flow/Task/Resume/Code→Flow regressions

### Verification evidence

- commands
- exit statuses
- counts
- actual fixture measurements
- browser evidence
- fixture status before/after

### Residual risks

Keep non-blocking improvements separate from acceptance blockers.

## 11. QuestBoard state transition

If blocker/major or an unmet acceptance criterion remains:

- keep Phase 3H in `review`
- update Now/Next with the finding and required fix/evidence
- keep Phase 3 parent open
- do not start Phase 4

If all Phase 3H acceptance criteria pass:

- record independent acceptance
- transition Phase 3H to `done`
- live-read Phase 3 parent and verify all Phase 3 child acceptance is complete
- transition Phase 3 parent to `done` only if its full acceptance is satisfied
- report the next canonical task/phase only
- **do not start Phase 4 implementation**

Use current live revisions for every mutation.

## 12. Mandatory local review result file + chat-visible attachment

Before the reviewer finishes, it **must write a local Markdown result file**, regardless of PASS/HOLD/FAIL:

`<QUESTBOARD_REPO>/docs/PHASE-3H-INDEPENDENT-REVIEW-RESULT.ko.md`

The file must contain at minimum:

- date
- QuestBoard branch/HEAD
- ChatGPT2Codex fixture branch/HEAD and pre/post dirty status
- final Phase 3H Task status/revision
- final Phase 3 parent status/revision if touched
- Findings
- acceptance matrix
- actual mixed-language measurements
- representative raw identity/query evidence
- manual-wiring evidence and semantic justification
- fresh test/verify evidence
- residual risks
- next canonical Task/Phase, without starting it

Writing this local result file is part of completion. A chat-only review result is incomplete.

In addition, the reviewer must make the same result **directly touchable/openable from the ChatGPT conversation** before the final response. Create a user-visible copy/attachment such as:

`/mnt/data/QuestBoard_Phase3H_Independent_Review_Result.md`

Use the visible-file/Python surface available in ChatGPT to materialize the report under `/mnt/data`, then include a clickable `sandbox:/mnt/data/...` link in the final response. Do not finish with only a local macOS path. The local QuestBoard result file remains canonical; the `/mnt/data` copy is the user-facing attachment.

A review is not complete until both artifacts exist:
1. canonical local result Markdown in the QuestBoard repo
2. chat-visible clickable Markdown attachment in the review conversation

## 13. Start sequence

1. `@C2CT` live bootstrap
2. read this handoff and worker result
3. live-read Phase 3H and parent Tasks
4. inspect QuestBoard HEAD/dirty diff and relevant source/tests
5. record ChatGPT2Codex fixture status before index
6. fresh actual mixed-language index/query/manual acceptance in temp state
7. targeted tests + actual browser E2E
8. full verify + diff check
9. record fixture status after index
10. decide PASS/HOLD from evidence
11. CAS-safe Task transition
12. write `PHASE-3H-INDEPENDENT-REVIEW-RESULT.ko.md`
13. stop without Phase 4 implementation

---

This handoff is a verification starting point, not proof. The independent reviewer must reproduce the acceptance from current live state.
