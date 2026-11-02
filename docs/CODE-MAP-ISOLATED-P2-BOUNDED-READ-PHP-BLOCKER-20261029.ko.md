# QuestBoard S7 · P2 격리 조회 1차 구현 및 SCIP PHP 실행 관문 (2026-10-29)

**판정: P2 bounded read 구현/회귀 검증 PASS; P2 전체 및 실제 PHP SCIP semantic memory GO는 보류. 운영 배포 없음.**

## 시작 지점과 원칙

- 직전 P1 작업: `docs/CODE-MAP-ISOLATED-P1-SCIP-PHP-PREFLIGHT-20261029.ko.md`.
- 기존 dirty 44개(이번 작업 시작 시점), Git main HEAD `9bb87ecb19194b689f16c5d8721d1003bec8eecd` 보존. 기존 Flow/Code Map 영속 데이터/배포를 건드리지 않음.
- PHP/Composer, 운영 프로젝트 소스에 대한 설치·복제·Apply·git commit/push 없음.
- 메인 데몬의 기존 동기식 도메인/Flow mutation 경계를 변경하지 않되, API/에이전트 조회는 선택적으로 subprocess로 분리.

## 구현된 P2 표면

1. `src/application/code-map-service.ts`: opt-in isolated read executor, `queryAsync`, `queryContinuationsAsync`, `querySourceSubsystemsAsync`, `sourceSubsystemsAsync`, `snapshotReadSummary`. 동기 `query`, `getCached`, Flow 계약은 기존 동작을 보존.
2. `src/server/code-map-isolated-read.ts`: 1회용 읽기 자식 Node 프로세스, 기본 전역 동시 2개/대기 16개, Node heap 512 MiB, hard timeout 20초, IPC 입력/출력 각 1 MiB, process group kill/reaping. 전달 환경은 Code Map 설정/PATH/HOME 일부만 사용. 자식 프로세스는 QuestBoard SQLite 및 Flow 서비스를 열지 않는다.
3. `src/server/code-map-read-child.ts`: 서버 등록된 projectId와 canonical root 검증, 외부 persisted snapshot의 root/provider/source pin 유효성 확인, 현행 CodeMapService의 정확한 조회/정규화 로직 재사용. 수동 관계는 부모의 read-only SQLite 포트에서 가져와 작은 IPC 입력으로 전달. parent에는 bounded query DTO/summary만 반환하며 raw graph 전체를 IPC로 보내지 않는다.
4. `src/server/main.ts`: 실제 managed/Web 데몬에서 위 executor를 활성화. `QUESTBOARD_CODE_MAP_ISOLATED_READ=0`이면 명시적 opt-out. **운영 재시작/배포는 수행하지 않음**.
5. `src/adapters/agent-tools.ts`: 일반 raw query, continuation, subsystem full/read paging 및 agent status/refresh status에서 격리 read 사용. **테스트 등 직접 인메모리 서비스**는 기존 동기 refresh/status 반환 형태 유지.
6. `src/server/http-api.ts`: agent-tool Promise를 HTTP 직렬화 전에 정확히 await 하도록 4개 bounded read route 보정 (subsystems GET/POST, continuations POST, raw query POST).

## 검증

- `tests/code-map-isolated-read.test.ts`: 실제 PHP file-only persisted snapshot → 검색/계층/연속관계/서브시스템/상태 다섯 경로를 child에서 읽음, pinned snapshot mismatch 차단, provider root 불일치 거부. 메인 서비스 `getCached` 및 동기 query 함수를 강제로 오류 나게 만들어, accidental parent hydration 없이 성공함을 확인.
- HTTP/에이전트 raw query parity, HTTP subsystem GET/POST, status 정상 응답 확인 (부모의 `getCached` 강제 차단 포함).
- P1 실제 TS SCIP 실행 검증 유지. PHP 의미 분석은 미실행, file-only 결과를 semantic 정확도로 오인하지 않음.
- 최종 `npm run verify`: 타입·Web 구문·**331/331 node tests PASS**·동시성 race PASS.
- 중간 테스트 4회귀(기존 sync refresh receipt·pre-index provider capability)를 발견·수정했고 전체 재검증 통과.
- 이 결과는 기능적 경계와 행동 계약 검증이며, **실제 PHP 3천파일 이상의 parent/child RSS 절감률 및 5k/20k/50k semantic graph 피크 메모리 비교 실측은 아직 없음**. 자식 Node heap 512 MiB는 외부 PHP/indexer child의 RSS 한도가 아니다.

