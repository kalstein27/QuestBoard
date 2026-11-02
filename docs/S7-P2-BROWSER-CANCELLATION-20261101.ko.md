# QuestBoard S7 P2 · 실제 Chrome E2E 및 요청별 취소 검증 (2026-11-01)

## 판정
**S7 P2 브라우저 E2E + 요청별 취소 하위 범위 PASS.** 전체 `npm run verify` 352/352 통과, 실제 Chrome UI 시나리오 통과. 운영 배포/Commit/Push는 수행하지 않았고 기존 DB·Flow·dirty 파일 보존. 운영 GO 선언은 별도 승인 및 운영 환경 판단 전까지 보류한다.

## 구현
- `src/server/code-map-isolated-read.ts`: P2 read executor에 호스트 소유 `AbortSignal` 지원. 실행 전 취소는 즉시 거부, 큐 대기 중 취소는 큐에서 제거하고 프로세스를 시작하지 않음, 실행 중 취소는 해당 자식 프로세스 그룹 강제 종료. 기존 timeout, maxConcurrent, maxQueued, IPC 1MiB 경계 유지.
- `src/application/code-map-service.ts`: bounded query/subsystem/status/tree/preview 등 P2 async API에 취소 신호 전달. worker IPC에는 AbortSignal을 직렬화하지 않는다.
- `src/server/http-api.ts`: HTTP 요청의 abort 및 **응답이 끝나기 전** socket close를 취소 신호로 변환. request.close는 정상적인 POST body 읽기 직후에도 발생하므로 취소 근거로 사용하지 않음. 중단된 소켓에 오류 응답을 쓰지 않는다. 서버 관리 read-only 경로와 preview 및 쓰기 직전 preflight에서 취소 전달.
- `src/adapters/agent-tools.ts`, `src/application/source-structure-channel.ts`: 요청 인자로 위조할 수 없는 transport-owned signal을 read/preview/preflight에 전달. Source Structure 승인/SQLite CAS는 유지.
- `web/app.js`: Code Map 검색어 변경 또는 새 검색 실행 시 이전 검색 fetch Abort; Source Structure 창 닫기·필터/페이지 전환 시 pending candidate/preview fetch Abort, stale render 차단. 웹 API의 선택적 signal 지원. 인증 없는 Source Structure Apply는 UI에서 계속 잠금 유지.

## 자동 검증
- `tests/code-map-read-cancellation.test.ts` **3 PASS** (실제 별도 Node read child 및 임시 SQLite):
  1. 실행 중 취소: 해당 자식 소멸 확인 및 후속 정상 read
  2. 대기 중 취소: 큐에서 제거, 불필요한 새 자식 생성 없음
  3. HTTP 연결 종료: 해당 자식 정리, 이후 정상 응답 복구
- `scripts/s7-chrome-browser-e2e.mjs` **PASS** (실제 설치 Chrome 156, CDP, 임시 프로젝트/DB만):
  - root/src/Application/Handler.php 실제 폴더 확장
  - native symbol 검색/Inspector
  - Source Structure 선택 및 read-only preview, 미인가 Apply lock
  - Code→Flow preview + isolated Apply로 임시 Flow 노드 2개
  - dialog close 시 취소, 검색어 변경 시 이전 요청 취소가 브라우저 AbortController에서 관측됨
  - 부모 `getCached`를 예외 처리해 전체 graph hydration 불가능함 확인
- 기존 `tests/code-map-sync-actual-scip-e2e.test.ts` **PASS**: 실제 TypeScript SCIP 색인 및 Chrome Inspector 다른 노드 이동/뒤로 가기, Flow 기능. 새로운 first-party `scripts/s7-chrome-browser-e2e.mjs`가 검색 결과에 추가되어 기존 테스트가 이름만으로 **import 참조 노드**를 선택하는 문제가 확인됐음. 정확한 `src/server/http-api.ts` 정의를 선택하고 first-party `scripts/` 관계도 허용하도록 테스트 보정. 제품 기능 결함은 아니며, 테스트의 고정된 결과순서 가정 오류.
- `tests/code-map-explorer-web-contract.test.ts`: AbortSignal 도입된 검색 API 계약 반영.
- **최종 `npm run verify`: 352 tests / 352 pass / 0 fail**, `npm run typecheck`, `npm run check:web`, `npm test`, `npm run test:race` 전부 종료 코드 0.
- **`git diff --check` PASS**. Git HEAD `9bb87ecb19194b689f16c5d8721d1003bec8eecd` 유지, staged 0, 기존 작업물 포함 dirty 73. 별도 Commit·Push 없음.

## 경계 및 후속 결정
- 이 검증은 단일 개발 Mac에서의 임시 DB/합성 그래프 및 실제 TypeScript SCIP E2E다. 실제 운영 브라우저/사용자 DB 상태나 배포를 검증했다고 주장하지 않는다.
- 실제 BookStack PHP 일부 native index coverage 696/1,839 partial인 이전 결과는 그대로이며 완전한 PHP 의미 색인 지원을 선언하지 않는다.
- 요청 취소는 인플라이트 P2 **조회/preview/preflight**에 적용한다. 한 번 시작한 SQLite 동기 트랜잭션은 도중에 HTTP가 끊겨도 멈추지 않으며, 이전 단계에서 별도 증명한 idempotency/rollback/CAS로 정합성을 지킨다.
- S7 주요 개발 수용 범위가 검증됐더라도 production GO, 실사용 데이터 적용 또는 배포에는 운영 승인/별도 전환 점검이 필요하다. 작업 범위 무단 확장 금지.

관련 문서: `docs/S7-P2-WEB-FLOW-ISOLATED-READ-20261030.ko.md`, `docs/S7-P2-SCALE-STABILITY-20261031.ko.md`, `docs/S7-P2-TRANSACTIONAL-APPLY-20261031.ko.md`.
