# Code Map persisted snapshot hydration 계획

상태: 구현 완료 / independent review blocker 수정 완료 / 독립 재리뷰 대기

관련 Task: `5f061fcb-6ad1-4278-adbc-182359ab8166`

## 목표

Managed MCP 업데이트나 QuestBoard service 재시작만으로 Code Map을 다시 인덱싱하지 않는다.

이미 성공적으로 만든 provider-neutral `CodeGraphSnapshot`을 `QUESTBOARD_CODE_MAP_STORAGE_ROOT` 아래에 외부 상태로 영속화하고, 다음 프로세스가 이를 안전하게 hydrate해 즉시 query / Investigation sync / Flow 연결에 사용한다.

핵심 사용자 경험은 다음과 같다.

- 서비스 재시작 / Managed MCP 업데이트: persisted snapshot 자동 복원, 재인덱싱 없음.
- 코드 변경 감지: 기존 snapshot을 계속 사용하되 `stale` 상태만 표시. 자동 재인덱싱하지 않음.
- 재인덱싱: 사용자가 `Refresh / Re-index`를 명시적으로 실행할 때만 수행.
- 구조적으로 신뢰할 수 없는 snapshot: hydrate하지 않고 fail-closed.

## 핵심 원칙

1. **변경 감지와 재인덱싱을 분리한다.**
   - source 변경은 freshness 신호일 뿐 실행 트리거가 아니다.
   - 파일 저장, git checkout, branch 이동 때문에 뒤에서 SCIP가 자동 실행되지 않는다.

2. **명시적 refresh만 fresh index를 실행한다.**
   - `questboard_refresh_code_map` 및 동등 HTTP refresh는 persisted snapshot 존재 여부와 무관하게 실제 provider index를 실행한다.

3. **persist 대상은 최종 provider-neutral graph다.**
   - `index.scip` 같은 provider artifact만 재활용하지 않는다.
   - file inventory, composite merge, coverage를 포함한 최종 `CodeGraphSnapshot`을 저장한다.
   - architecture projection은 graph에서 다시 파생 가능하므로 canonical persisted source는 raw graph다.

4. **원본 project checkout은 읽기 전용이다.**
   - snapshot/manifest/temp 파일은 모두 `QUESTBOARD_CODE_MAP_STORAGE_ROOT` 아래에만 둔다.

5. **복구 실패가 QuestBoard 기동 실패가 되어서는 안 된다.**
   - corrupt / unknown-version / incompatible snapshot은 무시하고 Code Map만 unavailable-to-query 상태로 둔다.

## 제안 저장 형식

프로젝트별 versioned envelope 예시:

```text
<storageRoot>/snapshots/<project-key>/snapshot.json
```

Envelope 최소 필드:

- formatVersion
- graphSchemaVersion
- projectId
- canonicalRootPath 또는 안전한 root identity
- providerConfigFingerprint
- sourceManifestFingerprint
- persistedAt
- graph: CodeGraphSnapshot

쓰기 방식:

1. temp 파일에 serialize
2. fsync/close가 필요한 범위에서 안전하게 마감
3. atomic rename으로 current snapshot 교체

partial write를 current snapshot으로 읽지 않는다.

## Hydration 흐름

프로세스가 시작된 뒤 해당 project의 Code Map이 처음 필요해지는 시점에 lazy hydration을 우선한다.

1. 메모리 cache 확인
2. 없으면 persisted snapshot 탐색
3. envelope parse/validation
4. projectId / root identity / graph schema / provider config compatibility 확인
5. graph 자체 `assertValidCodeGraphSnapshot` 검증
6. 현재 source manifest fingerprint 계산
7. 동일하면 `freshness=current`, 다르면 `freshness=stale`
8. 둘 다 graph는 hydrate하고 query 가능하게 함
9. projection은 hydrate된 graph에서 다시 계산
10. provider index 호출은 하지 않음

startup 전체 프로젝트 eager hydration은 피한다. 사용하지 않는 project 때문에 시작 비용을 늘리지 않는다.

## Freshness 정책

### hydrate 허용 + current

- snapshot envelope 정상
- project/root/schema/provider config 호환
- source manifest fingerprint 동일

### hydrate 허용 + stale

- 구조적으로 호환되는 snapshot
- source manifest fingerprint만 달라짐

이 경우:

- `indexed=true`
- query 가능
- Investigation preview / Flow 연결 가능
- status에서 stale 표시
- 자동 refresh 금지

### hydrate 거부

다음은 기존 graph의 의미 자체를 신뢰하기 어렵기 때문에 hydrate하지 않는다.

- corrupt JSON / incomplete write
- unsupported persisted format version
- incompatible CodeGraph schema version
- projectId mismatch
- canonical root identity mismatch
- provider 구성/fidelity contract의 incompatible change
- graph validation failure

이 경우 `indexed=false` 또는 동등한 unavailable 상태로 두고 명시적 refresh를 안내한다.

## Source manifest

