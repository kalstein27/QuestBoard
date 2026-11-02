# QuestBoard S7 · Composer 2.11.0 독립 실행 검증 및 BookStack SCIP PHP 준비 (2026-10-30)

## 판정

- **Composer 2.11.0 standalone PHAR 다운로드/공식 체크섬 검증/실행: PASS**
- **PHP 8.4.27 실행: PASS**
- **BookStack 공개 저장소 얕은 복제: PASS**, 개발 브랜치 `composer.json`/`composer.lock` 확인, `git status --porcelain` 깨끗함
- **격리 BookStack Composer validation: PASS** (`composer validate --no-check-publish` 종료 코드 0, `./composer.json is valid`)
- **BookStack 잠금 의존성 설치: PASS**, 149개 패키지 설치, `vendor/autoload.php` 확인, 설치 후 Git 관리 파일 변경 없음
- **scip-php dev-main 설치: PASS**, 사용자 수동 설치 후 로컬 `vendor/bin/scip-php` 실행 권한 및 Composer package metadata 확인
- **실제 semantic index/RSS 측정: PASS (부분)**, source references=28,147, raw calls=0 원인 조사 완료. 전체 결과는 `docs/S7-BOOKSTACK-REAL-SCIP-PHP-MEMORY-20261030.ko.md` 참조

## 확인한 런타임과 안전 경계

- PHP 경로: `/opt/homebrew/opt/php@8.4/bin/php`, 실제 버전 `8.4.27`.
- 독립 Composer: `/tmp/questboard-s7-composer-2.11.0.phar`, PHP 8.4.27에서 `Composer version 2.11.0` 실행 성공.
- 공식 SHA-256: `9674f12a2a181100d889ebfd0b4510805b3e94cea57869b14b383753d602599b`.
- 실측: `node scripts/s7-verify-composer-phar.mjs`가 `officialSha256Verified:true`, 3,786,815 bytes로 판정. 스크립트는 파일을 128 KiB 단위로 읽고 명령을 실행하지 않음.
- 전역 Composer 설치, `brew link`, 운영 QuestBoard DB/Flow 수정, Git commit/push, MCP 서비스 변경 **없음**.
- 사전 QuestBoard dirty 파일 보존; S7 메모리 프로브 `scripts/s7-bookstack-real-scip-php-benchmark.mjs` 추가, 문서 갱신. Git commit/push 없음.

## 공개 PHP 중규모 fixture

- BookStack 공식 GitHub: `https://github.com/BookStackApp/BookStack`.
- `development` 브랜치에 `composer.json` 및 `composer.lock` 포함. Laravel 기반 PHP 문서 관리 앱이며 Composer 2.x, PHP 8.2+ 요구.
- 격리 임시 위치: `/tmp/questboard-s7-bookstack-20261030`.
- `git clone --depth 1 --branch development --single-branch --no-tags` 승인 이후, 독립 디렉터리 존재와 `.git`, `composer.json`, `composer.lock`, 깨끗한 `git status --porcelain`을 확인. Git HEAD 읽기는 성공했지만 출력 redaction으로 해시 원문 미공개. `QuestBoard` 트리는 변경하지 않음.
- 격리 fixture Composer install은 사용자가 해당 승인 카드에서 허용한 정확한 단일 명령으로 실행됐고, operation_status가 completed/exit 0을 확인했으며 output_read에서 149개 설치 및 optimized autoload 생성을 확인했다. 중복 실행 없음.

## SCIP PHP 제약과 안전한 다음 단계

- 공식 upstream `https://github.com/davidrjenni/scip-php`의 최신 `main` composer.json은 PHP `^8.3`, `nikic/php-parser ^5.0`, `google/protobuf ^5.34`을 요구. PHP 8.4.27와 PHP 버전 조건은 호환.
- QuestBoard `ScipPhpProvider`는 대상 프로젝트에 `composer.json`, `composer.lock`, `vendor/autoload.php`, 실행 가능한 `vendor/bin/scip-php`를 모두 요구. 실행 시 root에 새 `index.scip`를 쓰고, 외부 storageRoot로 복사한 다음 해당 생성 파일을 지운다. **원본/운영 저장소에서는 실행 금지**.
- BookStack locked dependencies 설치는 승인된 단일 명령으로 종료 코드 0, 149 installs/0 updates/0 removals, optimized autoload 생성 완료. `vendor/autoload.php` 및 깨끗한 Git 관리 파일 상태 확인.
- `davidrjenni/scip-php:dev-main`을 사용자가 격리 BookStack checkout에 수동 설치했다. `composer show`에서 dev-main, PHP ^8.3, nikic/php-parser ^5.0 요구사항을 확인했고 `vendor/bin/scip-php` 실행 권한과 autoload를 확인. 이 문서 이전에 만료된 승인 명령은 재전송하지 않음.
- 실제 `scripts/s7-bookstack-real-scip-php-benchmark.mjs` 실행 7.74초, PHP sample peak RSS 116.5MiB, direct Node peak 324.1MiB. 별도 P1 index/P2 bounded read 실측에서 parent peak 130.3MiB, index child 444.6MiB, read child 323.3MiB. Native references 28,147건이나 current normalizer calls 0으로 semantic call-graph 정확성은 NO-GO. 전체 수치는 상세 보고서 참조.
- 테스트용 `scip-php`는 프로젝트 로컬 dev dependency로 추가해야 하므로 `composer.json`과 `composer.lock` 변경이 격리 fixture에 한해 발생할 수 있다. 프로젝트 repo를 절대 변경하지 않는다. 버전/commit과 변경 패키지를 기록하고 PHP Parser 버전 충돌은 우회하지 않는다.
- Composer install/require network 및 파일 변경에 별도 승인 필요. 명령 승인/미지원 시 실행하지 말고 정확한 blocker를 남긴다.
- 실제 semantic run에서 child PHP RSS + Node decoder/normalizer + IPC/projection + Code Map read subprocess RSS/time, `index.scip` 크기, symbols/references/calls/evidence 수를 별개로 계측. 단순 파일 0 relations는 semantic success로 오인 금지.
- S7 전체 GO 및 P2 전체 완료, 운영 배포 아직 아님.

## 외부 참조

- Composer 릴리스 및 checksum: `https://getcomposer.org/download/`.
- BookStack repo composer/lock: `https://github.com/BookStackApp/BookStack/tree/development`.
- scip-php 요구조건: `https://github.com/davidrjenni/scip-php`.

재현 (읽기 전용):
```bash
/opt/homebrew/opt/php@8.4/bin/php -v
/opt/homebrew/opt/php@8.4/bin/php /tmp/questboard-s7-composer-2.11.0.phar --version
node scripts/s7-verify-composer-phar.mjs
```
