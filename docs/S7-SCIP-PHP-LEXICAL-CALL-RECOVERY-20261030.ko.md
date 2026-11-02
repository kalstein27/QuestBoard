# QuestBoard S7 · SCIP PHP lexical owner + native call recovery (2026-10-30)

> **후속 검증:** Composer root `vendor/` 초기 파일 목록 제외로 BookStack 그래프 노드 29,768→12,400을 확인했다. Native `calls=10,726` / `instantiates=688`는 보존하고, first-party PHP 분석 범위 `696/1,839 partial`을 정확히 표시했다. 최신 근거는 `docs/S7-COMPOSER-VENDOR-SCOPE-COVERAGE-20261030.ko.md` 참조.

## 판정

**PHP 호출/생성 관계 복원: PASS (실제 BookStack + 격리 P1/P2 + 전체 회귀).**
**S7 전체 GO/배포: 보류.** PHP coverage, vendor/ 15,726 files, Web full graph/Flow synchronous read, 실제 process-tree aggregate RSS는 다른 작업.

기존 BookStack 실측 보고서 `docs/S7-BOOKSTACK-REAL-SCIP-PHP-MEMORY-20261030.ko.md`의 `calls=0`은 이번 변경 **이전**의 기준값이다. 이 문서를 갱신된 구현/검증 기준으로 사용한다.

## 원인과 안전한 해결

- 원본 `scip-php` SCIP protobuf: document=696, definition occurrence=8,913, reference occurrence=28,147, native `enclosingRange`/symbol `enclosingSymbol`=0. 기존 normalizer의 소유 함수 추적 관문을 만족하지 못해 `calls=0`.
- 새 `scripts/questboard-php-scip-lexical-scopes.php`는 **PHP Parser 5**로 native SCIP 분석 대상 문서에서 실제 함수/메서드, 익명 함수, arrow-function의 start/end offset을 읽는다. PHP parser 바이트 오프셋은 UTF-16 columns로 변환하며 실제 소스의 lexical 범위만 출력하고 원본 소스 문자열은 IPC에 내보내지 않는다.
- 새 `src/adapters/code-intelligence/php-lexical-scopes.ts`는 `scip-php` 전용, 읽기 전용 child PHP bridge. 경로 canonicalization, 프로젝트 루트 밖 차단, 입력 1MiB, 출력 12MiB, 10k native documents, 150k lexical scopes, 단일 PHP 512MiB memory_limit, 90s timeout.
- `src/adapters/code-intelligence/scip-provider.ts`에서 `loadScipGraphInProcess`가 PHP native 문서만 AST 범위를 수집해 기존 `normalizeScipGraph`에 제공한다. TypeScript/JS SCIP 및 공급자 중립 코어의 계약 유지.
- `src/adapters/code-intelligence/scip-normalizer.ts`: native SCIP 정의의 정확한 **동일 파일 + 같은 이름 + 정의 식별자 시작 열 + 이름 범위 내**에서만 PHP AST scope owner를 승인한다. scope가 중첩되면 가장 좁은 것을 우선한다. 중첩된 익명 함수 또는 이름 매칭에 실패한 scope는 **차단벽(fail-closed)**이다. SCIP 참조 target은 원본 네이티브 symbol을 그대로 사용하고, 직접 `foo(`는 `calls`, `new Foo(`는 `instantiates`, 나머지는 SCIP 의미 롤에 따라 보수적 분류한다.
- 원본 native reference가 아닌 소스 토큰만으로 새 상대 노드를 꾸며내지 않는다. 관계마다 SCIP occurrence 위치 및 provider provenance를 남긴다.

## 실제 BookStack semantic 전체 비교

기존과 동일한 격리 `/tmp/questboard-s7-bookstack-20261030`에서 PHP 8.4.27, Composer 2.11.0, `davidrjenni/scip-php:dev-main` 사용.

| 항목 | 이전 | PHP AST 연결 후 |
|---|---:|---:|
| 전체 inventory 파일 | 19,981 | 19,981 |
| PHP 파일 | 17,565 | 17,565 |
| SCIP native documents | 696 | 696 |
| Graph nodes | 29,768 | 29,768 |
| Graph relations | 8,913 | **28,592** |
| contains | 8,913 | 8,913 |
| calls | **0** | **10,726** |
| instantiates | **0** | **688** |
| 저장된 native `index.scip` 크기 | 7,054,517 bytes | 동일 |
| 전 과정 wall time | 7,741ms | 9,300ms |
| 직접 Node 최대 RSS | 324.1MiB | **301.7MiB** |
| PHP indexer 관측 RSS 최대 | 116.5MiB | 116.5MiB |

