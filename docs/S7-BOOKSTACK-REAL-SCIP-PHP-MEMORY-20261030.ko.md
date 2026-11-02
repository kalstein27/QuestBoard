# QuestBoard S7 · BookStack 실제 SCIP PHP 의미 인덱싱·메모리·격리 검증 (2026-10-30)

> **후속 검증 업데이트 (같은 날):** 이 문서의 `calls=0`은 PHP lexical AST 복원 **이전** 기준값이다. 후속 구현에서 BookStack `calls=10,726`, `instantiates=688`, raw relations=28,592로 복원했고 334/334 회귀 및 P1/P2 자식 프로세스 실측이 통과했다. 최종 구현과 재현·미완료 항목은 `docs/S7-SCIP-PHP-LEXICAL-CALL-RECOVERY-20261030.ko.md`를 기준으로 볼 것.

## 판정

- **SCIP PHP 8.4.27 / Composer 2.11.0 / `davidrjenni/scip-php:dev-main` 실행: PASS**
- **실제 SCIP protobuf 파일 생성·decode·Code Map 그래프·외부 스냅샷 저장: PASS**
- **QuestBoard P1 자식 인덱싱 및 P2 bounded 조회에서 메인 그래프 적재 방지: PASS (단회 실제 중규모 실측)**
- **PHP 함수 호출·생성 관계 복원: NO-GO (SCIP에는 참조 28,147건이 있으나 현재 QuestBoard가 calls=0을 출력)**
- **전체 합산 프로세스 트리 RSS hard-limit/동시 피크, 대형 Web full graph 및 Flow read 격리: 미검증·미완료**
- **운영 배포 및 S7 최종 GO: 보류**

## 재현 경계

- 공개 소스만 사용: BookStack `development`, 격리 checkout `/tmp/questboard-s7-bookstack-20261030` (macOS canonical root는 `/private/tmp/...`).
- PHP: `/opt/homebrew/opt/php@8.4/bin/php` 8.4.27.
- Composer: `/tmp/questboard-s7-composer-2.11.0.phar` 2.11.0. 공식 배포 SHA-256 확인.
- Composer lock 149개 기본 패키지 설치 성공. 이후 사용자 직접 설치한 `davidrjenni/scip-php` dev-main이 `vendor/bin/scip-php`에 존재함을 확인. PHP Parser 5.9.0.
- `composer.json`/`composer.lock` 수정은 **공개 BookStack 임시 복제본에만** 존재. QuestBoard의 운영 DB, Flow, MCP/데몬 서비스 및 원본 스냅샷 미변경. 새 SCIP 및 snapshot 출력은 격리된 OS 임시 저장소에만 생성.
- BookStack 루트에 미리 존재한 `index.scip`가 없는지 확인. ScipPhpProvider 실행 후 생성된 루트 index.scip는 외부로 복사되고 제거되는 것을 검증.
- 전역 PHP/Composer 재설치, commit/push, 운영 서비스 재시작·배포 없음.

## 1. 실제 PHP/SCIP 직렬 인덱싱

`node --max-old-space-size=512 scripts/s7-bookstack-real-scip-php-benchmark.mjs /tmp/questboard-s7-bookstack-20261030`

| 항목 | 결과 |
|---|---:|
| 전체 file inventory | 19,981 |
| 전체 PHP 파일 | 17,565 |
| `vendor/`의 PHP 파일 | 15,726 |
| SCIP native index에 수록된 문서 | 696 |
| 그래프 노드 | 29,768 |
| 그래프 관계 | 8,913 |
| `contains` | 8,913 |
| `calls` | 0 |
| `instantiates` | 0 |
| SCIP artifact 크기 | 7,054,517 bytes |
| Source Structure 후보 | 2 |
| 직접 CodeMapService 전체 수행 | 7,741.2 ms |
| 그중 index/decode/hierarchy/projection | 7,428.3 ms |
| 직접 Node 프로세스 최대 RSS | 324.1 MiB |
| PHP 인덱서 샘플 최대 RSS | 116.5 MiB |
| SCIP output root | 새로운 `/tmp/questboard-s7-php-scip-*` 내 외부 저장소 |

주의: PHP RSS는 `ps`로 100ms 간격 샘플링한 값. 프로세스별 최대 시점은 다르며, 단순 합계를 동시 피크라고 해석하지 않는다. PHP 최대 RSS는 하위 프로세스를 포함하지 않는다.

## 2. native SCIP protobuf 참조 원인 분석

`node --max-old-space-size=512 scripts/s7-native-scip-php-reference-audit.mjs`

실제 저장된 `index.scip`를 QuestBoard bundled decoder로 다시 읽은 결과:

| 항목 | 원본 native 건수 |
|---|---:|
| SCIP 문서 | 696 |
| external symbols | 874 |
| document symbols | 8,695 |
| occurrence 전체 | 37,060 |
| 정의 occurrence (roles=1) | 8,913 |
| 참조 occurrence (roles=0) | 28,147 |
| 참조 위치(range) 있음 | 28,147 |
| 정의 `enclosingRange` 있음 | **0** |
| 참조 `enclosingRange` 있음 | **0** |
| symbol information `enclosingSymbol` 있음 | **0** |
| 기존 owner range 후보에 매칭되는 참조 | **0** |

QuestBoard `src/adapters/code-intelligence/scip-normalizer.ts`는 definition `enclosingRange` 내에 있는 reference 발생을 기준으로 owner→target 관계를 복원한다 (예: 현재 795~808행). PHP가 생성한 native SCIP에는 정의·참조가 있으나 정의 전체 lexical scope나 enclosingSymbol이 없다. 그래서 **정규화 단계에서 소유 함수를 결정할 수 없어** calls/instantiates가 0개로 남는다. 이 원인을 증거로 확인하기 전에는 파일-only 0 relation 문제와 구별되지 않았음.

