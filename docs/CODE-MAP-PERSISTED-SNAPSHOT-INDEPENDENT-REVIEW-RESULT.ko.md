# Code Map persisted snapshot hydration 독립 리뷰 결과

상태: **NEEDS REVISION**

리뷰 일시: 2026-09-30

## 1. 판정

**NEEDS REVISION**으로 판정한다.

핵심 persisted hydration 자체는 독립 재현에서 정상 동작했다. 별도 OS 프로세스 재생성 뒤 provider 실행 0회로 snapshot을 복원했고, source 변경 뒤 `persisted / stale / source_changed`를 유지하면서 bounded query가 동작했으며, 명시적 refresh에서만 provider가 실행되어 `fresh-index / current`로 교체되는 것을 확인했다.

그러나 아래 두 경계 결함이 acceptance를 만족하지 못한다.

1. `QUESTBOARD_CODE_MAP_STORAGE_ROOT`를 project checkout 내부로 지정할 수 있고 실제 snapshot/temp 상태가 checkout 내부에 생성된다. 이는 acceptance 12의 명시적 요구사항을 직접 위반한다.
2. 기본 QuestBoard runtime state인 `.questboard/questboard.sqlite`가 provider-neutral file inventory/source manifest에서 제외되지 않는다. 따라서 source가 바뀌지 않아도 Task/Activity/Claim 등 SQLite 변경만으로 `freshness=stale`, `staleReason=source_changed`가 될 수 있다. 실제 외부 fixture에서 재현했다.

구현 source는 수정하지 않았다. 이 결과 문서 외에는 파일을 변경하지 않았고, reset / checkout / clean / delete / revert / commit / push / Managed MCP update / deploy를 수행하지 않았다.

---

## 2. Fresh baseline

리뷰 시작 시 fresh bootstrap으로 다음을 직접 확인했다.

- projectId: `questboard`
- root: `<project-root>`
- branch: `main`
- HEAD: `853edc42b0f7e776539aa3f50b1e49aefa73a4c6`
- upstream: `origin/main`
- ahead / behind: `0 / 0`
- staged: `0`
- dirty: `13`

초기 dirty 13개는 review request에 기재된 구현 candidate 12개와 review request 문서 자체 1개로 정확히 일치했다. 리뷰 시작 시 unrelated working-tree 변경은 확인되지 않았다.

읽은 기준 문서:

- `AGENTS.md`
- `docs/QUESTBOARD-PROJECT-PLAN.ko.md`
- `docs/architecture/FOUNDATION.md`
- `docs/AGENT-ONBOARDING.md`
- `docs/CODE-MAP-PERSISTED-SNAPSHOT-HYDRATION-PLAN.ko.md`
- `docs/CODE-MAP-PERSISTED-SNAPSHOT-INDEPENDENT-REVIEW-REQUEST.ko.md`

---

## 3. Blocking finding A: checkout 내부 persistence root가 허용됨

### 위치

- `src/server/code-map-config.ts:254-260`
  - `QUESTBOARD_CODE_MAP_STORAGE_ROOT`를 단순 `resolve()`하여 받아들이며 project root와의 포함 관계를 검증하지 않는다.
- `src/adapters/code-intelligence/code-map-persistence.ts:31-73`
  - 전달된 storage root 아래에 `snapshots/<project-key>/snapshot.json` 및 temp 파일을 그대로 생성한다.
- `src/application/code-map-service.ts:356-382`
  - source manifest를 계산한 뒤 snapshot을 저장하므로 storage root가 checkout 내부이면 snapshot 쓰기 자체가 다음 freshness 검사에서 source 변화로 관찰될 수도 있다.

### 독립 재현

현재 checkout을 쓰지 않고 `/tmp` 아래 별도 fixture project를 만들고, 그 project root 내부의 `.code-map-storage`를 실제 filesystem snapshot store의 storage root로 지정했다.

결과:

```json
{"storageInsideCheckout":true,"manifestChangedBySnapshotWrite":true,"rootEntries":[".code-map-storage","src"]}
```

C2CT evidence: `out_mumxmgny_d6d4449f81169f91`

즉 현재 구현은 snapshot을 project checkout 내부에 실제 생성할 수 있으며, 그 snapshot 쓰기 자체가 source manifest를 바꾸는 self-invalidating 구성이 가능하다.

### 기대 동작

- persistence configuration 단계에서 storage root가 canonical project root 내부이거나 동일한 경우 fail-closed 해야 한다. 또는 항상 project root 밖의 canonical external storage로 강제해야 한다.
- snapshot/current/temp 상태는 어떤 지원되는 설정에서도 project checkout 안에 생성되지 않아야 한다.
- persistence write 자체가 source freshness를 바꾸어서는 안 된다.

