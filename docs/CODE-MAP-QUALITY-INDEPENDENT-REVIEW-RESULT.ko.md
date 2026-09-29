# Code Map 품질 개선 독립 리뷰 결과

- Date: 2026-09-29
- Role: implementation worker와 분리된 independent reviewer
- Review target: Code Map JavaScript semantic coverage + query precision + ChatGPT2Codex fresh dogfood
- Outcome: **PASS**

## 1. 결론

`docs/CODE-MAP-QUALITY-INDEPENDENT-REVIEW-REQUEST.ko.md`의 12개 핵심 acceptance를 현재 source/diff/tests와 reviewer가 직접 실행한 fresh verification/dogfood evidence로 독립 검증했다.

결과는 **PASS**다. 구현 source의 추가 수정이 필요한 correctness blocker는 발견하지 못했다.

특히 worker 결과 문서의 수치를 현재 사실로 그대로 재사용하지 않고 다음을 reviewer가 직접 다시 확인했다.

- JavaScript semantic overlay가 external Code Map storage 아래에만 생성됨
- fixture/source `tsconfig.json` hash가 indexing 전후 동일함
- actual SCIP E2E에서 `web/app.js` JavaScript semantic node가 실제 생성됨
- `language=unknown` query가 provider/file inventory와 일치함
- exact `node.name` 우선 ranking이 TypeScript/JavaScript 실제 symbol에서 재현됨
- hierarchy children이 source path/startLine 순으로 정렬됨
- bounded neighborhood에서 `calls` / `contains`가 broad `depends_on`보다 먼저 선택됨
- raw relation facts 자체는 변경하지 않고 query ordering만 변경함
- existing TypeScript semantic navigation 수치와 실제 탐색이 유지됨
- current ChatGPT2Codex fixture checkout은 fresh dogfood 전후 완전히 동일함
- full verification과 `git diff --check`를 reviewer가 fresh하게 재실행함

## 2. Acceptance별 독립 검증

### 2.1 JavaScript overlay는 원본 repository를 수정하지 않는다 — PASS

현재 `src/adapters/code-intelligence/scip-provider.ts`를 직접 확인했다.

- provider-neutral file inventory에서 JavaScript 파일만 추출한다.
- overlay path는 provider의 external storage output directory 아래 `javascript-overlay.tsconfig.json`이다.
- original repository의 `tsconfig.json`을 읽거나 덮어쓰는 mutation path는 없다.
- `scip-typescript`는 기존 TypeScript project `.`과 JavaScript overlay project를 한 번의 index command에 함께 받는다.

Reviewer fresh dogfood에서 추가로 확인:

- `underExternalStorage: true`
- `underFixture: false`
- fixture `tsconfig.json` SHA-256 before/after 동일
- overlay options:
  - `allowJs: true`
  - `checkJs: false`
  - `noEmit: true`
  - `skipLibCheck: true`

### 2.2 `.js/.jsx/.mjs/.cjs` JavaScript inventory 확장 — PASS

`inferCodeLanguageFromPath()`의 현재 source는 `.js`, `.jsx`, `.mjs`, `.cjs`를 모두 `javascript`로 분류한다. overlay는 이 공통 inventory language 분류를 그대로 사용한다.

현재 ChatGPT2Codex fixture에서 발견된 JavaScript 12개는 모두 `.mjs`였고, fresh overlay의 exact file list도 12개였다. 확장자 전체 분기는 source inspection으로 확인했고, `.js` 경로는 QuestBoard actual SCIP E2E의 `web/app.js`로 별도 실증된다.

### 2.3 실제 SCIP에서 JavaScript semantic symbol 생성 — PASS

Fresh `npm run verify`의 actual SCIP + headless Chrome E2E가 통과했고, 테스트는 실제 graph에서 `web/app.js`의 `bindEvents` semantic node 존재를 요구한다.

별도의 ChatGPT2Codex fresh dogfood에서도 JavaScript semantic indexing이 재현됐다.

