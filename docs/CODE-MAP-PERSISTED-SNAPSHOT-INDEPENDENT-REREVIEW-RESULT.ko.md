# Code Map persisted snapshot hydration 독립 재리뷰 결과

상태: **PASS**

리뷰 일시: 2026-09-30

## 1. 최종 판정

**PASS**로 판정한다.

이전 독립 리뷰에서 `NEEDS REVISION`을 만든 두 blocker를 현재 checkout에서 구현자의 기존 PASS 주장과 evidence에 의존하지 않고 다시 확인했다.

1. checkout 내부 또는 symlink/alias를 통해 checkout 내부를 가리키는 `QUESTBOARD_CODE_MAP_STORAGE_ROOT`는 runtime/service 구성 단계에서 state를 만들지 않으며, hydration/explicit Refresh 모두 canonical containment 검사로 fail-closed 한다.
2. `.questboard/questboard.sqlite`는 provider-neutral file inventory/source manifest에서 제외되어 DB-only 변경으로 source manifest fingerprint가 변하지 않는다. 실제 source 파일 변경에서는 fingerprint가 정상적으로 변한다.

persisted hydration의 핵심 semantics도 별도 OS process 재생성으로 다시 검증했다. provider 호출 없이 persisted/current hydrate가 되고, source 변경 뒤에는 provider 호출 없이 persisted/stale/source_changed가 되며, 명시적 Refresh에서만 provider가 실행되어 fresh-index/current로 교체된다. 교체된 snapshot은 다시 새 OS process에서 provider 호출 0회로 hydrate된다.

corrupt / format / schema / project / root / provider / graph-invalid hydration reject 역시 모두 provider 보상 실행 없이 fail-closed를 유지했다. fresh `npm run verify`와 `git diff --check`도 통과했다.

구현 source는 수정하지 않았다. 이 재리뷰 결과 문서 외에는 파일을 변경하지 않았고, reset / checkout / clean / delete / revert / commit / push / Managed MCP update / deploy를 수행하지 않았다.

---

## 2. Fresh baseline

리뷰 시작 시 fresh C2CT bootstrap과 repository status를 직접 확인했다.

- projectId: `questboard`
- root: `<project-root>`
- branch: `main`
- HEAD: `853edc42b0f7e776539aa3f50b1e49aefa73a4c6`
- upstream: `origin/main`
- ahead / behind: `0 / 0`
- staged: `0`
- dirty: `16`

리뷰 시작과 결과 문서 작성 직전의 dirty file 목록은 동일한 16개였고, reviewer 검증 과정에서 project source/working tree에 새 변경을 만들지 않았다.

직접 읽은 기준 문서:

- `AGENTS.md`
- `docs/QUESTBOARD-PROJECT-PLAN.ko.md`
- `docs/architecture/FOUNDATION.md`
- `docs/CODE-MAP-PERSISTED-SNAPSHOT-INDEPENDENT-REVIEW-RESULT.ko.md`
- `docs/CODE-MAP-PERSISTED-SNAPSHOT-REVISION-HANDOFF.ko.md`

현재 source와 관련 diff도 독립 확인했다.

주요 수정 경계:

- `src/adapters/code-intelligence/code-map-persistence.ts:35-55`
  - non-existing storage leaf의 가장 가까운 existing ancestor를 canonical realpath로 해석한 뒤 suffix를 재결합한다.
  - canonical project root와 storage root가 동일하거나 descendant이면 거부한다.
- `src/application/code-map-service.ts:268-270`
  - explicit Refresh가 hydrate/cache/provider 실행보다 먼저 storage boundary를 검증한다.
- `src/application/code-map-service.ts:433-445`
  - lazy hydration도 store read 전에 storage boundary를 검증하고 `storage_inside_project`로 fail-closed 한다.
- `src/server/code-map-config.ts:202-217`
  - configured persistence에 동일 validator를 주입한다.
- `src/server/code-map-config.ts:300-323`
  - SCIP/GitNexus direct provider indexing 경로에도 같은 storage guard가 적용된다.
- `src/adapters/code-intelligence/file-inventory.ts:5-21`
  - shared ignored-directory set에 `.questboard`가 포함되어 file inventory와 source manifest가 같은 exclusion contract를 사용한다.

Diff inspection evidence: `out_mun9q7be_adfe63008256b771`

---

## 3. Blocker A 재검증: checkout 내부 Code Map state 생성 차단

별도 `/tmp` fixture를 만들고 현재 checkout의 fresh build를 사용했다.

### 3.1 direct 내부 storage root

fixture project 내부에 다음과 같은 storage root를 지정했다.

```text
<fixture-project>/.code-map-review
```

semantic provider 경로도 살아 있는 상태를 만들기 위해 executable에는 실제 `process.execPath`를 지정했다.