목적은 "자동 재인덱싱 여부" 판단이 아니라 stale 표시를 위한 저비용 비교다.

권장:

- provider-neutral file inventory 범위와 동일한 source set 사용
- relative path + bounded file metadata/content digest로 deterministic fingerprint 생성
- dependency/generated directories 제외 규칙은 기존 inventory 규칙 재사용
- git HEAD에만 의존하지 않음
  - dirty working tree
  - non-git project
  - branch 변경
  모두 처리 가능해야 함

manifest 계산 실패는 자동 index로 보상하지 않는다. 보수적으로 freshness unknown/stale로 표시하고 persisted graph 사용 가능 여부는 별도 구조 검증에 따른다.

## Status 계약

기존 bounded lifecycle status를 유지하면서 다음 정도의 진단을 추가한다.

- `indexed: true|false`
- `snapshotSource: fresh-index | persisted`
- `freshness: current | stale | unknown`
- `staleReason` 필요 시 bounded enum
  - `source_changed`
  - `source_check_failed`

구조 incompatibility로 hydration 자체가 거부된 경우에는 기존 indexed=false 상태와 bounded reason을 사용한다.

절대 노출하지 않을 것:

- absolute root path
- 전체 manifest
- 전체 graph
- 로컬 사용자/호스트 경로

## 구현 단위

### Phase 1. Persistence port/store

- application 쪽에 provider-neutral persisted snapshot contract 정의
- filesystem adapter 구현
- atomic write / bounded read / version validation

### Phase 2. CodeMapService hydration

- `#cache` miss 시 persisted load 가능하도록 경계 추가
- projection 재생성
- provider registry report가 hydrated graph를 정상 사용
- explicit refresh 성공 후 persisted snapshot 업데이트

### Phase 3. Freshness manifest

- 기존 `FileSystemCodeFileInventory`의 제외 규칙 재사용
- deterministic manifest fingerprint 계산
- source mismatch는 stale 표시만 하고 graph는 유지
- 자동 provider execution 금지

### Phase 4. Lifecycle surfaces

- agent/MCP `questboard_get_code_map_status`
- HTTP status
- Web Code surface

에서 persisted/current/stale를 bounded하게 표시한다.

### Phase 5. Dogfood

QuestBoard 및 ChatGPT2Codex 실제 checkout으로:

1. 명시적 fresh index
2. service 완전 재시작
3. provider index 호출 없이 hydrate
4. 동일 query 결과 확인
5. source 파일 변경 후 재시작
6. persisted graph 유지 + stale 표시 + provider 호출 0 확인
7. 명시적 refresh
8. 그때만 provider 실행 + stale 해제 확인

## Acceptance

필수 acceptance:

1. fresh index 후 persisted final graph가 external storage에 생성된다.
2. 새 `CodeMapService` / 새 process에서 provider `indexProject()` 호출 0회로 snapshot을 복원한다.
3. 복원 직후 `indexed=true`이며 기존 node/relation/query 결과가 유지된다.
4. source 변경 후에도 provider 호출 0회, snapshot hydrate 성공, `freshness=stale`이다.
5. stale snapshot에서도 bounded query와 Investigation preview가 동작한다.
6. source 변경만으로 background/automatic refresh가 발생하지 않는다.
7. 명시적 refresh는 항상 provider를 실제 실행하고 새 snapshot으로 교체한다.
8. refresh 후 freshness가 current로 돌아온다.
9. corrupt snapshot은 daemon을 죽이지 않고 hydrate를 거부한다.
10. format/schema/root/project/provider incompatibility는 fail-closed다.
11. persisted state는 project repository 밖에만 생성된다.
12. status/query에서 local absolute rootPath가 새지 않는다.
13. `npm run verify` 및 관련 restart/persistence regressions PASS.
14. 실제 Managed MCP update/restart 후 재인덱싱 없이 Code Map이 즉시 살아난다.

## 명시적 비목표

- 파일 변경 watcher가 자동으로 SCIP를 실행하는 기능
- background continuous indexing
- provider 자동 설치
- stale graph를 source에 맞춰 부분 patch하는 기능
- Git/IDE의 실시간 indexer 대체

## 작업 순서

1. persistence contract/store 테스트부터 작성
2. hydrate + explicit refresh semantics 구현
3. freshness manifest / stale status 추가
4. lifecycle/Web 표면 반영
5. targeted tests
6. full `npm run verify` + `git diff --check`
7. 실제 QuestBoard restart dogfood
8. 실제 ChatGPT2Codex fixture dogfood
9. 독립 리뷰
10. 사용자 승인 후 commit/push/Managed MCP update

## Guardrails

- 현재 `main`의 기존 변경을 reset/checkout/clean/revert하지 않는다.
- hydration 과정에서 project source를 쓰지 않는다.
- source changed는 절대 자동 indexing trigger가 아니다.
- explicit refresh의 의미를 cache load로 약화시키지 않는다.
- commit/push/deploy/Managed MCP update는 acceptance와 리뷰 전 수행하지 않는다.