**수정 방향:** PHP 특화 lexical function/method scope를 출처가 확인된 AST (이미 의존하는 nikic/php-parser 5)로 추출하거나, native scope가 있는 다른 인덱서 공급자 사용. 매핑 시 SCIP native 참조 target과 source location을 반드시 대조하여 owner를 명시적으로 검증하고, 검증 안 된 참조로 가짜 call edge를 만들지 말 것. 실제 벤치마크의 semantic calls >0을 수용 조건으로 추가. 현재 의미 관계 보완은 **미구현**.

## 3. 진짜 QuestBoard P1 / P2 프로세스 격리 왕복 검증

`node --max-old-space-size=512 scripts/s7-real-php-isolated-code-map-probe.mjs /tmp/questboard-s7-bookstack-20261030`

- `createConfiguredCodeMapRuntime`에 `scip-php`만 지정하고 독립 임시 snapshot 저장소 사용.
- `createIsolatedCodeMapRefreshExecutor`: child Node process 512 MiB heap / 180s timeout, 실제 PHP indexer + graph decode + hierarchy + projection + pinned snapshot publish 수행.
- `createIsolatedCodeMapReadExecutor`: child read 512 MiB heap / 45s timeout, pinned snapshot summary + bounded `find_nodes(LoginController, limit=5)` 수행.
- 메인 프로세스는 `getCached`로 큰 그래프를 역직렬화하지 않고 bounded receipt/DTO만 수신.

| 실측 항목 | 결과 |
|---|---:|
| Refresh job state | succeeded |
| pinned snapshot nodeCount | 29,768 |
| pinned snapshot relationCount | 8,913 |
| 별도 read status indexed | true |
| bounded LoginController query | 정상, 5개 노드 반환 |
| 메인 parent baseline RSS | 128.8 MiB |
| 메인 parent peak RSS | **130.3 MiB** |
| 부모의 직접 증가분 | **1.5 MiB** |
| index child Node process max RSS | 444.6 MiB |
| bounded read child Node process max RSS | 323.3 MiB |
| 전체 end-to-end elapsed | 10,052.3 ms |
| 소스 root `index.scip` 정리 | true |

**주의:** 444.6 MiB 및 323.3 MiB는 각각 자식 Node 프로세스의 max RSS이다. 116.5 MiB PHP indexer RSS는 앞선 *별도 직접 실행* 실측의 값이고 이 프로세스 트리의 동시 피크 값이 아니다. 이 자료만으로 `444.6+116.5`를 동시 최대나 시스템 메모리 사용 상한으로 주장하지 말 것. 512 MiB Node old-space 제한은 RSS 및 별도 PHP process RSS를 직접 제한하지 않는다.

## 4. 메모리 최적화 후속 발견

- CodeMapService의 file inventory는 BookStack `vendor/`를 포함해 전체 19,981 files / PHP 17,565를 계층화하며, 그중 **15,726 PHP files가 vendor 하위**. 이는 프로젝트 소스 호출 그래프와 별개로 많은 file node/RSS를 생성한다.
- Native SCIP 문서는 696개로 전체 PHP inventory와 차이가 크다. indexer 소스의 실제 분석 범위와 sourceState/coverage 계산을 따로 점검할 것. PHP eligible 17,565 중 native indexed 696을 무조건 `17,565 indexed`로 표시하면 범위 과장 가능성이 있다.
- parent 프로세스 RSS는 주로 완전한 그래프를 IPC로 전달하지 않아서 작게 유지된다. 하지만 Web 전체 그래프 GET과 Flow read는 여전히 대형 그래프를 메인에 hydrate할 수 있음.
- 실제 누적 메모리/성능을 줄이려면 `vendor/`는 탐색 가능한 별도 의존성 영역으로 구분하고 Code Map 초기 화면/계층에 lazy-load나 bounded pagination을 도입하는 것이 바람직. 전체 디렉터리를 무조건 건너뛰면 필요한 외부 참조까지 누락될 수 있으므로 범위 정책과 검증 먼저.

## 5. 다음 수용 기준

1. PHP native SCIP reference 28,147건을 보존하며 신뢰 가능한 lexical owner 범위를 복원, `calls` 또는 `instantiates`의 실제 BookStack 증거 확보. native target과 실제 source lexical scope를 검증한 정확한 edge만 생성.
2. native indexed document coverage vs 17,565 PHP inventory / vendor 경계 계측. UI의 검색/통계/상태 문구가 분석된 문서 범위를 과장하지 않도록 수정.
3. Code Map Web full graph 및 Source Structure/Flow synchronous read 경로를 child bounded query로 옮겨 parent RSS 보호.
4. 5k/20k/50k 실제 semantic scale, cancellation, total process-tree RSS, failed child last-good, stale snapshot pin, HTTP/MCP/Web/Flow parity 실측.
5. 그 뒤에만 S7 최종 GO 및 운영 배포 판단.

재현 스크립트:
- `scripts/s7-verify-composer-phar.mjs`
- `scripts/s7-bookstack-real-scip-php-benchmark.mjs`
- `scripts/s7-native-scip-php-reference-audit.mjs`
- `scripts/s7-real-php-isolated-code-map-probe.mjs`

본문 측정값은 2026-10-30 로컬 격리 fixture에서 얻은 **단회 관측**이다.