## 남은 P2 실제 메모리 위험

- 웹 `GET /projects/:id/code-map`은 호환성 때문에 아직 전체 `graph`/projection을 main `getCached`에서 응답한다. Code 화면 열기 자체는 큰 그래프를 메인 데몬에 적재할 수 있다.
- `source-structure/flow-sync/candidates`, Preview, 구형 Investigation/CodeScope/Flow API의 동기 cache/read 경로도 메인 그래프를 적재한다. 인증 없는 Apply 경로는 계속 fail-closed.
- 이번 read subprocess는 요청마다 스냅샷을 새로 역직렬화하므로 대형 프로젝트에선 지연/디스크 I/O 증가 가능. 향후 persistent query child/단일 snapshot-specific cache, bounded Web bootstrap/pagination 도입 후 메인 last-good-cache를 완전히 제거해야 한다.
- heavy read/query IPC의 1MiB 제한은 안전한 실패 경계이며, 매우 큰 legacy full subsystem read가 한도 초과 시 오류를 돌릴 수 있다. 필요하면 결과 페이지 축소를 우선하고 cap을 무제한으로 올리지 않는다.

## SCIP PHP 확인

- `php -v`, `composer --version`: 현 로컬 환경에서 실행 파일 없음. 이전 Laravel clone `/tmp/questboard-s7-laravel-framework-20261022`도 현재 없음.
- upstream: https://github.com/davidrjenni/scip-php . 프로젝트 root의 composer.json/composer.lock, 설치된 vendor/autoload.php 및 vendor/bin/scip-php가 필요.
- Packagist v0.0.2 요구 PHP `^8.2`, composer-runtime-api `^2.2`. 사용할 실제 버전/고정 lock 및 환경 확인 후 준비. 원본 php 프로젝트에는 dependency install, index.scip 출력 같은 쓰기 영향이 있으므로 **원본 대신 격리된 복제본** 사용.
- PHP+Composer 런타임을 user-authorized isolated prefix/container에 구성하고 중규모 Composer 앱 fixture를 고정 checkout한 후 Code Map index child/SCIP worker/normalizer/프로세스 트리 전체 RSS, node+call facts, raw evidence, .scip size, wall time, last-good/cancellation 측정이 다음 필수 과정이다.
- 시스템 전체 Homebrew 설치나 운영 DB/Flow 변경은 수행하지 않음. 실 PHP semantic GO는 `BLOCKED_RUNTIME_NOT_INSTALLED`.

## 다음 바로 할 순서

1. P2 UI bootstrap 전환: 부모가 전체 `getCached()`를 호출하는 legacy Code GET을 bounded source tree/프로젝션 요약 RPC로 대체. Browser lazy page/expand에서 snapshot pin 검증. 기존 동작·스냅샷 stale/invalidation 회귀.
2. P2 Source Structure candidate/Preview를 subprocess에서 파생, parent는 auth/SQLite transaction owner 유지. Apply는 서버 인증이 없으면 계속 잠금. 오래된 UI/API full graph hydrate 경로를 계측 후 제거.
3. 실제 PHP/Composer 설치가 가능한 별도 승인된 isolated fixture 환경 준비, 중규모 공개 PHP Composer 프로젝트 semantic 인덱싱, parent 및 child/server aggregate RSS 실제 실측. 파일-only 이전 Laravel 수치(3,166 php / 3,480 files)는 별도 데이터이며 semantic 결과와 혼동 금지.
4. 대규모 semantic/dense graph + 프로세스 강제종료 및 재시작 + 5k/20k/50k 회귀 완료 시에만 P2/S7 GO 판정. commit/push/managed deploy 별도 승인.

이 보고서 기록은 운영 배포/데이터 변경의 증거가 아니다.
