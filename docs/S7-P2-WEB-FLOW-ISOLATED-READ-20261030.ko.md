# QuestBoard S7 · P2 Web / Source Structure / Code→Flow 독립 조회 격리 (2026-10-30)

## 판정

**일반적인 Web Code 초기 조회, 폴더 탐색, 심볼 검색, Source Structure 후보·Preview, 호환 Code→Flow Preview의 read-side P2 격리: PASS.**
**S7 전체 GO 및 운영 배포: 보류.** 실제 Flow Apply의 동기 트랜잭션 검증 및 다른 일부 mutation/legacy 조회 경로, 전체 프로세스 트리 동시 RSS/동시 부하·실환경 UI 수동 점검은 다음 단계다.

이 문서는 `docs/S7-COMPOSER-VENDOR-SCOPE-COVERAGE-20261030.ko.md`의 PHP 696/1,839 partial coverage, BookStack first-party inventory 2,613, graph 12,400 nodes/28,592 relations을 이어받는다. **기존 dirty 파일 및 운영 SQLite/Flow와 Git HEAD는 유지**했고, 전체 작업을 재시작/배포하지 않았다.

## 구현 범위

1. `src/application/code-map-web-read.ts`: 서버 소유의 정확한 pinned snapshot에서 **직속 디렉터리/파일만 반환**하는 read-only source-tree page. `pathPrefix`는 상대 경로만, `limit` 1~80, `offset` 0~1,000,000. 후속 페이지는 반드시 `expectedSnapshotId`가 필요하며 stale snapshot은 fail-closed. 응답에 native raw symbols/relations, 원본 프로젝트 전체 graph 없음.
2. `src/application/code-map-service.ts`, `src/server/code-map-read-child.ts`: 새로운 `web_bootstrap`, `source_tree`, `source_structure_preview`, `investigation_preview` P2 child operations. 초기 Web 응답은 node/relation counts, provider status, compact six-role view (raw member/sourceRelation ID 배열 제거), nodeKinds 및 bounded manual metadata만 제공. 개별 심볼을 열 때 기존 bounded `queryAsync`로 접근.
3. `src/server/http-api.ts`: isolated mode의 기존 `GET /projects/:id/code-map`은 **graph:null**, `boundedSourceTree:true`, compact Web bootstrap을 반환. 신규 `GET /projects/:id/code-map/source-tree`는 pinned paginated child read. 전체 그래프를 반환하는 구형 동기 `POST /projects/:id/code-map`는 isolated mode에서 409를 반환하고 안전한 `POST /code-map/refresh`를 사용하도록 안내한다. 직접 non-isolated 개발/테스트 경로는 이전 계약을 보존한다.
4. `web/app.js`: lazy directory page (40 entries/request), 파일별 1-hop bounded symbol hierarchy, 기존 bounded inspector/search, 6-role compatibility lens. 코드맵 화면을 여는 것만으로 큰 CodeGraphSnapshot을 내려받지 않는다. 모드 변경/새 snapshot 시 페이지 캐시 초기화 및 pinned page 확인. `memberCount`로 축약된 architecture projection을 표시한다.
5. `src/application/source-structure-channel.ts`, `src/application/source-structure-flow-sync.ts`, `src/adapters/agent-tools.ts`, `src/server/http-api.ts`: 후보 목록과 **read-only 선택 Preview**는 HTTP·MCP/agent 모두 child에서 실제 pinned raw graph를 분석하고 bounded `SourceStructureSyncGraph`만 부모로 전달. 부모는 기존 SQLite binding 상태만 조회한다. 클라이언트가 임의 제공한 page/graph는 인정하지 않는다. parent/worker 모두 projectId와 source snapshot ID/time을 확인한다.
6. `src/application/code-map-investigation-sync.ts`, `src/application/code-map-service.ts`: **호환 Code Map→Investigation Preview**도 child에서 projection과 요청된 raw node ID 존재 여부만 확인한 뒤 부모에서 binding 비교. 원본 큰 raw CodeGraphSnapshot은 부모 IPC로 이동하지 않는다. 기존 자동 preview 및 수동 dialog 기능을 유지한다.
7. `src/application/code-scope-binding.ts`, `src/server/http-api.ts`: 초기 Web과 `GET /code-scope-bindings`가 isolated mode에서 원본 Graph를 읽지 않고 SQLite 앵커 정보만 반환. `state:unverified`, `validation:not_checked`로 검증하지 않은 연결을 active로 가장하지 않는다. 바인딩 생성/수정의 엄격한 실제 심볼 검사 동작은 그대로 유지된다.

