# QuestBoard Code Map P1 독립 인덱싱 + SCIP PHP 사전검증 (2026-10-29)

## 판정

- **P1 독립 인덱싱 구현/격리 회귀: PASS (코드 작성 및 테스트), 미배포.**
- **P2 메인 데몬 대형 그래프 조회/메모리 격리: 미구현.**
- **실제 PHP SCIP 분석 및 실제 합산 RSS 계측: BLOCKED (PHP/Composer/의존성 미구성).**
- **전체 S7 및 운영 배포 GO: 보류.**

## 실행 경계

현재 제품은 `CodeMapService.startRefresh`를 통해 비동기 job receipt를 만든다. 이전에는 `queueMicrotask`만 사용해 무거운 `refresh` 계산을 메인 이벤트 루프에서 수행했다.

이번 P1 변경 사항:

1. `src/server/main.ts`: Code Map이 활성화된 일반/managed 데몬의 **background refresh**에 한해 독립 executor를 등록. `QUESTBOARD_CODE_MAP_ISOLATED_REFRESH=0`으로 초기 배포 시 우회 가능. 직접 호출 `CodeMapService.refresh`는 기존 계약 유지.
2. `src/server/code-map-isolated-refresh.ts`: 1회용 Node fork 및 전역 heavy-job 직렬화, Node heap 기본 512 MiB, 240초 timeout, 4 KiB IPC 영수증 상한, 부모 종료/타임아웃 시 자식 process group 정리, PATH/HOME/Code Map 설정만 제한적으로 환경 전달. Node heap 제한이 **전체 프로세스 트리의 RSS 제한은 아님**.
3. `src/server/code-map-index-child.ts`: 운영 SQLite/Flow 서비스 미접속, 프로젝트 루트 검증, 실제 provider indexing → composite merge → hierarchy → projection → 외부 snapshot 원자적 기록, 정확한 snapshotId/노드/관계/changed counts만 전달. 그래프 자체는 IPC 미전달. 등록된 `getProject` stub는 기존 파일 snapshot 재수화용 rootPath 조회만 담당.
4. `src/application/code-map-service.ts`: executor receipt 확인, 성공 시 캐시 무효화 및 다음 조회에서 기존 pinned persistence hydrator 사용. 실패 시 기존 cached last-good 그래프 유지. 기존 HTTP/MCP 요청/응답 명칭과 동기식 read 계약은 변경하지 않음.
5. `src/server/code-map-config.ts`: **격리 자식 내부에서는** SCIP 디코딩/정규화를 별도 worker thread로 다시 띄우지 않음. 자식 프로세스에서 직접 수행해 중복된 full-graph structured clone 방지. 일반 런타임의 기존 WorkerScipGraphLoader는 유지.
6. `src/adapters/code-intelligence/scip-provider.ts`: SCIP artifact SHA-256을 고정 128 KiB 버퍼 반복 읽기로 바꾸어 거대 .scip 파일 전체를 **추가로** 읽는 메모리 사용 제거. 인덱서 로그 `execFile.maxBuffer` 기본 128 MiB → 8 MiB 축소 (필요시 명시적 옵션으로 조정 가능).

### 아직 해결되지 않은 부분 (P2)

- `CodeMapService.getCached()` 및 `#hydrate`는 메인 프로세스에서 persisted `snapshot.json`을 읽고 전체 raw graph와 projection을 재구성한다.
- `queryCodeSourceSubsystems`는 호출마다 전체 subsystem derivation을 재수행한다.
- 기존 SourceStructureFlowSyncService, CodeMapInvestigationSyncService 등은 sync `getCached`/query 계약에 직접 결합돼 있다. 자식 프로세스에 **읽기·bounded query·Preview까지 이관**하려면 해당 계약과 snapshot pin/인가 모델의 별도 변경/테스트가 필요하다.
- 따라서 **메인 데몬의 모든 Code Map 메모리 문제가 해결됐다고 주장하지 않는다.** 이번 구현은 무거운 색인 생성과 스냅샷 출력 위치를 분리한 1단계다.

## 실제 코드 검증

