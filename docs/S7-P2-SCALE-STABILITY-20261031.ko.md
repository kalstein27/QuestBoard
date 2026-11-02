# QuestBoard S7 · P2 대규모 조회와 프로세스 안정성 검증 (2026-10-31)

## 판정

**P2 스케일·자식 정리·IPC·스냅샷 무결성 하위 작업 PASS. S7 전체 GO 및 운영 배포는 보류.**

- 합성 5천/2만/5만 노드, 최대 91,665 관계: 동시 자식 2, 대기 1, 네 번째 요청 즉시 거부 PASS.
- 측정용 부모에서는 getCached를 예외 처리하여 full graph 적재를 금지. 합성 스냅샷 생성과 저장은 별도 프로세스에서만 실행.
- 100ms timeout 후 자식 잔존 0, 소유 프로세스 정상 종료 후 실행 중 read child 제거 PASS.
- IPC 출력 1MiB 초과 시 거부 PASS. 변조된 snapshotId는 indexed=false 및 hydrationRejectReason=identity_invalid로 fail-closed.
- 실제 BookStack SCIP/PHP 인덱싱과 bounded read, Source Structure, Code→Flow preview PASS. PHP 696/1,839 의미 색인 범위는 여전히 partial이며 완료로 과장하지 않는다.

## 합성 스케일 실측

샘플링: 150ms 간격 macOS ps를 이용해 현재 부모와 실제 자식의 RSS를 합산. 측정용 ps 프로세스 자신은 제외한다. P2 child Node heap 512MiB. 모두 프로젝트 외부 임시 fixture.

| 노드 | 관계 | 저장 JSON | 부모 RSS 최대 | 조회 자식 RSS 최대 | 동시 트리 RSS 최대 | 병렬 조회 시간 |
|---:|---:|---:|---:|---:|---:|---:|
| 5,000 | 9,165 | 2.13 MB | 133.1 MiB | 185.4 MiB | 386.9 MiB | 770 ms |
| 20,000 | 36,665 | 8.64 MB | 132.9 MiB | 293.0 MiB | 678.3 MiB | 1,385 ms |
| 50,000 | 91,665 | 21.76 MB | 136.2 MiB | 409.2 MiB | 910.1 MiB | 2,479 ms |

합성 결과이지 실제 5만 PHP 소스 색인 또는 성능 SLA가 아니다. 메모리는 150ms 비원자적 샘플의 관측 최고치로, 더 짧은 피크는 놓칠 수 있다. 최대 동시 프로세스는 부모 + 조회 child 2 = 3.

## 실제 BookStack/PHP 프로세스 트리

- 12,400 노드 / 28,592 관계 유지, PHP 의미 색인 696/1,839 partial.
- 부모 baseline 129.0 MiB, 최대 139.3 MiB. 인덱싱 Node 자식 최대 485.8 MiB, 조회 Node 자식 최대 359.5 MiB.
- **동시 프로세스 트리 RSS 관측 최대 486.7 MiB**, 최대 3개 프로세스, 총 101개 샘플. 중첩 PHP 자식 실제 관측 확인.
- 최초 555.5 MiB 수치는 관측 도구 ps 자신을 트리에 포함시킨 오류값. 최종 측정은 ps를 제외한 486.7 MiB.
- 개별 child 최대치의 합계는 전체 시스템 동시 최대치가 아니다. PHP 외 다른 프로세스는 이 수치에 포함되지 않는다.

## 안전성과 테스트

실행 경로:
- scripts/s7-p2-scale-stability-probe.mjs: synthetic 스냅샷 생성은 별도 Node 프로세스, 측정 부모는 read 전용, 완료 시 임시 데이터 정리. timeout/owner exit/oversize IPC/identity tamper 음성 테스트 포함.
- scripts/s7-real-php-isolated-code-map-probe.mjs: 실제 BookStack P1+P2 프로브에 ps 기반 process-tree RSS 관측만 추가. 기존 BookStack 복제본의 소스, 운영 DB, Flow, Git HEAD는 변경하지 않음.

이번 작업의 서비스 런타임 변경은 없음. 이전 인수인계 docs/S7-P2-WEB-FLOW-ISOLATED-READ-20261030.ko.md의 전체 회귀 339/339 PASS를 재사용한다. 스크립트 syntax 및 Git diff 체크를 별도 수행한다.

## 다음 작업과 보류 조건

- Source Structure Flow Apply, Code Map → Investigation Apply, CodeScope mutation 등의 **트랜잭션 내부 동기 전체 그래프 적재**에 대한 인증·CAS 유지형 격리 설계/검증.
- 실제 브라우저에서 폴더 확장, 검색, 심볼 Inspector, Source→Flow 및 Code→Flow 대화상자 E2E 확인.
- 사용자의 명시 취소 또는 HTTP 연결 종료를 read worker까지 전파하는 기능은 아직 별도 구현/검증하지 않았음. Timeout·소유 프로세스 종료 정리 검증으로 대체했다고 주장하지 않음.

지금은 **S7 P2 스케일 안정성 PASS, S7 전체 NO-GO**. Commit/push/배포 없음.