독립 확인:

- `createConfiguredCodeMapRuntime()` 직후 내부 storage directory가 존재하지 않음.
- explicit `refresh()`는 provider/indexing보다 먼저 `storage root must be outside the project checkout`으로 거부됨.
- 거부 뒤에도 내부 storage directory가 존재하지 않음.
- lazy hydration은 cached graph 없이 종료하며 `hydrationRejectReason=storage_inside_project`를 기록.
- hydration 뒤에도 내부 storage directory가 존재하지 않음.

결과 요약:

```json
{
  "direct": {
    "runtimeCreatedState": false,
    "hydrationRejectReason": "storage_inside_project"
  }
}
```

따라서 snapshot/temp/index.scip 등 Code Map state를 만들 수 있는 provider/store 코드가 실행되기 전에 boundary가 차단된다.

### 3.2 symlink/alias + non-existing leaf

fixture project root를 가리키는 symlink alias를 만들고, 아직 존재하지 않는 descendant를 storage root로 지정했다.

```text
<alias-to-project>/nested/code-map-state
```

독립 확인:

- runtime 구성만으로 actual project 내부의 `nested` directory가 생기지 않음.
- explicit Refresh가 canonical containment 검사로 거부됨.
- 거부 뒤에도 actual project 내부에 `nested` directory가 생기지 않음.
- lazy hydration diagnostic은 `storage_inside_project`.

결과 요약:

```json
{
  "alias": {
    "createdInsideProject": false,
    "hydrationRejectReason": "storage_inside_project"
  }
}
```

이는 existing symlink ancestor를 `realpath`하고 non-existing suffix를 재결합하는 현재 구현이 실제 alias 우회도 차단함을 독립 확인한 것이다.

Boundary/alias evidence: `out_mun9rd14_77e182de19fbbeca`

**이전 Blocker A: RESOLVED.**

---

## 4. Blocker B 재검증: `.questboard` DB-only 변경은 source change가 아님

같은 fixture에 `src/main.ts`와 `.questboard/questboard.sqlite`를 두고 현재 production source-state provider로 manifest를 직접 계산했다.

순서:

1. 최초 source manifest fingerprint 계산.
2. source는 그대로 두고 `.questboard/questboard.sqlite` 내용과 크기만 변경.
3. manifest 재계산.
4. 실제 `src/main.ts` 내용을 변경.
5. manifest 재계산.

결과:

```json
{
  "manifest": {
    "dbOnlyUnchanged": true,
    "sourceChanged": true
  }
}
```

즉 QuestBoard runtime DB mutation은 source freshness를 오염시키지 않으며, 실제 source 변경은 정상적으로 관찰된다.

같은 shared ignored-directory contract가 `FileSystemCodeFileInventory`와 source manifest provider 양쪽에 사용되는 것도 source에서 확인했다.

Evidence: `out_mun9rd14_77e182de19fbbeca`

**이전 Blocker B: RESOLVED.**

---

## 5. 새 OS process persisted hydration / stale / explicit Refresh 독립 재현

고정된 별도 fixture/storage를 사용하고 각 phase를 서로 다른 Node OS process로 실행했다. production filesystem snapshot store와 production source-state provider를 사용했다.

### Phase 1: fresh index + persist

```json
{
  "phase": 1,
  "providerCalls": 1,
  "state": {
    "snapshotSource": "fresh-index",
    "freshness": "current"
  },
  "signature": "main(): 1"
}
```

Evidence: `out_mun9rshm_27386eb70dfa072c`

### Phase 2: source unchanged, 새 OS process hydrate

provider는 호출되면 실패하도록 구성했다.

```json
{
  "phase": 2,
  "providerCalls": 0,
  "state": {
    "snapshotSource": "persisted",
    "freshness": "current"
  },
  "signature": "main(): 1",
  "matches": 1
}
```

확인:

- 새 process에서 persisted snapshot hydrate 성공.
- provider 호출 0회.
- bounded query가 hydrated graph를 정상 사용.

Evidence: `out_mun9rzqj_b56de8f17ff43cd9`

### Phase 3: 실제 source 변경 후 새 OS process hydrate + explicit Refresh

`src/main.ts`를 실제 변경한 뒤 새 process에서 먼저 hydrate만 수행했다.

Refresh 전:

```json
{
  "snapshotSource": "persisted",
  "freshness": "stale",
  "staleReason": "source_changed"
}
```

이때 provider 호출은 0회였고 query는 이전 persisted graph의 `main(): 1`을 그대로 반환했다.

그 다음 같은 process에서 명시적 `refresh()`를 호출했다.

```json
{
  "providerCallsAfterHydrate": 0,
  "providerCallsAfterRefresh": 1,
  "refreshMode": "full",
  "after": {
    "snapshotSource": "fresh-index",
    "freshness": "current"
  },
  "freshSignature": "main(): 222222"
}
```

