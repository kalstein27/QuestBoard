# QuestBoard S7 공개 Laravel Framework PHP 인덱싱·메모리 실측, 2026-10-22

**상태: PARTIAL / PHP 의미 분석 미실행 / S7 최종 GO 아님.**

## 재현용 공개 소스와 보호 경계

- 공개 GitHub: https://github.com/laravel/framework, Git shallow clone: `/tmp/questboard-s7-laravel-framework-20261022`.
- 실제 수집 파일 3,480개, PHP 3,166개(90.98%). 원본 checkout Git clean 확인.
- 실제 PHP `composer.lock`, `vendor/autoload.php`, `vendor/bin/scip-php` 부재. 로컬 `php`, `composer`, `docker`, `podman` 실행 불가. PHP SCIP semantic indexing은 **BLOCKED**, raw semantic node/call 수 **미측정**. 관계 0은 parser 부재로 인한 file-only 사실이며 PHP 코드에 실제 호출이 없다는 뜻이 아님.
- QuestBoard 운영 DB·스냅샷·Flow·MCP 서비스 사용/변경 없음. Git commit/push/deploy/restart/설치 없음. 사전 dirty 파일 31개 보존.

## 실제 Laravel 파일 인벤토리/계층/CodeMapService 측정

`scripts/s7-public-php-memory-probe.mjs`에서 QuestBoard 실제 `FileSystemCodeFileInventory`, `materializeCodeFileHierarchy`, `CodeMapService.refresh`, `querySourceSubsystems` 실행. 가짜 semantic node/call은 절대로 만들지 않는다.

| 단계 | 최적화 전 | 최적화 후 |
|---|---:|---:|
| 파일 목록 탐색 | 85.1 ms | 49.0 ms |
| canonical file hierarchy | 269.8 ms | 11.7 ms |
| CodeMapService refresh | 318.3 ms | 48.6 ms |
| Source Structure 조회 | 0.9 ms | 0.8 ms |
| 전체 실측 | 676.3 ms | 112.2 ms |
| Node 단일 프로세스 최대 RSS | 86.66 MiB | 83.27 MiB |

출력: file nodes 3,480개, raw semantic relations 0, subsystem candidates 0. 측정마다 cold/warm cache·GC·시스템 부하가 달라질 수 있으며 단회 수치임.

## Laravel 경로 기반 synthetic 확장 부하

`scripts/s7-synthetic-php-scale-probe.mjs`는 실제 Laravel path distribution을 synthetic_group으로 복제해 5k/20k/50k 파일 노드만 생성. **실제 PHP 인덱서도 실제 20k PHP 소스도 아니며 호출 관계는 전부 0**.

| synthetic nodes | hierarchy 전 | hierarchy 후 | Code Map refresh 전 | refresh 후 | 최적화 후 피크 RSS |
|---|---:|---:|---:|---:|---:|
| 5,000 | 532.1 ms | 19.4 ms | 532.8 ms | 26.0 ms | 92.7 MiB |
| 20,000 | 7,873 ms | 57.6 ms | 7,725.6 ms | 78.2 ms | 166.4 MiB |
| 50,000 | 미실행 | 129.1 ms | 미실행 | 196.4 ms | 235.9 MiB |

수정 전 20k 최대 RSS는 140.0 MiB, 수정 후 166.4 MiB. **메모리 절감으로 해석 불가**. 수정 전 5k/20k 작업은 일시 중첩되어 wall-clock 비교에 환경 차이가 존재. 최적화 후 50k는 Node `--max-old-space-size=512` 내 성공.

## 확인된 병목 및 최소 코드 수정

`src/application/code-map-hierarchy.ts`에서 파일마다 `nodes.find()`로 첫 provider 언어를 찾던 O(files × nodes) 접근을 `firstKnownLanguageByPath` Map 한 번 구축/조회로 교체. 우선순위 `entry.language > first provider language > extension inference` 유지.

`tests/code-map-hierarchy.test.ts`에 extensionless provider PHP language fallback + 20k unique file paths 빠른 처리 회귀 추가.

검증: `npm:build` PASS, `npm:typecheck` PASS, `npm:check:web` PASS, **`npm:test` 324/324 PASS** (0 fail, 0 skipped), `npm:test:race` PASS.

## 다음 검증

1. 별도 승인된 격리 PHP/Composer/`davidrjenni/scip-php` 런타임과 composer.lock/vendor가 준비된 중규모 PHP 앱 사용. Laravel Framework 단독 clone에는 lockfile이 없어 그대로는 SCP PHP 실행 불가.
2. 실제 scip-php child process RSS/CPU/time, 생성된 `index.scip` 크기, Worker decode peak RSS, normalizer graph node/edge/원본 call evidence, persistence/cached snapshots의 피크/GC 후 retained heap을 독립 측정.
3. 5k/20k/50k 실제 semantic/dense relation test, HTTP/MCP/Web/Flow Preview 및 인증/기존 dirty/운영 DB 보존을 검증한 뒤 S7 GO/NO-GO 재평가.
4. 서버 측 권한 없는 Apply 잠금 유지. 원본 비공개 PHP 소스·SCIP raw 업로드 요구 금지. 사용자의 별도 승인 없이 commit/push/배포/운영 DB·Flow 변경 금지.

재현:
```bash
node scripts/s7-public-php-memory-probe.mjs /tmp/questboard-s7-laravel-framework-20261022
node --max-old-space-size=512 scripts/s7-synthetic-php-scale-probe.mjs 5000
node --max-old-space-size=512 scripts/s7-synthetic-php-scale-probe.mjs 20000
node --max-old-space-size=512 scripts/s7-synthetic-php-scale-probe.mjs 50000
```