- discovered: **12**
- semantic-indexed: **12 / 12**
- semantic symbols: **291**
- fidelity: `semantic-call`
- gap: none

### 2.4 `language=unknown` normalization 일관성 — PASS

Provider registry는 비어 있는 language를 `unknown`으로 normalize하고, query layer도 동일 의미로 normalize하도록 현재 source가 변경되어 있다.

Fresh ChatGPT2Codex query:

- inventory unknown: **166 files**
- `find_nodes language=unknown` matchedCount: **166**
- returned page: 100, hard query cap에 의해 truncated

### 2.5 exact `node.name` 우선 ranking — PASS

현재 query ranking 순서는 다음과 같다.

1. exact name
2. name prefix
3. name substring
4. canonical-identity-only substring

Fresh real-repo 결과:

- TypeScript `registerTools`: exact-name-first PASS, search matches 3
- JavaScript `runBuildVerification`: exact-name-first PASS, search matches 2

### 2.6 hierarchy children source order — PASS

Hierarchy traversal은 adjacent `contains` relation을 target node의 `path/startLine` 기반 node ordering으로 정렬한다.

Fresh ChatGPT2Codex spot-check:

- parent: `runRuntimeApplyWorker`
- path: `src/runtime/runtime-apply.ts`
- direct children: **88**
- returned: 88, not truncated
- sourceOrdered: **true**
- 첫 항목들이 line 1185, 1186, 1187, 1188... 순으로 재현됨

### 2.7 bounded neighborhood direct-relation priority — PASS

현재 query layer의 ordering priority:

- `calls`, `contains`
- `implements`, `overrides`, `extends`, `instantiates`
- `imports`, `references_type`
- `reads`, `writes`
- `depends_on`
- `unknown`

이 로직은 raw `CodeRelation`을 삭제하거나 kind를 변경하지 않고 bounded traversal의 선택 순서만 바꾼다.

Fresh real-repo 결과:

- `runBuildVerification` neighborhood first page는 `contains` + `calls`로 채워지고 broad `depends_on`이 유용한 첫 page를 밀어내지 않음
- `registerTools` neighborhood first page는 `calls`가 우선함
- raw graph relation totals는 worker audit과 동일하게 재현되어 ordering이 raw fact를 변조하지 않았음을 함께 확인함

### 2.8 TypeScript semantic navigation 회귀 없음 — PASS

Fresh ChatGPT2Codex measurement:

- discovered TypeScript files: **315**
- semantic-indexed files: **137**
- semantic symbols: **19,942**
- fidelity: `semantic-call`
- gap: `partial_coverage`

대표 `registerTools` exact search/neighborhood도 정상 동작했다.

### 2.9 ChatGPT2Codex fixture read-only integrity — PASS

Reviewer가 fresh dogfood command 내부에서 fixture Git state를 indexing 직전과 직후 각각 측정했다.

현재 live fixture baseline은 worker handoff 당시의 2 dirty files가 아니라 **3 dirty files**다. 이는 리뷰 시작 시점에 이미 존재하던 동시 작업 변화다.

Current before/after baseline:

- branch: `docs/windows-install-refresh`
- HEAD: 동일
- staged: 0
- dirty files before/after 동일:
  - `src/runtime/output-policy.ts`
  - `src/server/activity-dashboard.ts`
  - `src/server/chatgpt-consent-widget.ts`
- diff numstat before/after 동일:
  - `src/runtime/output-policy.ts`: +5/-2
  - `src/server/activity-dashboard.ts`: +4/-12
  - `src/server/chatgpt-consent-widget.ts`: +17/-16

`fixtureUnchanged: true`가 fresh run에서 직접 확인됐다.

따라서 handoff의 과거 `2 files / +22/-18` baseline은 더 이상 현재 checkout을 설명하지 않지만, 핵심 acceptance인 **indexing이 fixture를 전혀 변경하지 않는다**는 현재 live baseline으로 독립 재확인됐다.

