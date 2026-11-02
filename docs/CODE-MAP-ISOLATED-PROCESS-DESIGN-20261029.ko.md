# QuestBoard Code Map 프로세스 격리 설계 · 2026-10-29

상태: 아키텍처 진단 및 구현 수용 기준 정의. **2026-10-29 P1 독립 인덱싱 + P2 bounded agent/HTTP 읽기 일부 구현, 최종 331/331 회귀 검증 통과. 전체 Web graph/Flow read 격리·실제 SCIP PHP 계측·배포는 미완료.** 상세: `docs/CODE-MAP-ISOLATED-P1-SCIP-PHP-PREFLIGHT-20261029.ko.md` 및 `docs/CODE-MAP-ISOLATED-P2-BOUNDED-READ-PHP-BLOCKER-20261029.ko.md`.

## 목적

대규모 Code Map 인덱싱, SCIP 디코딩, 원본 그래프 통합·계층화·아키텍처/서브시스템 파생, 스냅샷 직렬화 및 무거운 탐색 연산이 QuestBoard 메인 Web/API/MCP 데몬의 이벤트 루프·메모리를 잠식하지 않도록 한다. 특히 PHP 프로젝트의 인덱서 + 정규화 + 그래프 중복 보유 시 메모리 증가를 단계별로 측정하고 제한한다.

## 2026-10-29 코드에서 확인한 사실

- `src/adapters/code-intelligence/scip-provider.ts` 의 `WorkerScipGraphLoader`는 `scip-normalizer-worker.js` 워커에서 SCIP 디코딩/정규화를 수행한다. 워커는 **전체 CodeGraphSnapshot을 parentPort.postMessage로 전달**하며, parent에서 다시 그래프 객체를 보유한다.
- `src/application/composite-code-intelligence-provider.ts` 의 provider fan-in, merge/provenance/coverage, `src/application/code-map-service.ts` 의 `refresh`: file hierarchy materialization, `projectCodeArchitecture`, changed-node fingerprints, persisted snapshot, cache는 서비스 호출 측에서 실행된다.
- `CodeMapService.startRefresh`는 202 응답용 job/receipt와 `queueMicrotask`로 비동기 시작하지만 **별도 프로세스가 아니다**. refresh 내부 동기 계산은 여전히 메인 이벤트 루프와 RSS에 영향을 준다.
- `querySourceSubsystems`는 요청마다 `createCodeSourceSubsystemRead(..., {unbounded:true})`를 재계산하므로 큰 raw graph에서 요청당 비용이 있다.
- `web/app.js`의 트리 DOM 생성은 브라우저 프로세스의 작업이다. **데몬 프로세스 분리만으로 DOM 렌더 비용까지 해결되는 것은 아님**. 브라우저 측은 이미 bounded/paginated tree UX를 유지해야 한다.
- 직전 S7 공개 Laravel **file-only** 결과: 실 PHP 파일 3,166/전체 3,480, 수정 후 단일 Node peak RSS 약 83 MiB; 합성 50k 파일만의 peak RSS 약 236 MiB. SCIP PHP 의미 분석 및 child RSS는 아직 미측정. 이 수치를 실 PHP semantic index 성능이라고 표현하지 않는다.

## 권장 아키텍처

```text
Browser (bounded Code Map DTO / pagination)
       ↕ HTTP/MCP
QuestBoard Web/API daemon (Task·Flow·Auth·SQLite owner)
       │  asynchronous job queue + small progress/status replies
       ├──── IPC ────> Code Map service subprocess
       │                 ├─ indexer subprocess (scip-typescript / scip-php)
       │                 ├─ SCIP decoder/normalizer + mixed provider fan-in
       │                 ├─ file hierarchy + projection + subsystem derivation
       │                 ├─ bounded query/preview server
       │                 └─ immutable external snapshot staging
       │                        → atomic publish via snapshotId
       └─ read-only bounded status/DTO; no full raw graph JSON/IPC transfer
```

**프로세스가 우선**: Worker Thread는 이벤트 루프를 보호하되 프로세스 RSS를 공유하고 full graph structured clone으로 parent 메모리를 키울 수 있다. 독립 Code Map subprocess는 프로세스 종료 시 주소공간을 반환하고, parent 대형 스냅샷 중복 보유를 제거하는 방향으로 설계하기 좋다. 다만 subprocess에서 그래프를 만든 뒤 **다시 전체 그래프를 parent에 넘기면 요구사항 불충족**이다.

### 경계·소유권