### 판정 영향

**Acceptance 12 FAIL.**

---

## 4. Blocking finding B: `.questboard` runtime DB가 source change로 오인됨

### 위치

- `src/adapters/code-intelligence/file-inventory.ts:5-20`
  - shared ignored-directory set에 `.questboard`가 없다.
- `src/adapters/code-intelligence/code-map-persistence.ts:89-129`
  - source manifest가 같은 ignored-directory set을 재사용하고 나머지 regular file의 path / size / mtime을 fingerprint에 포함한다.
- `README.md:66-70`, `README.md:80`
  - QuestBoard 기본 DB는 checkout 상대경로 `.questboard/questboard.sqlite`다.
- `.gitignore:10-14`
  - `.questboard/`와 SQLite 상태는 repository source가 아니라 local generated/runtime state로 이미 취급된다.

### 독립 재현

`/tmp` 아래 fixture project에 source `src/main.ts`를 고정하고 `.questboard/questboard.sqlite`만 변경했다. 실제 compiled source-state provider로 변경 전/후 manifest를 계산했다.

결과:

```json
{"changed":true}
```

C2CT evidence: `out_mumxlo0s_b5e0d49576129b27`

source는 전혀 바뀌지 않았지만 QuestBoard DB 내용 변화만으로 source manifest fingerprint가 달라졌다.

### 영향

기본 local layout에서 Task/Activity/Claim/Investigation 등 정상 QuestBoard 사용으로 SQLite가 갱신되면, persisted Code Map은 실제 source 변화가 없어도 `freshness=stale`, `staleReason=source_changed`가 될 수 있다. 또한 provider-neutral inventory에도 `.questboard` 내부 runtime file이 code-file node 후보로 들어간다.

이는 stale 표시의 의미를 오염시키고, "source changed는 stale 신호일 뿐"이라는 설계에서 그 source-change 신호 자체를 신뢰하기 어렵게 만든다.

### 기대 동작

- `.questboard` 같은 QuestBoard 자체 runtime state directory는 provider-neutral source inventory와 source manifest 양쪽에서 제외되어야 한다.
- 가능하면 같은 exclusion policy를 한 곳에서 유지해 inventory와 manifest가 계속 동일한 source set을 보게 해야 한다.
- DB/Activity/Claim mutation만으로 Code Map freshness가 바뀌지 않아야 한다.

### 판정 영향

Source-manifest 경계조건을 만족하지 못한다. acceptance 4/6의 정상 source-change 동작 자체는 재현됐지만, 실제 source-change 판정에 false positive가 존재한다.

---

## 5. Restart / stale / explicit refresh 독립 dogfood

현재 dirty checkout의 compiled candidate를 사용하되 project source를 건드리지 않기 위해 `/tmp/questboard-persisted-review-20260930-0202` 아래 fixture project/storage를 사용했고, 각 단계는 **서로 다른 Node OS 프로세스**로 실행했다.

### Phase 1: fresh index + persist

결과:

```json
{"phase":1,"providerCalls":1,"state":{"snapshotSource":"fresh-index","freshness":"current"},"matches":1,"signature":"main(): 1"}
```

C2CT evidence: `out_mumxnao6_a3a87cb93b4b0247`

### Phase 2: source 변경 후 새 process hydrate

source를 `main(): 2`에 해당하도록 변경한 뒤 새 process를 만들고, provider는 호출되면 실패하도록 구성했다.

결과:

```json
{"phase":2,"hydrated":true,"providerCalls":0,"state":{"snapshotSource":"persisted","freshness":"stale","staleReason":"source_changed"},"matches":1,"signature":"main(): 1"}
```

C2CT evidence: `out_mumxqckj_3db07f25ea707cff`

확인 사항:

- 새 OS process에서 hydrate 성공
- provider 실행 0회
- stale persisted graph가 query 가능
- refresh 전에는 이전 persisted graph 결과가 유지됨

### Phase 3: 명시적 refresh

또 다른 새 process에서 먼저 persisted stale snapshot을 hydrate한 후 `refresh({ projectId, rootPath })`를 명시적으로 호출했다.

결과:

```json
{"phase":3,"before":{"snapshotSource":"persisted","freshness":"stale","staleReason":"source_changed"},"providerCalls":1,"refreshMode":"full","after":{"snapshotSource":"fresh-index","freshness":"current"},"signature":"main(): 2"}
```

C2CT evidence: `out_mumxqpdw_66aa8837a0c136da`

### Phase 4: 교체된 snapshot을 다시 새 process에서 hydrate

provider는 다시 호출되면 실패하도록 두었다.

결과:

```json
{"phase":4,"hydrated":true,"providerCalls":0,"state":{"snapshotSource":"persisted","freshness":"current"},"signature":"main(): 2"}
```