메모리 및 처리 시간은 단회 관측으로 재현 시 변동이 있다. PHP 외부 프로세스의 RSS 샘플과 Node 피크는 별도 시점이며 합쳐서 동시 피크라고 주장하지 않는다.

`scripts/s7-php-native-ast-alignment-smoke.mjs`로 실제 70개 SCIP PHP 문서를 다시 검증: 파싱 70/70, 이름 있는 함수·메서드 scope **376개 전부 native 정의 시작 위치 일치 (376/376)**.

## 실제 QuestBoard 독립 child 경로

`scripts/s7-real-php-isolated-code-map-probe.mjs` 로 실제 P1/P2 프로세스 경계에서 재인덱싱.

| 항목 | PHP AST 연결 후 |
|---|---:|
| P1 isolated refresh receipt | succeeded |
| persisted snapshot nodeCount | 29,768 |
| persisted snapshot relationCount | **28,592** |
| P2 child snapshot summary | indexed=true, nodeCount=29,768, relationCount=28,592 |
| P2 bounded LoginController 검색 | 5 nodes 정상 |
| 메인 parent 시작 RSS | 128.8MiB |
| 메인 parent peak RSS | **130.3MiB** |
| P1 index Node child max RSS | **469.7MiB** |
| P2 read Node child max RSS | **412.1MiB** |
| end-to-end wall time | 10,974ms |
| 루트 생성 index.scip cleanup | true |

주의: P1 child peak에는 자식으로 실행된 PHP 자체 RSS가 포함되지 않는다. 따라서 total process tree simultaneous RSS는 이 수치에서 추정할 수 없다. 프로젝트 소스나 운영 DB/Flow는 변경하지 않으며 snapshot은 새 임시 스토리지에만 생성했다.

## 회귀와 수용

- `tests/scip-php-lexical-owner.test.ts` 3개 신규 테스트: native 식별자 위치 일치한 직접 호출과 객체 생성, 익명 closure 차단, 이름/범위 불일치 시 fail-closed.
- 기존 `scip-php-provider.test.ts` 4개 PASS, TypeScript Code Map 및 HTTP/MCP/P1/P2/Flow 기존 회귀 유지.
- 최종 `npm run verify`: **334/334 tests PASS**, TS typecheck, Web syntax, Node race PASS.
- `/opt/homebrew/opt/php@8.4/bin/php -l scripts/questboard-php-scip-lexical-scopes.php`: syntax PASS.
- `scripts/s7-bookstack-real-scip-php-benchmark.mjs`은 이제 calls와 instantiates가 0개이면 성공 판정을 금지하는 단순 실측 수용 관문을 가진다.

## 미완료/다음 작업

1. **정확도**: 클래스·메서드 이름이 문자열 중복되거나 `$closure`·callable dispatch·동적 invocation이 있는 PHP에서 scope-owner/target false-positive/false-negative 추가 검증, 증거 없는 call edge는 생성하지 않는다. 매핑된 native occurrence 대비 보존/누락 카운터 계측.
2. **coverage**: BookStack inventory PHP 17,565 중 native SCIP 문서 696개의 분석 경계와 vendor/ 15,726 파일의 구분 정책 정립. native document coverage 696을 전체 PHP 17,565 분석 완료로 표시하지 않는다.
3. **메모리**: 중규모에서 main parent 130.3MiB로 안정적이나 index/read child는 각각 469.7/412.1MiB이다. 별도 PHP 및 동시 process tree peak RSS/5k·20k·50k scale, 실패/취소/마지막 정상 스냅샷 보존 검증 필요.
4. **P2 잔여**: Web 전체 `GET code-map`과 Source Structure/Flow synchronous read의 대형 `getCached` 경로 분리, authenticated Apply/Flow 보존.
5. S7 전체 GO, commit/push, 운영 서비스 재시작/배포는 별도 승인 및 수용 기준 통과 전까지 보류.

재현 명령:

```bash
npm run verify
/opt/homebrew/opt/php@8.4/bin/php -l scripts/questboard-php-scip-lexical-scopes.php
node --max-old-space-size=512 scripts/s7-bookstack-real-scip-php-benchmark.mjs /tmp/questboard-s7-bookstack-20261030
node --max-old-space-size=512 scripts/s7-php-native-ast-alignment-smoke.mjs
node --max-old-space-size=512 scripts/s7-real-php-isolated-code-map-probe.mjs /tmp/questboard-s7-bookstack-20261030
```
