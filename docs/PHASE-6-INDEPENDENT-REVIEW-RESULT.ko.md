# QuestBoard Phase 6 Independent Review Result

- Review date: 2026-09-29 (Asia/Seoul)
- Canonical handoff: `docs/PHASE-6-INDEPENDENT-REVIEW-HANDOFF.ko.md`
- Phase 6 Task: `29b500f8-e118-4ffe-8c60-88dd9426df9f`
- Phase 6 title: `Code-aware 6/6: stale/relink lifecycle + Agent Follow + real-work E2E`
- Independent verdict: **FAIL / NOT ACCEPTED**
- Live Phase 6 state after review: **review / revision 4 / claim=null**
- Parent umbrella: **not closed**

## 1. Executive summary

Phase 6는 이번 independent review에서 Done으로 전환하지 않았다.

Fresh source/diff 검토와 현재 live Task 확인, targeted regression, full `npm run verify`, race gate, actual SCIP + headless Chrome E2E, `git diff --check`는 모두 수행했다. 자동 회귀는 전부 녹색이었다.

그러나 conservative CodeScope relink의 핵심 fail-closed 규칙을 위반하는 **blocking logic defect 1건**을 current source에서 확인했다.

현재 `bindingState()`는 canonical identity 후보가 이미 2개 이상으로 ambiguous한 상태에서도, lower-priority path/signature fallback 후보가 우연히 1개이면 그 fallback을 `relinkable`로 반환할 수 있다. Canonical handoff가 명시적으로 금지한 `canonical ambiguity + unique lower-priority fallback` 케이스다.

즉 다음 상태가 가능하다.

- `canonical.length > 1`
- `anchored.length === 1`
- 현재 구현 결과: `relinkable`
- 요구 계약: `stale / relink_ambiguous`

이 결함은 기존 테스트가 직접 고정하지 않아 `173/173 PASS`와 공존한다. 따라서 green suite만으로 Phase 6 acceptance를 승인할 수 없다.

또한 live Code-aware 1~6 상태를 확인한 결과 Phase 2가 아직 `review`이고 Phase 6도 본 리뷰 결과 `review`를 유지하므로, 사용자가 지정한 umbrella 종료 조건인 “Phase 1~6 모두 accepted/Done”도 성립하지 않는다.

새로운 구현, source fix, commit/push/deploy/runtime update/provider install/Managed MCP update는 수행하지 않았다.

---

## 2. Current live state / repository baseline

### QuestBoard repository

Independent review 시작 시 current checkout을 직접 확인했다.

- branch: `main`
- HEAD: `87c34f743fffad39c3c19c7a5bf88b6314aba022`
- upstream: `origin/main`
- ahead/behind: 0/0
- staged: 0
- dirty: 43 files
- 성격: Phase 3~6 누적 intentional dirty tree

기존 dirty 변경은 reset / checkout / clean / revert / delete 하지 않았다.

### Live Phase 6 Task

Managed QuestBoard에서 current Task를 직접 읽었다.

- id: `29b500f8-e118-4ffe-8c60-88dd9426df9f`
- status: `review`
- revision: `4`
- claim: `null`

Canonical handoff의 expected review state와 일치했다.

### Managed QuestBoard runtime distinction

현재 installed Managed QuestBoard는 local Phase 3~6 dirty source보다 이전 published revision에서 실행 중이다.

- installed managed commit: `7a56464b06a74bd755f518cdec9dca1318870b75`
- service: running / HTTP 200

따라서 이번 review에서 Phase 6의 **source-level Agent/MCP/HTTP/Web parity**는 current local source를 기준으로 검증했으며, 아직 publish되지 않은 Phase 6 surface가 current installed managed runtime에 배포돼 있다고 주장하지 않는다. Managed MCP update/deploy는 guardrail에 따라 수행하지 않았다.

---

## 3. Blocking finding: canonical ambiguity가 lower-priority fallback으로 우회됨

### Evidence

`src/application/code-scope-binding.ts`의 `bindingState()` 현재 분기 순서는 다음과 같다.

- lines 80-81: exact node ID + same canonical identity면 `active`
- lines 83-86: canonical identity 후보가 정확히 1개면 `relinkable / canonical_identity`
- lines 88-91: fallback 후보가 정확히 1개면 즉시 `relinkable`
- lines 92-94: 그 뒤에야 `canonical.length > 1 || anchored.length > 1`을 `relink_ambiguous`로 처리

현재 핵심 부분:

