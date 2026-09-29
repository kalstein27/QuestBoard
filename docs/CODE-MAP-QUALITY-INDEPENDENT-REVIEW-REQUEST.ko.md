# Code Map 품질 개선 독립 리뷰 요청

이 문서는 새 리뷰 채팅이 바로 시작할 수 있도록 필요한 전달 내용을 한 곳에 모은다.

## 역할

이 채팅은 구현 worker가 아니다. QuestBoard Code Map 품질 개선과 ChatGPT2Codex fresh dogfood 결과를 독립적으로 검증하는 reviewer 역할을 수행한다.

## 반드시 먼저 읽을 문서

- `docs/CODE-MAP-QUALITY-INDEPENDENT-REVIEW-HANDOFF.ko.md`
- `docs/CODE-MAP-QUALITY-IMPROVEMENT-RESULT.ko.md`
- `docs/CHATGPT2CODEX-CODE-MAP-FRESH-QUALITY-AUDIT.ko.md`

## 관련 QuestBoard Tasks

- `0b740348-0a96-4093-a17a-f3afc65ddbcd` — Code Map 품질 개선 · JavaScript coverage + query precision
- `5de0ba78-7135-4a3c-88cb-231cca33bc3d` — ChatGPT2Codex Code Map fresh indexing + quality audit

둘 다 현재 `review` 상태다.

## 현재 로컬 상태

- QuestBoard branch: `main`
- baseline HEAD: `b38727677f8160a2fad657d8576518b6d07ce457`
- upstream: `origin/main`
- staged: 0
- 현재 dirty는 구현/테스트/결과/리뷰 handoff 문서들로 구성되어 있다.
- 구현 worker는 commit/push/Managed MCP update를 하지 않았다.

## 독립 리뷰 핵심 acceptance

1. JavaScript semantic overlay가 원본 repository의 `tsconfig.json`이나 source checkout을 수정하지 않아야 한다.
2. JavaScript `.js/.jsx/.mjs/.cjs` 파일을 external Code Map storage의 overlay config로만 확장해야 한다.
3. 실제 SCIP E2E에서 JavaScript semantic symbol이 생성되어야 한다.
4. `language=unknown` query가 provider/file inventory와 같은 normalization 규칙을 사용해야 한다.
5. `find_nodes`는 exact `node.name`을 enclosing canonical-identity substring match보다 우선해야 한다.
6. hierarchy children은 source path/startLine 순으로 읽기 자연스럽게 정렬되어야 한다.
7. neighborhood bounded result에서 `calls`/`contains` 등 직접 탐색 관계가 broad `depends_on`보다 우선해야 하며 raw relation 자체를 삭제하거나 변조하면 안 된다.
8. 기존 TypeScript semantic navigation 회귀가 없어야 한다.
9. ChatGPT2Codex dogfood는 fixture source를 read-only로 유지하고 branch/HEAD/staged/dirty가 before/after 동일해야 한다.
10. fresh ChatGPT2Codex 실측에서 JavaScript 12/12 파일 semantic-indexed, 291 symbols, 대표 JS symbol callers/callees 탐색이 재현되어야 한다.
11. full verification과 `git diff --check`를 reviewer가 fresh하게 재실행해서 확인한다.
12. worker가 만든 결과 문서의 수치를 현재 사실로 맹신하지 말고 live source/diff/tests와 필요한 fresh dogfood evidence를 직접 확인한다.

## 리뷰 결과 처리

- PASS면 두 Task를 reviewer가 `done`으로 전환하고 독립 리뷰 결과 문서를 남긴다.
- FAIL이면 blocker를 구체적으로 기록하고 Task를 `review` 또는 필요한 상태로 유지한다.
- reviewer는 구현 source를 수정하지 않는다. 수정이 필요하면 blocker만 기록하고 구현 worker로 돌린다.
- commit/push/Managed MCP update는 리뷰 acceptance와 분리한다. 리뷰 채팅에서 임의로 publish/runtime update 하지 않는다.

## 금지사항

- reset / checkout / clean / revert / unrelated delete 금지
- 다른 작업의 dirty 변경 훼손 금지
- commit / push / deploy / runtime apply / Managed MCP update 금지
- ChatGPT2Codex fixture source mutation 금지

## 리뷰 완료 후 기대 산출물

- canonical independent review result 문서
- 두 QuestBoard Task의 reviewer 상태 갱신
- PASS/FAIL과 근거가 명확한 요약