## 실제 BookStack 격리 실측 (단회)

- PHP 8.4.27 / Composer 2.11.0 / project-local scip-php; 별도 `/tmp/questboard-s7-bookstack-20261030`; P1와 P2 모두 새 임시 snapshot storage.
- **P1 success:** 12,400 nodes, 28,592 relations. `calls=10,726` / `instantiates=688`는 앞선 수용 실측과 동일. 이 시험에서도 PHP native coverage `696/1,839 partial`.
- **P2 Web bootstrap:** `returnedRawGraph=false`, compact projection 2 roles. Pinned source root page 35 후보 중 12 반환.
- **P2 Source Structure:** 정확한 snapshot pin에서 2 subsystems / 2 derived relations, 경계 cap 12 nodes / 24 relations 준수.
- **P2 Code→Flow compatibility preview:** P2 child가 같은 projectId/sourceIndexedAt의 2-role compatibility projection을 반환.
- **메인 Node RSS:** 기준 129.0MiB → 최대 131.9MiB (단회, 약 +2.9MiB). Index child Node max 486.1MiB, read child Node max 359.5MiB. 전체 왕복 약 14.96초 (인덱싱·복수 별도 read children 포함).
- 각 Node process 피크는 서로 다른 시점의 각자 RSS이며 **중첩 PHP 프로세스 포함 동시 프로세스 트리 peak는 측정하지 않았다**. 위 수치로 시스템 총 메모리 상한을 주장하지 않는다.

## 자동 검증

- `tests/code-map-isolated-read.test.ts`: 부모 `getCached`를 즉시 예외로 바꾼 상태에서도 실제 HTTP Code Map summary, lazy source-tree root/subdir, stale pin 거부, 구형 전체 graph POST 거부, Source Structure 후보, Code→Flow Preview HTTP+agent parity, CodeScope 연결 목록 read PASS.
- `tests/code-map-web-read.test.ts`: 직속 폴더/파일 페이지, deep file exclusion, 2nd-page exact pin, traversal/invalid count 거부, semantic graph 미유출.
- 기존 S5 Source Structure Apply 인증/중복 mutation receipt/CAS/mixed snapshot/동시 쓰기 방지와 S6 Web 계약 및 다른 HTTP/MCP 조회 regressions PASS.
- `npm run build`, `npm run check:web` PASS.
- **최종 `npm run verify` PASS: 339/339 tests**, TypeScript typecheck, Web syntax, Node race 모두 종료 코드 0. CodeScope read-only 격리 HTTP 테스트 추가 이후 마지막 전체 재실행 성공.
- **`git diff --check` PASS**. Repo HEAD는 `9bb87ecb19194b689f16c5d8721d1003bec8eecd` 그대로, stage=0, 기존 사용자 dirty 포함 총 dirty=64. BookStack 임시 복제본의 Git 관리 변경은 사용자 준비 단계의 `composer.json`/`composer.lock` 두 파일만 존재.

## 남은 경계 및 다음 단계

1. **실제 승인된 Apply/Mutation 경로**: `SourceStructureFlowSyncService.apply`, `CodeMapInvestigationSyncService.apply`, CodeScope binding attach/relink, 특정 legacy 동기 그래프 접근은 트랜잭션 내 exact source verification을 사용한다. 지금은 안전한 동기 CAS를 건드리지 않았다. 메인 daemon 전체 hydrate를 완전히 금지하려면 별도 설계(짧은 snapshot pin reservation/transaction-safe read DTO/commit-time CAS)와 인증·stale/다중 writer 검증을 먼저 해야 한다.
2. **실제 사용자 브라우저 회귀**: 정적인 Web 구문/contract + HTTP 실서버 검증은 통과했지만 브라우저의 폴더 확장, 심볼 표시, 스크롤/레이아웃, 프리뷰 대화상자에서 사람이 직접 보는 E2E UI는 아직 미실행이다.
3. **S7 최종 memory/scale**: 5k·20k·50k semantic graph, 병렬 2 P2 readers, timeout/cancel/child kill, IPC 1MiB 결과 cap, last-good snapshot fail-closed, PHP+Node **동시 프로세스 트리 RSS**의 실측이 필요.
4. S7 최종 GO, S8 자동 전환, commit/push 또는 production deployment는 하지 않는다.
