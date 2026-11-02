# QuestBoard S7 · Composer vendor 초기 트리 경량화 + PHP 원본 SCIP 분석 범위 검증 (2026-10-30)

## 판정

- **Composer root vendor 초기 file inventory 경량화: PASS**, 실제 BookStack A/B 및 SCIP semantic facts 유지 확인
- **PHP native SCIP 문서 범위 / first-party PHP coverage 정정: PASS**, bounded P1/P2 조회 실증
- **PHP 호출·객체생성 facts 유지: PASS**, calls 10,726 / instantiates 688 / 관계 28,592
- **S7 전체 GO 및 운영 배포: 보류**, Web full graph/Flow sync/총 프로세스 트리 RSS/상세 회귀·크기 부하 미완료

## 구현 경계

1. `src/adapters/code-intelligence/file-inventory.ts`는 **루트** `composer.json`과 `composer.lock`이 모두 있는 프로젝트에 한해 **루트 `vendor/`** 하위 파일을 기본 source inventory에서 제외한다. 예외적으로 `includeComposerDependencies: true`로 기존 전체 file inventory를 조회하는 진단/비교 기능을 제공한다. `src/vendor/` 등 중첩된 1차 소스 디렉터리, Composer manifest 없는 일반 프로젝트, 기존 `node_modules` 무시 정책은 바꾸지 않는다. provider-native SCIP external symbol/refs/calls는 절대 삭제하지 않는다.
2. `src/adapters/code-intelligence/scip-normalizer.ts`에서 bundled SCIP protobuf Language enum **19=PHP** 확인 후 숫자 문자열 `"19"` 또는 숫자 `19`를 `php`로 정규화한다. 기타 알 수 없는 숫자 언어 코드는 검증 가능한 파일 확장자로만 보수적으로 결정하여 가짜 언어 이름을 쓰지 않는다.
3. `src/adapters/code-intelligence/scip-php-provider.ts`, `scip-provider.ts`, `scip-normalizer.ts`는 PHP provider의 **실제 first-party eligible PHP paths**를 SCIP 로더에 전달한다. `semanticIndexedFileCount`는 네이티브 SCIP PHP 문서와 first-party PHP 파일 경로의 **교집합**이다. SCIP가 dependency `vendor/` 문서를 함께 배출해도 first-party 분석 완료 수가 부풀려지지 않는다. Node in-process / Worker graph loader 경로 동일하게 적용된다.
4. `coverage.languages.php`에는 `eligibleFileCount=1839`, `indexedFileCount=696`이 표시되고, `semanticCoverage=partial`, `gapReason=partial_coverage`이다. `providerHealth=degraded`는 이 실제 의미 분석 미완료를 나타내는 registry 규칙이며 프로세스 실패가 아니다.

## 동일한 코드에서 BookStack 의존성 포함/제외 A/B

PHP 8.4.27, BookStack `development` 별도 `/tmp/questboard-s7-bookstack-20261030`, Composer 2.11.0, `davidrjenni/scip-php:dev-main`, 동일 SCIP indexer/native graph 로직, 두 실행의 새 임시 외부 snapshot만 사용. 기존 사용자 작업/운영 DB/Flow 미수정.

| 항목 | 기존 `--legacy-vendor-inventory` | 기본 `vendor` 제외 |
|---|---:|---:|
| 파일 inventory | 19,981 | **2,613** |
| PHP inventory | 17,565 | **1,839** |
| 포함된 `vendor/` PHP | 15,726 | 0 |
| 그래프 노드 | 29,768 | **12,400** |
| 총 관계 | 28,592 | **28,592** |
| `calls` | 10,726 | **10,726** |
| `instantiates` | 688 | **688** |
| `contains` | 8,913 | **8,913** |
| SCIP binary 크기 | 7,054,517 bytes | 동일 |
| Node 단일 프로세스 peak RSS | 290.7 MiB | **266.9 MiB** |
| 단일 실행 경과 | 8,818.8 ms | **8,123.3 ms** |
| file inventory 단계 | 604.7 ms | **76.8 ms** |

- **17,368 파일 노드 절감 (58.3%)**, 초기 file inventory 자체도 86.9% 적다.
- 관찰된 **Node RSS 23.8 MiB 감소 (약 8.2%)**. 직접 A/B도 단회 측정이며 GC/프로세스 스케줄링 영향으로 항상 같은 감소량을 보장하지 않는다.
- Native PHP 호출·생성 관계와 다른 관계는 같은 수로 유지됐다. 이는 의미 참조를 삭제하지 않고 초기 탐색 트리만 변경했다는 증거다.
- 완전한 외부 파일 explorer의 지연 로딩/상세 vendor browse UI는 이번 단계에 구현하지 않았다. 추후 명시적 dependency subtree 조회를 만들 수 있으나 현재 기본 조회에는 포함되지 않는다.