```ts
const canonical = graph.nodes.filter((candidate) => candidate.canonicalIdentity === binding.codeCanonicalIdentity);
if (canonical.length === 1) {
  return { state: "relinkable", relink: { strategy: "canonical_identity", candidate: canonical[0]! } };
}

const anchored = relinkFallbackCandidates(binding, graph);
if (anchored.length === 1) {
  return { state: "relinkable", relink: anchored[0]! };
}
if (canonical.length > 1 || anchored.length > 1) {
  return { state: "stale", staleReason: "relink_ambiguous" };
}
```

따라서 canonical identity 후보가 여러 개인데 fallback anchor만 1개인 경우, ambiguity check에 도달하기 전에 lower-priority fallback 하나가 선택된다.

### Why this is a blocker

Canonical handoff의 conservative relink 계약은 다음 우선순위를 요구한다.

1. exact stable target
2. unique canonical identity
3. exact path+signature 또는 file-path fallback
4. ambiguity / insufficient evidence => stale

특히 handoff가 독립 검증 항목으로 명시한 edge case는 **canonical identity duplicate와 fallback single candidate가 섞여도 fail-closed** 하는 것이다.

Higher-priority semantic identity가 ambiguous한 시점에는 lower-priority evidence가 하나라는 이유만으로 자동 relink 후보를 정하면 안 된다. 이 경우 사용자가 보는 상태는 `stale / relink_ambiguous`여야 한다.

### Existing regression gap

`tests/code-scope-binding.test.ts`의 현재 ambiguous regression은 lines 305-319에서 두 후보를 만든 뒤 `stale / relink_ambiguous`를 확인한다.

하지만 그 fixture는 canonical ambiguity와 fallback ambiguity가 함께 발생하는 형태다. 즉 `canonical.length > 1`이면서 `anchored.length > 1`인 케이스는 잡지만, **`canonical.length > 1 && anchored.length === 1`** 조합은 고정하지 않는다.

그 결과 current full suite가 173/173 PASS여도 이 blocker가 검출되지 않는다.

### Review action

- source 수정하지 않음
- regression 추가하지 않음
- follow-up implementation 시작하지 않음
- Phase 6 status를 Done으로 변경하지 않음

이 review는 finding을 기록하는 데서 멈춘다.

---

## 4. Acceptance matrix