### 2.10 Fresh ChatGPT2Codex JavaScript dogfood — PASS

Reviewer fresh run에서 worker의 주요 Code Map 결과가 동일하게 재현됐다.

Raw graph:

- file nodes: **540**
- symbol nodes: **20,233**
- total raw nodes: **20,773**
- raw relations: **48,458**
- `calls`: **3,888**
- `contains`: **20,233**
- `depends_on`: **24,332**
- `implements`: **5**

Representative JavaScript symbol:

- name: `runBuildVerification`
- path: `scripts/verify-build.mjs`
- line: 126
- callers: **1**
- callees: **9**
- exact-name-first: PASS

### 2.11 Fresh full verification + `git diff --check` — PASS

Reviewer가 현재 dirty implementation에 대해 fresh 실행했다.

`npm run verify`:

- typecheck PASS
- Web syntax check PASS
- Node tests: **177 / 177 PASS**
- failures: 0
- skipped: 0
- actual SCIP + headless Chrome E2E PASS
- claim/revision race gate PASS

`git diff --check`:

- exit code 0
- output 없음
- PASS

### 2.12 Worker 결과 문서 독립 검증 — PASS

Reviewer는 worker 문서만 근거로 accept하지 않았다.

직접 확인한 범위:

- current Git/dirty diff
- 변경된 5개 source/test file 전체 관련 로직
- provider registry normalization
- JavaScript extension classifier
- full `npm run verify`
- fresh `git diff --check`
- fresh ChatGPT2Codex full semantic index
- fresh fixture before/after Git state
- fresh overlay location/options/tsconfig integrity
- fresh real-repo exact-name, unknown filter, hierarchy, neighborhood checks

## 3. Fresh independent measurements

| 항목 | Reviewer fresh 결과 |
| --- | ---: |
| File nodes | 540 |
| Symbol nodes | 20,233 |
| Raw nodes | 20,773 |
| Raw relations | 48,458 |
| TypeScript discovered | 315 |
| TypeScript semantic-indexed | 137 |
| TypeScript semantic symbols | 19,942 |
| JavaScript discovered | 12 |
| JavaScript semantic-indexed | 12 |
| JavaScript semantic symbols | 291 |
| Unknown files / query matches | 166 / 166 |
| JS `runBuildVerification` callers | 1 |
| JS `runBuildVerification` callees | 9 |
| Full tests | 177 / 177 PASS |

## 4. Non-blocking hardening opportunities

다음은 acceptance blocker가 아니지만 후속 품질 강화 후보다.

1. `tests/scip-provider.test.ts`에서 fixture `tsconfig.json` 내용을 indexing 전후 명시적으로 hash/compare하는 regression을 추가하면 external-only invariant가 더 직접적으로 고정된다.
2. `.js/.jsx/.mjs/.cjs` 네 확장자를 parameterized provider test로 각각 overlay에 포함시키면 classifier와 provider integration 사이의 회귀를 더 빠르게 잡을 수 있다.
3. provider registry와 query layer의 `unknown` normalization helper를 하나의 공통 helper로 통합하면 `toLowerCase` / `toLocaleLowerCase` 중복을 줄일 수 있다.

현재 동작 correctness는 source inspection + actual `.js` E2E + fresh `.mjs` dogfood로 충분히 확립되어 위 항목은 PASS를 막지 않는다.

## 5. Reviewer decision

**PASS**

- `Code Map 품질 개선 · JavaScript coverage + query precision`: reviewer acceptance 완료
- `ChatGPT2Codex Code Map fresh indexing + quality audit`: reviewer acceptance 완료

두 Task는 `done`으로 전환할 수 있다.

## 6. Publication/runtime boundary

이번 independent review에서는 다음을 수행하지 않는다.

- commit
- push
- deploy
- runtime apply
- provider install/update
- Managed MCP update

이 작업들은 review acceptance와 분리된 별도 publication/runtime 결정이다.
