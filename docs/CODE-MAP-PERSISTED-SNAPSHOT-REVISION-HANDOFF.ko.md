# Code Map persisted snapshot hydration revision handoff

상태: independent review `NEEDS REVISION` blocker 수정 완료 / 독립 재리뷰 대기

기준 리뷰 결과:
- `docs/CODE-MAP-PERSISTED-SNAPSHOT-INDEPENDENT-REVIEW-RESULT.ko.md`
- 원 판정은 역사 기록으로 유지하며 덮어쓰지 않는다.

## 수정한 blocker

### A. checkout 내부 Code Map storage 금지

독립 리뷰에서 `QUESTBOARD_CODE_MAP_STORAGE_ROOT=<project>/.code-map-storage`가 허용되어 snapshot/temp가 checkout 안에 생성되고, 그 저장 자체가 source manifest를 바꾸는 self-invalidating 구성이 재현됐다.

수정:
- `src/adapters/code-intelligence/code-map-persistence.ts`
  - canonical project root와 storage root를 비교하는 `assertCodeMapStorageRootOutsideProject()` 추가.
  - 아직 존재하지 않는 storage leaf도 가장 가까운 existing ancestor를 `realpath`한 뒤 suffix를 재결합하여 symlink/relative alias를 포함한 containment를 판단한다.
  - storage root가 project root와 동일하거나 descendant이면 bounded error로 fail-closed한다.
- `src/server/code-map-config.ts`
  - service 구성 시 `mkdirSync(storageRoot)` eager creation 제거.
  - configured persistence에 storage-root validator 주입.
  - SCIP/GitNexus provider direct indexing 경로에도 같은 guard를 적용해 persistence가 없는 direct service에서도 provider artifact가 checkout 내부에 생성되지 않게 한다.
- `src/application/code-map-service.ts`
  - explicit refresh가 cache hydration/provider execution보다 먼저 storage boundary를 검증한다.
  - lazy hydration도 store read 전에 검증하며 거부 시 `hydrationRejectReason=storage_inside_project`를 bounded하게 기록한다.
- `src/application/code-map-persistence.ts`
  - `validateStorageRootForProject` hook과 `storage_inside_project` hydration diagnostic 추가.

회귀:
- `configured runtime rejects Code Map storage inside the project checkout before writing state`
  - runtime/service 생성 직후 내부 storage directory가 존재하지 않음.
  - explicit refresh가 provider/file indexing 전에 거부됨.
  - 거부 후에도 내부 storage directory가 생성되지 않음.
  - lazy hydration도 `storage_inside_project`로 거부됨.

### B. `.questboard` runtime state를 source에서 제외

독립 리뷰에서 source는 그대로인데 `.questboard/questboard.sqlite`만 변경해도 source manifest fingerprint가 바뀌는 false-positive가 재현됐다.

수정:
- `src/adapters/code-intelligence/file-inventory.ts`
  - shared `DEFAULT_CODE_MAP_IGNORED_DIRECTORIES`에 `.questboard` 추가.
  - provider-neutral file inventory와 source manifest가 이미 공유하던 exclusion contract를 그대로 재사용하므로 두 경로가 같은 source set을 본다.

회귀:
- `filesystem inventory is provider-neutral and skips generated/dependency/runtime directories`
  - `.questboard/questboard.sqlite`가 file inventory에서 제외됨.
- `filesystem snapshot and source manifest stay outside project checkout`
  - `.questboard/questboard.sqlite` 내용/크기 변경만으로 manifest fingerprint가 변하지 않음.
  - 실제 `src/main.ts` 변경에서는 fingerprint가 정상적으로 변함.

## 검증 결과

### Targeted

실행:
`npm run build && node --test dist/tests/code-map-persistence.test.js dist/tests/code-map-hierarchy.test.js dist/tests/code-map-config.test.js`

결과:
- 18 / 18 PASS
- evidence: `out_mumydxnn_b85908a8eaebb79e`

### Full gate

실행:
`npm run verify && git diff --check`

결과:
- typecheck PASS
- Web syntax PASS
- node tests 184 / 184 PASS
- actual SCIP E2E PASS
- race gate PASS
- `git diff --check` PASS
- evidence: `out_mumyfb62_e907875d0d24dbc1`

### Canonical alias probe

별도 `/tmp` fixture에서 project root를 가리키는 symlink alias 아래의 non-existing storage leaf를 검사했다.
- 결과: `{ "symlinkAliasRejected": true }`
- `git diff --check`도 같은 실행에서 PASS.
- evidence: `out_mumyig00_80ef539077c19311`

## 독립 재리뷰에서 반드시 다시 확인할 것

구현 worker의 PASS를 신뢰하지 말고 fresh bootstrap/source/diff와 별도 fixture에서 직접 검증한다.

1. checkout 내부 storage root 직접 경로
   - service/runtime 구성만으로 directory가 생기지 않는지.
   - refresh 시 snapshot/temp/index.scip 등 어떤 Code Map state도 project 내부에 생성되지 않는지.
2. 가능하면 symlink/alias를 통해 checkout 내부를 가리키는 storage root도 canonical containment로 거부되는지.
3. `.questboard/questboard.sqlite`만 변경했을 때 source manifest fingerprint가 불변인지.
4. 같은 fixture에서 실제 source file을 변경하면 fingerprint가 달라지고 hydrated snapshot이 `stale/source_changed`가 되는지.
5. persisted hydration 핵심 semantics가 유지되는지.
   - fresh index -> 새 OS process -> provider calls 0 -> persisted/current.
   - source 변경 -> 새 process -> provider calls 0 -> persisted/stale/source_changed.
   - explicit refresh에서만 provider 실행 -> fresh-index/current.
6. corrupt/format/schema/project/root/provider/graph-invalid fail-closed가 유지되는지.
7. `npm run verify`와 `git diff --check`를 독립 실행할 것.

## Guardrails

- source 수정 금지.
- reset / checkout / clean / delete / revert 금지.
- commit / push / Managed MCP update / deploy 금지.
- 구현자의 기존 evidence는 참고만 하고 reviewer가 직접 재현할 것.
- 결함 발견 시 고치지 말고 위치/재현/기대 동작을 기록할 것.

재리뷰 결과는 새 파일로 남긴다:
`docs/CODE-MAP-PERSISTED-SNAPSHOT-INDEPENDENT-REREVIEW-RESULT.ko.md`