- `tests/code-map-isolated-refresh.test.ts`: PHP file-only fixture의 별도 프로세스 publish/rehydrate, 중복 refresh 영수증 재사용, 격리 실패 후 last-good 보존, **실제 bundled scip-typescript 실행**으로 semantic node/call evidence 생성 검증 3개.
- `tests/scip-provider.test.ts`: 1 MiB 이상의 실제 바이너리에서 chunked SHA-256 결과 일치 검증.
- **최종 `npm run verify` exit 0: 328/328 tests PASS, 타입 검사, Web syntax 검사, race gate 모두 PASS.**
- TypeScript 테스트는 실제 semantic SCIP 인덱서. PHP 테스트는 **PHP 런타임 없는 synthetic/fake PHP 및 file-only fixture**다.

## SCIP PHP 현황

상위 공개 프로젝트: https://github.com/davidrjenni/scip-php

- upstream README 기준: 프로젝트 루트에 `composer.json`, `composer.lock`, 최신 `vendor/autoload.php`, 프로젝트 로컬 `vendor/bin/scip-php` 필요. Composer로 의존성을 미리 설치해야 함.
- PHP 패키지의 공개 `v0.0.2`는 `php ^8.2`를 요구. 최신 개발 브랜치와 핀된 사용 버전의 PHP 요구사항은 별도 확인 필수.
- 사용자 맥 읽기 전용 preflight: `php`, `composer`, `/opt/homebrew/bin/php`, `/opt/homebrew/bin/composer` 모두 **없음**; Homebrew 자체는 존재. 지난 대화에서 사용한 Laravel 임시 복제본은 현재 `/tmp`에서 사라짐.
- 설치/공개 저장소 재복제/운영 DB 접근은 하지 않음. 글로벌 Homebrew 설치는 명시 승인 없이는 진행하지 않는다.
- QuestBoard `ScipPhpProvider`는 실제 PHP 공급자가 실패했을 때 composite에서 file-only 결과로 돌아갈 수 있으므로, 결과의 `coverage.providers`/indexed vs eligible와 raw call 수를 함께 확인해야 한다. 관계 0을 “코드에 호출 없음”으로 해석하면 안 됨.

## 다음 작업의 정확한 순서

1. **P2 동기식 heavy read의 프로세스 격리:** snapshot 소유권을 child 전용으로 이관하고 parent가 대형 graph를 deserialize하지 않도록 RPC로 bounded query/status/preview 응답만 받게 구현. 기존 Source Structure Apply는 인증 검증된 메인 SQLite transaction만 허용하며 authorizer 미설정 시 계속 차단.
2. PHP/Composer가 설치된 **격리된 환경**에서 composer.lock/vendor를 포함하는 공개 중규모 PHP 앱(예: composer-ready fixture) 준비. 원본 user 프로젝트/운영 DB를 건드리지 않는다. 가능하면 고정 커밋/버전/의존성 hash 사용.
3. PHP SCIP child process의 RSS/time/CPU, .scip bytes, normalized node/call evidence, main vs child RSS, 전체 프로세스 트리 peak RSS, interrupt/timeout cleanup, stale pin, last-good, page caps와 browser/HTTP/MCP parity를 기록.
4. 독립 검증 통과와 승인 후 별도 배포 판단. Git commit/push/managed update/운영 Apply는 미승인 상태로 유지.

참고: `docs/CODE-MAP-ISOLATED-PROCESS-DESIGN-20261029.ko.md`, `docs/SOURCE-STRUCTURE-S7-PUBLIC-LARAVEL-MEMORY-RESULT.ko.md`.

## 작업 트리

원래 dirty 36개 보존. 기존 프로젝트 Code Map 인덱스/Flow/SCIP snapshots 미변경; 새 코드 및 테스트·문서만 변경. **예외로 QuestBoard의 S7 Task에 이번 진행 증거를 담은 `note_added` Activity 1건을 정식 MCP API로 기록했다.** 운영 SQLite의 다른 객체 변경·Git commit/push/managed update/service restart 없음. 기존 `dist`는 npm build/verify의 정상 재생성 대상이므로 변경됐지만 tracked 소스는 보존.