C2CT evidence: `out_mumxr6u8_0227e5258991041e`

따라서 persisted graph 교체도 실제 process recreation을 넘어 유지된다.

Managed MCP installed copy는 dirty candidate가 아니라 HEAD 설치본이므로, managed service 자체를 restart하면 이번 candidate가 아닌 pre-candidate artifact를 검증하게 된다. 또한 review guardrail상 update/deploy는 금지되어 있으므로 candidate 검증은 위와 같이 현재 checkout build를 별도 OS process로 재생성하여 수행했다.

---

## 6. Compatibility / graph validation 독립 확인

기존 worker test의 PASS 주장에 의존하지 않고 schema/project/graph-invalid case를 추가로 직접 실행했다. 각 case에서 provider는 호출되면 실패하도록 구성했다.

결과:

```json
{
  "schema":{"cached":false,"calls":0,"reason":"schema_changed"},
  "project":{"cached":false,"calls":0,"reason":"project_changed"},
  "invalid":{"cached":false,"calls":0,"reason":"graph_invalid"}
}
```

C2CT evidence: `out_mumxrmrz_1864ccfd26936c40`

format/provider/root/corrupt case는 current source와 fresh full regression에서도 각각 fail-closed가 확인됐다. hydration reject는 provider indexing으로 보상되지 않는다.

---

## 7. Acceptance별 판정

| # | Acceptance | 판정 | 독립 근거 |
|---|---|---|---|
| 1 | fresh index 후 final provider-neutral graph external persist | PASS | Phase 1 저장 후 Phase 2 별도 process가 실제 filesystem persisted graph를 복원. filesystem store source도 temp + rename으로 final graph envelope 저장. |
| 2 | 새 service/runtime에서 provider `indexProject()` 0회 hydrate | PASS | Phase 2, Phase 4 모두 providerCalls=0. |
| 3 | hydrate 직후 indexed/query 결과 유지 | PASS | Phase 2 hydrate=true, 기존 `main(): 1` query match 유지. |
| 4 | source 변경 후 provider 0, persisted/stale/source_changed | PASS | Phase 2에서 정확히 재현. 단, Finding B의 false-positive source-change 결함은 별도 blocker. |
| 5 | stale graph에서 bounded query + Investigation/Flow 소비 경로 | PASS | Phase 2 bounded query 성공. `CodeMapInvestigationSyncService.projection()`은 `CodeMapService.getCached()`의 hydrated projection을 사용하며 freshness에 의한 차단 경로가 없다. full regression의 실제 SCIP Investigation sync도 PASS. |
| 6 | source 변경 자체로 automatic SCIP refresh 없음 | PASS | Phase 2에서 source 변경 후 status/query/hydration 동안 providerCalls=0. watcher/background re-index trigger 없음. |
| 7 | public explicit Refresh/Re-index는 실제 provider indexing + snapshot 교체 | PASS | agent/HTTP public refresh는 `changes` 없이 `refresh({projectId, rootPath})`를 호출하므로 legacy `changes: []` cache-hit에 들어가지 않는다. Phase 3 providerCalls=1/full, Phase 4에서 새 graph가 persisted됨을 재확인. |
| 8 | explicit refresh 뒤 fresh-index/current | PASS | Phase 3에서 정확히 재현. |
| 9 | source manifest 실패 시 provider 보상 없음, graph 유지, unknown/source_check_failed | PASS | `CodeMapService.#refreshFreshness()`와 fresh regression `source check failure keeps persisted graph queryable with unknown freshness` 직접 확인. |
| 10 | corrupt snapshot이 daemon/service를 죽이지 않고 hydrate 거부 | PASS | `store.load()`/parse failure가 hydration diagnostic `corrupt`로 국소 처리되며 fresh regression PASS. lazy hydration이므로 daemon composition 자체도 강제 실패하지 않음. |
| 11 | format/schema/project/root/provider mismatch + graph validation fail-closed | PASS | source 검토 + 추가 독립 schema/project/graph-invalid 실행 + fresh regression의 format/provider/root/corrupt case. 모두 providerCalls=0. |
| 12 | snapshot/temp/manifest 상태는 checkout 안에 생성되지 않음 | **FAIL** | Finding A. 지원되는 `QUESTBOARD_CODE_MAP_STORAGE_ROOT` override를 checkout 내부로 지정하면 실제 snapshot/temp 경로가 checkout 내부에 생성됨. |
| 13 | bounded HTTP/MCP/agent status/query에서 absolute root/full manifest/full graph 비노출 | PASS | agent status는 rootPathConfigured/count/lifecycle만 반환하고 rootPath를 반환하지 않음. bounded query envelope은 project/index/provider/op/limit과 bounded node/relation만 반환. lifecycle regression에서 status rootPath 비노출 및 refresh graph 비노출 재검증. |
| 14 | `npm run verify` + race/regression PASS | PASS | 독립 fresh 실행 183/183 PASS, actual SCIP E2E PASS, race gate PASS. `git diff --check`도 PASS. |
| 15 | restart/update 성격 process recreation에서 provider 없이 hydration | PASS | Phase 1→2, Phase 3→4를 각각 별도 OS process로 수행하여 providerCalls=0 hydration 재현. |