## native SCIP PHP coverage gap 분해

`scripts/s7-native-php-coverage-gaps.mjs`는 별도 보관된 native `index.scip` 바이너리에서 각 document path를 읽어 실제 1차 소스 inventory와 교차 검증했다.

| 항목 | 개수 |
|---|---:|
| first-party PHP 파일 | 1,839 |
| native SCIP PHP 문서 | 696 |
| native+first-party 일치 | **696** |
| 아직 SCIP 문서가 없는 PHP 파일 | **1,143** |
| first-party 외 native PHP 문서 | 0 |

native indexed 문서의 top-level 분포: `app/` 503, `tests/` 167, `database/` 26.

unindexed first-party PHP 분포: `lang/` **689**, `resources/` **325**, `database/` **104**, `app/` **19**, `bootstrap/` 2, `routes/` 2, `dev/` 1, `public/` 1.

이 PHP 파일들이 모두 의미 함수 정의를 포함한다는 뜻은 아니다 (번역/설정/뷰 PHP 등이 섞여 있다). 하지만 **SCIP가 이 파일을 분석하지 않았다는 사실**은 그대로 partial coverage로 표시한다. 파일 경로나 디렉터리 이름만으로 사용자 코드를 무조건 '완료' 또는 '비대상'으로 단정하지 않는다.

## 실제 P1 + P2 프로세스 경계

`node --max-old-space-size=512 scripts/s7-real-php-isolated-code-map-probe.mjs /tmp/questboard-s7-bookstack-20261030`

| 항목 | 최종 재실측 |
|---|---:|
| P1 child indexed snapshot | nodes=12,400, relations=28,592 |
| P2 bounded status | indexed=true, native indexed=696/first-party eligible=1,839, coverage=partial |
| P2 bounded `LoginController` search | 5 nodes |
| 메인 parent baseline RSS | 128.5 MiB |
| 메인 parent peak RSS | **129.9 MiB** |
| index Node child 최대 RSS | **485.3 MiB** |
| read Node child 최대 RSS | **359.4 MiB** |
| end-to-end 실행 | 10,438.1 ms |
| 프로젝트 원본 `index.scip` cleanup | true |

중요: 각 Node RSS는 별도 프로세스 maxima이며 PHP child RSS는 index Node child peak에 포함되지 않는다. 전 프로세스 동시 최대 RSS는 **미측정**. 일부 샘플에서 index child RSS는 최적화 전보다 높을 수 있으므로, 이번 A/B의 **Node 직접 프로세스 감소**와 자식 프로세스 최적화 효과를 혼동하지 않는다. 메인 데몬 RSS 격리는 유지됐다.

## 자동 회귀, 안전 조건

- `tests/code-map-hierarchy.test.ts`: Composer root vendor opt-in / first-party nested vendor 보존 / 외부 semantic symbol 보존 / 일반 vendor 미제외.
- `tests/scip-normalizer.test.ts`: SCIP numeric `19` / `"19"` PHP 언어 식별.
- `tests/scip-php-provider.test.ts`: first-party PHP 2개, 실제 native first-party 1개, native vendor 문서 1개인 경우 인덱싱 수 1로 정정.
- 원본 Composer repository 변경: 기존 사용자가 설치한 `composer.json`/`composer.lock` 외에 없음. Git commit/push/운영 배포 없음.
- **최종 `npm run verify` PASS: 337/337 tests**, TypeScript typecheck, Web syntax, concurrent race PASS. 최종 명령 종료 코드 0, 기존 회귀 실패 0.

## 다음 작업 (S7 범위)

1. Web `GET /projects/:id/code-map`에 남은 전체 raw graph parent hydration과 Flow source structure synchronous read를 P2 bounded child 조회로 치환. pin identity/HTTP auth/Flow transactional Apply 보존.
2. 초기 Web에서 외부 종속성의 명시적 탐색 요구 시, 파일 목록 전체 반환이 아닌 제한된 페이지/하위 트리 요청 설계. 현재 vendor/ 제외는 단순 default file-tree 최적화이지 전면 lazy browsing 기능이 아니다.
3. 5k/20k/50k 프로젝트, child cancellation/timeout/last-good, PHP+Node 전체 프로세스 트리 RSS 동시 피크, multi-snapshot concurrent read, HTTP/Web/Flow parity 측정.
4. S7 전체 검증 통과 뒤 별도로 S8 및 운영 배포 결정. QuestBoard 운영 DB/Flow와 53+ dirty 파일 보존.
