# QuestBoard Code Map 품질 개선 결과

- Date: 2026-09-29
- Task: `0b740348-0a96-4093-a17a-f3afc65ddbcd`
- QuestBoard branch: `main`
- Baseline HEAD: `b38727677f8160a2fad657d8576518b6d07ce457`
- Worker state: implementation complete, review/dogfood next

## 1. Baseline 실측

Fresh QuestBoard self-index에서 다음을 확인했다.

- raw nodes: 7,637
- raw relations: 20,148
- TypeScript: 87 discovered / 87 semantic-indexed / 7,507 symbols
- JavaScript: 3 discovered / 0 semantic-indexed / 0 symbols
- unknown/non-classified: 40 files

TypeScript 쪽 심볼 위치, callers/callees, implements, containment는 실제 source spot-check와 일치했다.

확정 결함:

1. `web/app.js`가 file-only라 `collectElements`, `bindEvents` 같은 실제 함수가 검색되지 않음.
2. capability/status는 language `unknown` 40개를 보고하지만 `find_nodes language=unknown`은 0건을 반환함.
3. exact symbol name 검색보다 enclosing canonical identity substring match가 함께 섞여 사람이 원하는 심볼이 뒤로 밀릴 수 있음.
4. hierarchy children이 source line 순서가 아니라 relation id 순서에 가까워 읽기 불편함.
5. neighborhood에서 broad `depends_on`이 제한된 결과 슬롯을 먼저 차지해 call/contain/type 탐색 노이즈를 증가시킴.

## 2. JavaScript semantic coverage 수정

`src/adapters/code-intelligence/scip-provider.ts`

- 원 repository의 `tsconfig.json`은 변경하지 않는다.
- provider-neutral file inventory에서 JavaScript (`.js/.jsx/.mjs/.cjs`) 파일만 추출한다.
- Code Map external storage 아래 `javascript-overlay.tsconfig.json`을 생성한다.
- overlay는 `allowJs=true`, `checkJs=false`, `noEmit=true`, `skipLibCheck=true`와 exact absolute file list만 가진다.
- 한 번의 `scip-typescript index` 호출에 기존 TypeScript project `.`과 JavaScript overlay project를 함께 전달한다.
- raw SCIP index/normalizer/provenance contract는 그대로 유지한다.

이 방식은 existing project config나 source checkout을 수정하지 않고 JavaScript semantic facts를 추가한다.

회귀:

- `tests/scip-provider.test.ts`
  - storage 외부 overlay 생성 확인
  - original project root 미변경
  - JavaScript file list와 `allowJs` 확인
  - TypeScript + JavaScript가 하나의 SCIP command에 들어가는지 확인
- `tests/code-map-sync-actual-scip-e2e.test.ts`
  - actual `scip-typescript` index 결과에서 `web/app.js`의 `bindEvents` semantic node가 존재해야 함

## 3. Query 품질 수정

`src/application/code-map-query.ts`

### unknown language 일관성

`node.language`가 비어 있으면 query filter에서도 provider registry와 동일하게 `unknown`으로 정규화한다.

### exact-name 우선 검색

substring semantics는 유지하되 결과 정렬 우선순위를 다음으로 둔다.

1. exact `node.name`
2. name prefix
3. name substring
4. canonical identity substring

따라서 `QuestBoardService` 검색 시 enclosing canonical identity를 가진 멤버보다 실제 `QuestBoardService` 심볼이 먼저 온다.

### hierarchy source order

containment 탐색에서 adjacent node의 path/startLine 기준을 우선해 source reading order를 유지한다.

### neighborhood relation priority

relation을 삭제하거나 의미를 변경하지 않고 bounded navigation 순서만 개선한다.

- calls / contains 우선
- implements / overrides / extends / instantiates 다음
- imports / references_type 다음
- reads / writes 다음
- broad depends_on 후순위
- unknown 마지막

따라서 `depends_on`은 여전히 명시적으로 조회 가능하지만 작은 neighborhood limit에서 더 직접적인 call/structure 관계를 밀어내지 않는다.

## 4. Fresh verification

Targeted actual SCIP + headless E2E:

- 4/4 PASS
- actual JavaScript semantic node `web/app.js::bindEvents` 확인

Targeted query/provider regression:

- 9/9 PASS
- unknown language filter PASS
- exact-name ranking PASS
- hierarchy source order PASS
- neighborhood depends_on de-prioritization PASS

Full verification:

- typecheck PASS
- Web syntax check PASS
- Node tests: **177/177 PASS**
- failures: 0
- skipped: 0
- actual SCIP + headless Chrome E2E PASS
- claim/revision race gate PASS
- `git diff --check` PASS

Current implementation diff before this result document:

- 5 source/test files
- +148 / -11
- no commit / push / deploy / runtime apply / Managed MCP update

## 5. Next: ChatGPT2Codex fresh dogfood

다음 acceptance는 실제 `chatgpt2codex` repository를 read-only fixture로 사용한다.

과거 수치는 비교 기준일 뿐 현재 사실로 재사용하지 않는다.

Previous reference range:

- files: 540
- raw nodes: 20,461–20,478
- raw relations: 47,678–47,712
- TypeScript discovered: 315
- TypeScript semantic-covered: 137
- JavaScript discovered: 12

Fresh 측정 항목:

1. fixture branch / HEAD / dirty / staged before-after 무변경
2. total file inventory와 language counts
3. raw node / relation counts
4. TypeScript discovered/indexed/symbol counts
5. **JavaScript discovered/indexed/symbol counts**
6. representative TypeScript symbol (`registerTools` 또는 현재 unique 핵심 symbol) exact search + callers/callees
7. representative JavaScript symbol exact search + callers/callees 가능 여부
8. unknown language filter가 실제 non-classified files를 반환하는지
9. exact-name ranking과 hierarchy source ordering spot-check
10. small neighborhood에서 broad depends_on이 더 직접적인 navigation relation을 밀어내지 않는지

QuestBoard 수정이 아직 live Managed MCP runtime에 적용되지 않았으므로, fresh dogfood는 먼저 수정된 local QuestBoard build를 사용해 실행한다. 결과 확인 전에는 runtime/app/provider installation을 변경하지 않는다.