| Acceptance item | Independent result | Evidence / note |
|---|---|---|
| exact stable target lifecycle | PASS | 동일 node ID + 동일 canonical identity일 때만 active. same-ID identity drift는 자동 active되지 않음. |
| unique canonical identity | PASS | canonical 후보가 정확히 1개일 때만 `canonical_identity` relink 후보. |
| exact path+signature fallback | PASS with blocker interaction | non-file은 exact path + kind/language + signature 필요. 단, canonical ambiguity가 존재할 때 fallback single을 허용하는 ordering defect가 있음. |
| exact file-path fallback | PASS with blocker interaction | file은 exact path + kind/language. 동일하게 higher-priority canonical ambiguity와의 조합이 blocker. |
| ambiguous candidate fail-closed | **FAIL / BLOCKER** | `canonical.length > 1 && anchored.length === 1`이면 현재 구현은 `relinkable`; 요구는 stale/ambiguous. |
| fuzzy auto-relink 금지 | PASS | fallback candidate selection에 `codeName` fuzzy/name matching 없음. non-file signature 없으면 fallback 0. |
| binding anchor SQLite migration | PASS | anchor columns (`code_kind`, `code_language`, `code_path`, `code_signature`, `code_name`)를 schema/migration에서 보존. |
| CAS / revision | PASS | relink/update는 expected revision 검사 + SQL revision guard + revision increment. |
| idempotency | PASS | mutation receipt/shared idempotent mutation 경계 사용. |
| audit | PASS | actor/provider + created/updated timestamps/revision 보존. |
| target loss/relink failure에도 Task 보존 | PASS | stale/relink failure path가 Task를 삭제하지 않음; regression도 Task survival 확인. |
| Agent relink parity | PASS (source) | neutral agent tool이 `CodeScopeBindingService.relink()` 사용. |
| MCP relink parity | PASS (source) / deployed-live not asserted | MCP가 same agent tool executor를 사용하고 mutation request-id 경계를 공유. Installed managed runtime은 Phase 6 local source 이전 revision. |
| HTTP relink parity | PASS (source) | HTTP relink route가 same service 사용. |
| Web relink parity | PASS (source) | Web은 HTTP relink endpoint를 사용하고 relinkable 상태에서만 action 노출. |
| Agent Focus process-memory only | PASS | `AgentFocusService` durable storage는 사용하지 않고 process-local `Map`만 사용. |
| Focus ≠ Claim | PASS | focus set/list/clear가 Claim을 읽거나 변경하지 않음. |
| Focus ≠ authorization | PASS | focus는 navigation/session hint일 뿐 authorization grant로 사용되지 않음. |
| Focus ≠ Task Activity | PASS | focus set 후 Task Activity 증가 없음; fresh test PASS. |
| Focus ≠ Resume Capsule | PASS | Resume payload에 Agent Focus가 삽입되지 않음; fresh test PASS. |
| Focus ≠ SQLite durable history | PASS | 새 `AgentFocusService` instance에서 이전 focus가 복구되지 않음. |
| Watching / Follow / Free / Return to agent | PASS (source + Web contract) | Free 기본, Follow explicit, Return one-shot, Watching status 노출. |
| Free 상태에서 agent update가 화면 강제 이동 금지 | PASS | polling refresh는 `changed && mode === follow`일 때만 navigation 적용. |
| cross-project focus safety | PASS | current project와 다른 focus는 apply하지 않음. |
| focus priority | PASS | CodeScope > Flow Group/Node > Task 순서. |
| single polling timer | PASS | 1500ms interval을 중복 생성하지 않는 guard 존재. |
| iPad/mobile responsive behavior | PASS at source/contract level | focus control에 <=1024 / <=720 responsive bounds/ellipsis가 있으며 full Web contracts 통과. 이번 independent review에서 별도 physical iPad dogfood는 수행하지 않음. |
| actual SCIP + headless Chrome E2E | PASS fresh | Fresh `npm run verify`에서 `actual SCIP indexes 6/5, Web syncs to Investigation, and MCP/HTTP agree` 실제 test PASS. |
| external ChatGPT2Codex read-only fixture integrity | PASS fresh for read-only integrity | current branch/HEAD/dirty/staged를 review 전후 재확인해 동일. 자세한 현재 baseline은 아래 참조. |
| external Phase 6 relink/focus dogfood rerun | NOT independently rerun end-to-end | worker 결과를 acceptance 근거로 재사용하지 않음. 이번 review에서 actual external full-index/relink harness를 새로 실행하지 않았으며, 이미 발견된 relink blocker로 최종 판정은 FAIL. |
| fresh `npm run verify` | PASS | 173/173 PASS, fail 0, skipped 0. |
| race gate | PASS | claim conflict / revision conflict / lockless sequential update gate 모두 PASS. |
| `git diff --check` | PASS | exit 0, output 없음. |

---

## 5. Agent Focus separation review

`src/application/agent-focus.ts`를 current source에서 직접 읽었다.

핵심 상태는 다음 process-local map에만 존재한다.

```ts
private readonly byProject = new Map<string, Map<string, AgentFocus>>();
```

Repository는 project/task 존재 및 same-project validation에만 사용된다. Focus `set()`은 Map에 값을 넣을 뿐 repository mutation을 하지 않는다.

Fresh regression에서 다음을 확인했다.

- focus publish 전후 Task Activity count 불변
- Resume Capsule에 Agent Focus 필드 없음
- 새 `AgentFocusService(repository)` instance의 latest focus는 null
- Agent surface와 HTTP surface가 동일 process-memory focus state 공유

따라서 Agent Focus는 Claim, authorization, Task Activity, Resume Capsule, SQLite durable history와 분리돼 있다.

---

## 6. Watching / Follow / Free / Return UX review

`web/app.js` current source에서 확인한 동작:

- 기본 mode: `free`
- Follow: mode를 `follow`로 바꾸고 latest focus를 적용
- Free: mode를 `free`로 바꾸며 navigation을 수행하지 않음
- Return to agent: latest focus를 한 번 적용하되 mode를 Follow로 바꾸지 않음
- polling: 1500ms, single timer guard
- 새 focus가 들어와도 `mode === follow`인 경우에만 자동 navigation
- Free 상태에서는 focus update가 화면을 steal하지 않음
- project mismatch focus는 적용하지 않음
- navigation priority: CodeScope → Work Group/Flow Node → Task

Responsive CSS에는 tablet/narrow 화면에서 focus status/control 폭과 ellipsis 처리 규칙이 존재한다.

이번 independent review는 physical iPad Safari를 새로 조작하지 않았으므로, “실제 기기 dogfood까지 fresh PASS”라고 과장하지 않는다. Source/contract regression 수준에서는 PASS다.

---

## 7. Fresh verification results

### Targeted Phase 6 lifecycle/focus

Fresh command:

```text
npm run build && node --test dist/tests/code-scope-binding.test.js dist/tests/agent-focus.test.js && npm run check:web
```

Result:

- 8/8 PASS
- fail 0
- Web syntax PASS

중요: 이 targeted suite가 green이어도 blocking combination `canonical.length > 1 && anchored.length === 1`을 테스트하지 않는다.

### Full verify

Fresh operation:

- operation: `bg_64e24670-f0c4-4a20-89a1-c3d89fba6e8d`
- command: `npm run verify`
- exit: 0

Result:

- typecheck PASS
- Web syntax PASS
- Node tests: **173/173 PASS**
- fail: 0
- skipped: 0
- actual SCIP + headless Chrome E2E PASS
- race gate PASS

Fresh actual E2E output includes:

```text
actual SCIP indexes 6/5, Web syncs to Investigation, and MCP/HTTP agree
```

### Race gate

Fresh race result confirmed:

- simultaneous Claim: one success, one `claim_conflict`
- revision-CAS update: one success, stale peer `revision_conflict`
- lockless update path: sequential revision advancement preserved

### Whitespace/diff gate

Fresh operation:

- operation: `bg_114b1145-1035-4a36-a8a1-ca4c55e5c916`
- command: `git diff --check`
- exit: 0
- output: none

Result: PASS.

---

## 8. External ChatGPT2Codex read-only fixture

Worker report의 과거 baseline을 현재 사실로 재사용하지 않고, current live fixture를 다시 읽었다.

Fresh current status:

- project: `chatgpt2codex`
- branch: `docs/windows-install-refresh`
- HEAD: `49d34c44d2e158965062552e40ef1ce9b98c89e0`
- staged: 0
- current dirty files: 4
  - `src/exec/mobile-approval.ts`
  - `src/runtime/tool-progress.ts`
  - `src/server/connection-recovery-classification.ts`
  - `src/server/tools.ts`

Worker 당시 handoff의 “dirty 1 file”은 현재 fixture baseline이 아니다. 다른 작업이 진행되어 current dirty set이 4개로 바뀌었다.

Read-only fresh probe로 실제 `scanWorkspace` symbol이 여전히 다음 source에 존재함을 확인했다.

- `src/workspace/registry.ts:123` — `scanWorkspace`

Independent review의 read-only 확인 후 branch / HEAD / dirty 4 / staged 0을 다시 읽었고 동일했다. 즉 이번 review가 external fixture source를 변경하지 않았다.

다만 worker의 external full-index → real relink → focus ephemeral 시나리오를 이번 review에서 독립적으로 end-to-end 재실행하지는 않았다. 그 결과를 worker 보고서만 보고 PASS로 승격하지 않는다. 최종 verdict는 그 이전에 current source의 conservative relink blocker로 이미 FAIL이다.

---

## 9. Phase 1~6 live acceptance gate

현재 live Task state를 직접 확인했다.

| Slice | Live state |
|---|---|
| Code-aware 1/6 | done |
| Code-aware 2/6 | **review** |
| Code-aware 3/6 | done |
| Code-aware 4/6 | done |
| Code-aware 5/6 | done |
| Code-aware 6/6 | **review** |

따라서 parent umbrella 종료 조건인 “Phase 1~6 모두 accepted/Done”은 성립하지 않는다.

Phase 6는 본 review의 blocker 때문에 Done으로 전환하지 않았고, Phase 2 역시 현재 live state가 review이므로 parent umbrella도 Done으로 전환하지 않았다.

---

## 10. Final decision

### Phase 6

**FAIL / keep `review`**

Blocking reason:

> canonical identity가 ambiguous한데 lower-priority exact fallback만 unique한 경우 current `bindingState()`가 `relinkable`을 반환할 수 있어, conservative fail-closed relink contract를 위반한다.

Full regression 173/173, race, actual SCIP/headless Chrome, diff-check가 모두 PASS인 사실은 유지하지만, 이 green suite는 blocker combination을 직접 커버하지 않는다.

### Parent umbrella

**Do not close.**

Reasons:

1. Phase 6 independent acceptance FAIL
2. live Phase 2도 아직 review
3. 따라서 Phase 1~6 all accepted/Done gate 미충족

### Mutations performed by reviewer

- implementation/source fix: 없음
- Task status transition: 없음
- parent transition: 없음
- commit: 없음
- push: 없음
- deploy/runtime apply: 없음
- provider install: 없음
- Managed MCP update: 없음
- external ChatGPT2Codex mutation: 없음
- reviewer artifact: 이 결과 Markdown만 추가