Acceptance 12 하나만으로도 완료 기준상 PASS를 줄 수 없으며, Finding B도 수정이 필요하다.

---

## 8. Full regression evidence

독립 실행:

```text
npm run verify
```

결과:

- typecheck PASS
- Web syntax PASS
- node tests: **183 / 183 PASS**
- fail 0 / skipped 0
- actual SCIP E2E PASS
- race gate PASS

C2CT evidence: `out_mumxgpvi_b25fb719538b7dc2`

독립 실행:

```text
git diff --check
```

결과: PASS

C2CT operation: `bg_c65fd4b5-7a91-47f9-b84d-2058e16e9e91`

---

## 9. 나머지 경계조건 검토

### Explicit refresh vs `changes: []` cache-hit

`CodeMapService.refresh()`에는 `changes: []`일 때 cache-hit하는 기존 최적화가 남아 있으나, public agent/HTTP Refresh 경로는 `changes`를 전달하지 않는다. 따라서 public explicit refresh 의미는 현재 약화되지 않는다. Phase 3에서도 provider 1회 실행을 직접 확인했다.

### Atomic replace

filesystem store는 current path와 같은 directory에 고유 temp를 `wx`로 생성하고, write → file `fsync` → close → `rename` 순서로 교체하며 finally에서 temp를 제거한다. partial temp를 current snapshot으로 읽는 경로는 발견하지 못했다.

### Root/provider compatibility

root identity는 canonical `realpath`를 SHA-256으로 fingerprint하고 project/root/provider/schema를 graph validation 전에 비교한다. provider fingerprint는 configured provider order + id/languages/fidelity/version을 안정적으로 직렬화하여 SHA-256한다. 현재 acceptance를 깨는 instability는 재현하지 못했다.

### Persistence failure isolation

load/parse/root-check/graph validation 실패는 hydrate reject diagnostic으로 국소화된다. fresh index 뒤 persistence save 실패도 in-memory fresh graph를 무효화하지 않는다.

### Status read side effect

`getCached()`의 lazy hydration과 `snapshotLifecycleState()`의 manifest check는 provider를 실행하지 않는다. Phase 2/4의 throwing provider로 providerCalls=0을 확인했다.

### Web stale 의미

`web/app.js`는 provider indexing failure(`state.codeMapIndexError`)와 source freshness stale(`map.freshness === "stale"`)를 별도 banner/status로 처리하며 manual relation panel도 별도 렌더링한다. provider-derived stale snapshot과 manual relation stale 의미를 한 상태로 합치는 경로는 발견하지 못했다.

### Sensitive bounded surface

persisted graph 내부의 absolute `rootPath`는 hydration compatibility 검사용으로만 사용되며 bounded agent/MCP/HTTP status와 bounded query envelope에는 직접 포함되지 않는다. full graph를 사용하는 기존 Web `/code-map` surface는 기존 별도 UI 계약이고, 이번 acceptance의 bounded status/query surface와 구분된다.

---

## 10. Revision 요청

PASS 재리뷰를 위해 최소한 다음이 필요하다.

1. **External storage invariant 강제**
   - canonical project root와 storage root의 동일/하위 경로를 거부하거나 안전한 external root로 강제한다.
   - temp/current snapshot 모두 checkout 밖이라는 regression을 추가한다.
   - in-checkout override가 fail-closed하는 테스트를 추가한다.

2. **QuestBoard runtime state를 source set에서 제외**
   - `.questboard`를 shared provider-neutral inventory/source-manifest exclusion에 추가한다.
   - `.questboard/questboard.sqlite`만 변경했을 때 manifest fingerprint와 freshness가 그대로 유지되는 regression을 추가한다.
   - runtime DB가 Code Map file node로 나타나지 않는 것도 함께 확인한다.

3. 수정 후 아래를 다시 독립 검증한다.
   - `npm run verify`
   - `git diff --check`
   - fresh persist → new process hydrate(provider 0)
   - source change → stale(provider 0)
   - explicit refresh → provider 1 + fresh/current
   - DB-only mutation → current 유지
   - in-checkout storage override → fail-closed

현재 상태에서는 위 두 결함 때문에 **NEEDS REVISION**이다.