1. 메인 데몬은 HTTP/MCP, 인증, QuestBoard Task/Flow/Investigation mutation, 기존 운영 SQLite 단일 소유권을 유지한다. child에 운영 DB 쓰기 권한을 주지 않는다.
2. Child는 한 프로젝트의 Code Map 인덱싱·조회/파생 계산을 담당하고, 임시 외부 storageRoot에 immutable snapshot을 기록한다. 활성 스냅샷은 성공 검증 및 원자적 교체 후에만 노출된다. 실패/kill 시 last-good snapshot을 보존한다.
3. IPC는 `refresh/start`, `refresh/status`, `status`, `query`, `subsystems`, `source-structure/candidates`, `source-structure/preview`에 필요한 최소 DTO. IPC마다 projectId, snapshotId, indexedAt, bounded limit, requestId/actor *metadata* (이 자체는 인증이 아님)를 확인한다.
4. `source-structure/apply`는 여전히 메인 데몬의 별도 인증/인가 및 SQLite 트랜잭션 경계에 남긴다. 외부 프로세스가 반환한 임의 그래프/페이지/프로젝트 경로를 신뢰하지 말고 server-owned pinned immutable snapshot / fingerprint/CAS로 검증한다. **현재 서버 측 authorizer가 없으므로 Apply 계속 잠금**.
5. 기존 6-role compatibility, raw id / derived id 구분, Flow manual edit/삭제 tombstone, 변경 시 stale/detached, 관계의 raw evidence를 바꾸지 않는다.

### 실행 제한 및 회복

- 기본 전역 무거운 인덱싱 동시성 1; 동일 프로젝트 요청은 기존 job receipt를 재사용. 여러 프로젝트는 대기열 및 공정성 제한. 사용 중인 last-good snapshot에 대하여 조회는 계속 허용.
- 별도 index child 메모리/CPU/시간 상한, IPC 응답 크기 cap, hard timeout, health heartbeat, cancellation/reaping. Node heap 상한만으로 전체 RSS (PHP child 포함)를 제한했다고 간주하지 않는다. macOS 실제 RSS 감시/child process-tree cleanup 증거 필요.
- parent 재시작 또는 child 강제 종료 후 running job을 interrupted/failed로 정확히 기록. 같은 requestId 중복 실행·아티팩트 유실·부분 publish 방지. child 시작 시 stale snapshot ID/코드 해시 drift 확인.
- phase별 RSS: daemon baseline, indexer child, decoder/normalizer, fan-in/hierarchy/projection, persisted snapshot load, query, total concurrent peak, after-GC retained RSS. raw 소스/credential은 diagnostics에 싣지 않는다.

## 단계적 구현

- **P0: 측정과 계약**: 실제 PHP semantic fixture를 격리 준비, 메인 이벤트루프 지연/기존 RSS와 child RSS를 독립 측정. 기존 `CodeMapService`와 HTTP/MCP 호출 지점을 시험 가능한 boundary로 고정.
- **P1: 독립 index subprocess**: 인덱서 실행→디코딩→merge→hierarchy→projection→artifact publish 전체를 child 안에 수용. 메인에 full graph 객체를 되돌리지 않고 small terminal receipt와 immutable snapshot 참조만 반환. 기존 호출과 parity 유지하는 process-backed adapter 작성.
- **P2: heavy read/query 분리**: cached graph는 child가 소유하고 parent에는 bounded query/status/preview DTO만 제공. 특히 `querySourceSubsystems` 반복 full derivation 및 큰 snapshot hydration을 parent에서 금지. snapshot-specific cache 및 invalidation 구현.
- **P3: Web rendering 부담**: UI는 12/24 caps, lazy expansion, pagination, stale sequence guard 유지. 브라우저 CPU가 측정상 문제면 layout computation만 Web Worker로 이동; DOM mutation은 main browser thread 소유.
- **P4: 독립 검증**: 5k/20k/50k semantic nodes 및 dense relations에서 API 응답/daemon heartbeat, 전·후 parent/child/총 RSS와 시간 비교. 장애(강제 종료/재시작/OS 메모리 제한/동시 refresh), last-good, auth fail-closed, snapshot pin, no duplicate/Flow mutation, 실제 iPad Safari 및 HTTP/MCP/CLI parity 확인.

## 완료 조건 (GO 판정)

1. 대용량 Code Map 작업 중 메인 데몬 health/status/Task 조회의 응답성 유지, 미리 정한 p95 latency budget 충족.
2. 대용량 raw graph 생성/merge/projection/parse가 **메인 데몬 이벤트 루프에서 수행되지 않고**, parent가 전체 graph를 중복 보유하지 않는다. child 종료 후 main RSS가 건설적인 기준선 수준으로 유지되는지 측정으로 검증.
3. 실제 semantic PHP indexer process tree의 피크 RSS를 계측하여 합리적 상한과 차단 정책을 수립한다. 한계 초과 시 마지막 정상 스냅샷 유지.
4. source ID·snapshot pin·evidence·raw relation direction·manual Flow 보호·legacy 6-role 계약 불변.
5. 테스트와 synthetic fixture만으로 운영 DB/기존 사용자가 만든 Flow·원본 PHP 프로젝트를 자동 변경하지 않는다. commit/push/managed deploy는 사용자 별도 승인.

## 작업 주의

이 파일은 구조 설계와 향후 구현 경계를 기록한다. **P1 코드와 P2의 bounded HTTP/agent read 로컬 검증은 완료했지만, 현재 운영 서비스 업데이트·P2 전체 Web/Flow read 격리·실제 PHP 의미 분석은 수행하지 않았다.** PHP 의미 분석 및 실제 combined RSS 측정 없이는 최종 GO를 내리지 않는다.