즉 source change 자체는 provider 실행을 유발하지 않고, 명시적 Refresh에서만 provider가 실행된다.

Evidence: `out_mun9s8r0_4858c5f2c8946e50`

### Phase 4: 교체된 snapshot을 다시 새 OS process에서 hydrate

provider는 다시 호출되면 실패하도록 구성했다.

```json
{
  "phase": 4,
  "providerCalls": 0,
  "state": {
    "snapshotSource": "persisted",
    "freshness": "current"
  },
  "signature": "main(): 222222"
}
```

Evidence: `out_mun9shaj_0b04f86e0dbf672f`

따라서 persisted graph 교체와 restart hydration semantics는 revision 뒤에도 유지된다.

---

## 6. Hydration compatibility / graph validation fail-closed 독립 matrix

구현 테스트의 PASS 결과를 재사용하지 않고 별도 fixture service를 만들어 다음 7개 reject case를 직접 주입했다. 각 case의 provider는 호출되면 실패하도록 구성했다.

결과:

```json
{
  "corrupt": { "reason": "corrupt", "providerCalls": 0 },
  "format": { "reason": "format_changed", "providerCalls": 0 },
  "schema": { "reason": "schema_changed", "providerCalls": 0 },
  "project": { "reason": "project_changed", "providerCalls": 0 },
  "root": { "reason": "root_changed", "providerCalls": 0 },
  "provider": { "reason": "provider_changed", "providerCalls": 0 },
  "graph-invalid": { "reason": "graph_invalid", "providerCalls": 0 }
}
```

모든 incompatibility/invalid snapshot은 cached graph로 채택되지 않았고, provider indexing으로 자동 보상되지 않았다.

Evidence: `out_mun9tiqr_3c1bba54719406d6`

---

## 7. 요청된 재검증 항목별 판정

| # | 독립 재검증 항목 | 판정 | 근거 |
|---|---|---|---|
| 1 | checkout 내부 storage 지정 시 runtime/service 생성 및 Refresh가 project 내부에 snapshot/temp/index state를 만들지 않음 | **PASS** | runtime 생성 직후 state 없음, Refresh가 provider 전에 거부, hydration도 `storage_inside_project`, 내부 storage 미생성. |
| 2 | symlink/alias로 checkout 내부를 가리키는 storage도 canonical containment로 차단 | **PASS** | project symlink alias + non-existing descendant를 실제로 구성해 거부 및 미생성 확인. |
| 3 | source 고정 + `.questboard/questboard.sqlite`만 변경 시 manifest fingerprint 불변 | **PASS** | `dbOnlyUnchanged=true`. |
| 4 | 실제 source 변경 시 persisted/stale/source_changed | **PASS** | Phase 3 새 process에서 provider 0회로 `persisted/stale/source_changed`. |
| 5 | 새 OS process hydration에서 provider 호출 0회 | **PASS** | Phase 2와 Phase 4 모두 `providerCalls=0`. |
| 6 | 명시적 Refresh에서만 provider 실행, fresh-index/current 복귀 | **PASS** | Phase 3 hydrate 전 provider 0, explicit Refresh 뒤 1회/full, `fresh-index/current`. |
| 7 | corrupt/format/schema/project/root/provider/graph-invalid fail-closed 유지 | **PASS** | 7-case 독립 matrix 전부 expected reject reason + provider 0회. |
| 8 | fresh `npm run verify`와 `git diff --check` | **PASS** | verify 184/184 PASS, actual SCIP E2E PASS, race gate PASS, diff check exit 0. |

---

## 8. Fresh full regression

독립 실행:

```text
npm run verify
```

결과:

- typecheck PASS
- Web syntax PASS
- node tests: **184 / 184 PASS**
- fail 0 / skipped 0
- actual SCIP E2E PASS
- race gate PASS

Evidence: `out_mun9ui8h_9873f5d258caa623`

독립 실행:

```text
git diff --check
```

결과:

- exit code 0
- whitespace error 없음

Evidence: `out_mun9uug4_764d09d8e7f8c3ea`

---

## 9. 결론

이전 독립 리뷰의 두 blocker는 현재 revision에서 독립 재현 기준으로 모두 해결되었다.

- checkout 내부 persistence/state contamination: 재발 없음.
- symlink/alias containment 우회: 재발 없음.
- `.questboard` runtime DB source-manifest false positive: 재발 없음.
- persisted hydration / source stale detection / explicit Refresh semantics: 유지.
- fail-closed compatibility/graph validation: 유지.
- full regression / diff hygiene: PASS.

따라서 **Code Map persisted snapshot hydration revision의 독립 재리뷰 최종 판정은 PASS**다.
