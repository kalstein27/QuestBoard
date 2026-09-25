# Code Map → Investigation Node 추출·연결 상세 구현 계획

상태: 구현 전 계획 확정

목표: 이미 검증된 Code Map 아키텍처 projection을 QuestBoard의 실제 Investigation Graph로 안전하게 추출하고, 이후 Code Map 재인덱싱 결과와 재동기화할 수 있게 한다. 이 기능은 Wiki보다 먼저 구현한다.

---

## 1. 현재 기준선

현재 Code Map은 provider-neutral `CodeArchitectureProjection`을 제공한다.

노드 종류:

- `http_api` → HTTP API
- `agent_mcp` → Agent / MCP
- `application_service` → Application Service
- `repository_contract` → Repository Contract
- `sqlite_repository` → SQLite Repository
- `sqlite` → SQLite

관계 종류:

- `invokes`
- `depends_on_contract`
- `implemented_by`
- `persists_to`

각 Code Map node는 안정적인 `code-map:node:*` ID와 `memberNodeIds`를 가지고, relation은 안정적인 `code-map:relation:*` ID와 `sourceRelationIds`를 가진다.

Investigation Graph는 이미 다음 구조를 제공한다.

```text
InvestigationNode
  0..N InvestigationItem
    0..N canonical Task overlay
    0..N InvestigationItem -> InvestigationNode flow link
```

따라서 새 기능은 새로운 그래프 시스템을 만드는 것이 아니라 **Code Map projection을 기존 Investigation Graph의 1급 데이터로 materialize/sync하는 bridge**다.

---

## 2. 핵심 제품 원칙

### 2.1 Code Map과 Investigation은 같은 데이터가 아니다

- Code Map은 소스코드에서 재생성 가능한 구조 projection이다.
- Investigation Graph는 사람이 편집하고 Task를 연결하는 실행 지도다.
- Code Map 재인덱싱이 Investigation Graph의 사용자 편집을 소유하거나 덮어쓰면 안 된다.

### 2.2 Node와 Task는 계속 분리한다

Code Map macro node는 Investigation Node로 변환한다. Task를 자동 생성하지 않는다.

Task overlay는 사용자가 기존 Investigation Item에 연결하거나 새 Task를 만들 때만 생긴다. Code Map sync는 기존 Task link를 삭제·재배치하지 않는다.

### 2.3 Relation의 출발점은 반드시 Item이다

Investigation Graph의 edge contract가 `Item -> Node`이므로 Code Map relation을 Node-to-Node edge로 우회 저장하지 않는다.

각 Code Map relation은 source Investigation Node 아래에 **sync-generated relation Item 1개**를 만들고, 그 Item에서 target Investigation Node로 flow link 1개를 만든다.

예:

```text
[HTTP API]
  item: invokes → Application Service
    └─ invokes ───────────────> [Application Service]

[Application Service]
  item: depends on → Repository Contract
    └─ depends_on_contract ───> [Repository Contract]
```

이 방식은 relation 하나와 Item/link 하나가 1:1 대응하므로 provenance, stale 판정, 재동기화가 단순해진다.

### 2.4 Provenance를 title/description에 숨기지 않는다

`code-map:node:*`, `code-map:relation:*`, source evidence를 Investigation Node description에 직렬화하지 않는다.

별도 binding/sync persistence를 둔다. 사용자는 Node/Item의 title/description을 자유롭게 수정할 수 있고 sync는 이를 metadata처럼 해석하지 않는다.

### 2.5 자동 삭제 금지

Code Map에서 node/relation이 사라져도 Investigation Node/Item/link를 자동 삭제하지 않는다.

대신 binding 상태를 `stale`로 변경하고 UI에서 표시한다. 제거는 별도의 명시적 사용자 작업으로 남긴다.

### 2.6 사용자 편집 덮어쓰기 금지

첫 materialize 시에만 기본 title/description/kind/position을 생성한다. 이후 sync는 기존 Investigation Node/Item의 사용자 필드를 자동 갱신하지 않는다.

Code Map 측 evidence나 member 집합이 바뀌면 binding의 fingerprint/evidence만 갱신한다.

### 2.7 Preview → Apply 2단계

동기화는 항상 먼저 preview를 계산한다.

preview 결과를 보고 사용자가 적용한 뒤에만 DB mutation이 일어난다.

---

## 3. Mapping 규칙

### 3.1 Code Map Node → Investigation Node

첫 추출 시:

- `title`: Code Map node title
- `description`: 짧은 생성 안내. 소스 identity/evidence 원문은 넣지 않는다.
- `kind`: `code-map/<architecture-kind>` 형태의 초기 힌트
- 위치: architecture 흐름 기준 deterministic 초기 layout
- 이후 사용자가 title/description/kind/position을 바꾸면 sync가 덮어쓰지 않는다.

초기 layout 제안:

```text
HTTP API --------┐
                 v
Agent / MCP -> Application Service -> Repository Contract -> SQLite Repository -> SQLite
```

HTTP API와 Agent/MCP는 첫 열의 상/하, 이후 계층은 오른쪽으로 흐르게 둔다. 기존 위치가 있으면 절대 재배치하지 않는다.

### 3.2 Code Map Relation → Investigation Item + Item Link

각 relation마다 source Node 아래 생성 Item 1개:

- title: `<relation label> → <target title>`
- description: `Generated from Code Map` 수준의 짧은 안내만 둔다.
- Item 자체의 source relation provenance는 binding table에 둔다.

그리고 Item에서 target Node로 `InvestigationItemLink`를 생성한다.

- `kind`: Code Map relation kind 그대로 (`invokes`, `depends_on_contract`, `implemented_by`, `persists_to`)
- `label`: 사람이 읽는 짧은 relation label

relation Item도 생성 이후 사용자가 편집한 title/description을 sync가 덮어쓰지 않는다.

### 3.3 Task overlay

Code Map sync는 `investigation_item_tasks`를 수정하지 않는다.

사용자가 generated relation Item 또는 일반 Item에 Task를 연결한 경우에도 재동기화 후 그대로 유지한다.

---

## 4. Persistence 설계

현재 Investigation domain에는 provenance metadata 필드가 없다. 기존 domain을 오염시키지 않기 위해 별도 binding table 두 개를 추가한다.

### 4.1 `code_map_investigation_node_bindings`

제안 컬럼:

```text
project_id                TEXT NOT NULL
code_node_id               TEXT NOT NULL
investigation_node_id      TEXT NULL
source_kind                TEXT NOT NULL
source_title               TEXT NOT NULL
source_fingerprint         TEXT NOT NULL
source_indexed_at          TEXT NOT NULL
sync_state                 TEXT NOT NULL  -- active | stale | detached
first_synced_at            TEXT NOT NULL
last_synced_at             TEXT NOT NULL
PRIMARY KEY(project_id, code_node_id)
UNIQUE(investigation_node_id)
```

`investigation_node_id`는 삭제 감지를 위해 nullable + `ON DELETE SET NULL` 성격으로 운용한다.

사용자가 generated Node를 삭제한 뒤 다음 sync가 무조건 다시 생성하면 사용자 의도를 침범한다. 따라서 binding은 남기고 `detached`로 보여준다. 재생성은 preview에서 명시적으로 선택한 경우만 허용한다.

### 4.2 `code_map_investigation_relation_bindings`

제안 컬럼:

```text
project_id                    TEXT NOT NULL
code_relation_id              TEXT NOT NULL
from_code_node_id             TEXT NOT NULL
to_code_node_id               TEXT NOT NULL
investigation_item_id         TEXT NULL
investigation_item_link_id    TEXT NULL
relation_kind                 TEXT NOT NULL
source_relation_ids_json      TEXT NOT NULL
source_fingerprint            TEXT NOT NULL
source_indexed_at             TEXT NOT NULL
sync_state                    TEXT NOT NULL  -- active | stale | detached
first_synced_at               TEXT NOT NULL
last_synced_at                TEXT NOT NULL
PRIMARY KEY(project_id, code_relation_id)
UNIQUE(investigation_item_id)
UNIQUE(investigation_item_link_id)
```

Item 또는 link를 사용자가 삭제한 경우 binding row는 보존하고 target ID를 nullable 상태로 유지하여 `detached`로 판정한다.

### 4.3 Fingerprint

Node fingerprint:

- source node ID
- kind
- title
- 정렬된 `memberNodeIds`
- 해당 node에 닿는 projection relation identity

Relation fingerprint:

- relation ID
- from/to
- kind
- 정렬된 `sourceRelationIds`

fingerprint는 preview에서 `evidence_changed` 판정에 사용한다.

---

## 5. Sync 상태 모델

preview에서는 mutation 대상과 상태를 분리해 보여준다.

### Node 상태

- `create`: binding 없음, 새 Investigation Node 필요
- `unchanged`: active binding + target 존재 + source fingerprint 동일
- `evidence_changed`: target은 유지, binding fingerprint/evidence만 갱신
- `stale`: 이전 binding source가 현재 projection에 없음. target 유지
- `detached`: binding은 있으나 Investigation Node가 사용자의 삭제 등으로 사라짐

### Relation 상태

- `create`: 새 relation Item + link 필요
- `unchanged`
- `evidence_changed`: Item/link 유지, provenance만 갱신
- `stale`: Code Map relation이 사라짐. Item/link 유지
- `detached`: generated Item 또는 link가 사라짐
- `blocked`: endpoint Node가 아직 추출되지 않았고 이번 apply에도 포함되지 않음

### 기본 apply 정책

- `create`: 생성
- `evidence_changed`: binding만 갱신
- `unchanged`: no-op
- `stale`: binding state만 stale로 변경
- `detached`: 기본 no-op. 사용자가 `recreateDetached`를 명시한 경우만 새 target 생성
- `blocked`: 적용 거부 또는 해당 relation만 skip하고 명확한 결과 반환

---

## 6. Application 구조

새 application module 제안:

```text
src/application/code-map-investigation-sync.ts
```

주요 타입:

```text
CodeMapInvestigationSyncPreview
CodeMapInvestigationNodePreviewEntry
CodeMapInvestigationRelationPreviewEntry
CodeMapInvestigationSyncSelection
CodeMapInvestigationSyncResult
CodeMapInvestigationNodeBinding
CodeMapInvestigationRelationBinding
```

서비스 역할:

```text
CodeMapInvestigationSyncService
  preview(projectId, selection)
  apply(projectId, selection, actor, requestId)
```

의존성:

- `CodeMapService`: 현재 cached projection 읽기
- `QuestBoardService` / repository boundary: Investigation graph 읽기 및 mutation
- binding repository: provenance/sync 상태 읽기/쓰기

### Apply transaction

여러 Node/Item/link/binding을 만드는 apply 중 절반만 반영되는 상태를 피한다.

최종 apply는 하나의 idempotent mutation/requestId 아래에서 transaction으로 처리한다.

필요하면 `QuestBoardService`에 internal application-level batch method를 추가하되, HTTP/Web/MCP가 SQLite를 직접 다루지 않는 기존 invariant는 유지한다.

---

## 7. Repository / SQLite 작업

필요 작업:

1. binding domain/application record type 추가
2. `QuestBoardRepository`에 node/relation binding read/write API 추가
3. SQLite 두 table + index 추가
4. `ON DELETE SET NULL` 또는 동등한 detached 보존 semantics 구현
5. project 삭제 시 binding cascade
6. sync apply transaction/idempotency receipt 연계
7. reload/restart 뒤 binding과 stale/detached 상태 복원 테스트

기존 `investigation_nodes`, `investigation_items`, `investigation_item_links`, `investigation_item_tasks`의 의미는 변경하지 않는다.

---

## 8. HTTP contract

제안 route:

### Preview

```text
POST /projects/:projectId/code-map/investigation-sync/preview
```

body 예:

```json
{
  "codeNodeIds": ["code-map:node:..."],
  "includeRelations": true,
  "recreateDetached": false
}
```

`codeNodeIds` 생략 시 전체 projection을 대상으로 한다.

응답에는 counts와 entry별 상태를 반환한다.

### Apply

```text
POST /projects/:projectId/code-map/investigation-sync/apply
```

body는 preview와 같은 selection + preview token/fingerprint 또는 projection `sourceIndexedAt`을 포함한다.

preview 후 Code Map이 재인덱싱되어 projection이 바뀐 경우 stale preview 적용을 거부한다.

### Error contract

- `409 code_map_not_indexed`
- `409 code_map_sync_preview_stale`
- `409 code_map_sync_detached_requires_confirmation`
- `400 code_map_sync_invalid_selection`

HTTP adapter는 application service만 호출하고 SQLite를 직접 참조하지 않는다.

---

## 9. Agent tool / MCP contract

Web 전용 기능으로 만들지 않는다.

shared neutral agent-tool에 다음 surface를 추가한다.

```text
questboard_preview_code_map_investigation_sync
questboard_apply_code_map_investigation_sync
```

MCP는 기존 daemon의 **같은 CodeMapService cache**를 사용해야 한다. 별도 MCP proxy process에서 별도 Code Map cache를 만들지 않는다.

현재 agent-tool executor가 `QuestBoardService`만 받는 구조라면 composition context를 확장해 optional `CodeMapInvestigationSyncService`를 주입한다. 기존 tool signatures와 기존 adapter caller는 호환 유지한다.

CLI 전용 human-friendly command는 1차 완료 기준에서 필수로 두지 않되 shared agent-tool로 호출 가능해야 한다.

---

## 10. Web UX

Code Map 화면에 다음 동선을 추가한다.

### 10.1 메인 action

`Extract / Sync to Investigation`

- Code Map이 index되지 않았으면 비활성
- 클릭 시 즉시 mutation하지 않고 preview를 연다.

### 10.2 Preview UI

최소 정보:

- 새 Node N
- 새 relation N
- evidence 변경 N
- stale N
- detached/conflict N
- 선택된 node/relation 목록

각 row는 상태 badge를 가진다.

첫 구현은 복잡한 graph diff 시각화보다 명확한 list preview를 우선한다.

### 10.3 Apply 완료

- 생성/갱신/유지/stale/detached counts 표시
- `Open Investigation` 버튼 제공
- Investigation view로 전환하고 새로 생성된 architecture Node 쪽으로 이동/강조

### 10.4 Investigation 표시

Code Map binding이 있는 Node/Item에는 가벼운 표시를 제공한다.

- `Code Map` badge
- stale이면 `Stale` badge
- detached는 preview에서만 보이고 존재하지 않는 target에는 렌더 badge가 없음

provenance raw ID 전체를 기본 UI에 상시 노출하지 않는다. 필요하면 detail/drill-down에서만 보여준다.

---

## 11. 사용자 편집 보호 규칙

반드시 테스트할 규칙:

1. 추출 후 Node title 수정 → sync해도 title 유지
2. Node description 수정 → 유지
3. Node drag로 위치 변경 → 유지
4. generated relation Item title/description 수정 → 유지
5. generated Item에 Task link 추가 → 유지
6. Node/Item/link 수동 삭제 → 자동 재생성하지 않고 detached
7. source node/relation 소멸 → 자동 삭제하지 않고 stale
8. stale source가 다시 등장하고 target이 남아 있으면 active로 복귀 가능
9. 기존 일반 Investigation Node/Item은 sync 대상이 아니며 절대 수정하지 않음

---

## 12. Idempotency / concurrency

### Idempotency

- stable Code Map IDs + binding PK로 중복 생성을 방지
- apply mutation은 `requestId` receipt를 사용
- 동일 request 재시도는 동일 결과 replay
- 다른 request로 같은 projection을 다시 sync해도 신규 Node/Item/link 0개

### Concurrency

preview와 apply 사이 projection version(`sourceIndexedAt` + projection fingerprint)을 확인한다.

Investigation target이 다른 actor에 의해 변경된 경우 user field를 덮어쓰지 않으므로 대부분 안전하다. target 삭제/구조 drift는 detached/conflict로 fail closed한다.

---

## 13. 테스트 계획

### Unit / application

- projection → preview 6 nodes / 5 relations
- 빈 binding → 전부 create
- second preview → unchanged
- changed member/evidence → evidence_changed
- disappeared source → stale
- deleted target → detached
- subset selection + endpoint dependency
- user-edited target fields preserved
- existing Task overlay preserved

### Repository

- binding CRUD
- unique/idempotency constraints
- `ON DELETE SET NULL` detached behavior
- restart persistence
- project cascade

### HTTP

- not indexed 409
- preview contract
- apply contract
- stale preview 409
- exact retry replay

### Agent/MCP

- tool schemas
- preview/apply through shared daemon boundary
- MCP and HTTP see the same resulting Investigation Graph

### Web

- Code Map action visible only when indexed
- preview counts/state render
- apply confirmation
- Open Investigation transition
- Code Map/Stale badges

### Actual SCIP E2E

격리 DB/port에서:

1. QuestBoard project 생성
2. 실제 SCIP index POST
3. Code Map projection `6 nodes / 5 relations` 확인
4. sync preview → `create nodes=6`, `create relations=5`
5. apply
6. Investigation Graph → architecture Node 6개 + generated relation Item 5개 + flow link 5개 확인
7. 동일 apply 재실행 → 신규 생성 0
8. 사용자 Node rename + drag + generated Item에 Task link 추가
9. sync 재실행 → rename/position/Task link 유지
10. browser에서 Code Map → sync → Investigation 이동까지 실제 렌더 검증
11. 전체 `npm verify` + race PASS

---

## 14. 구현 단계 / QuestBoard TODO 기준

### 1/7 Contract + binding data model

- [ ] mapping 규칙을 타입으로 확정
- [ ] preview/apply state enum과 result contract 확정
- [ ] node/relation binding 타입 확정
- [ ] projection version/fingerprint 규칙 테스트

완료 기준: application contract 테스트가 먼저 실패/통과 가능한 형태로 고정됨.

### 2/7 SQLite provenance / binding persistence

- [ ] node binding table
- [ ] relation binding table
- [ ] repository CRUD/list
- [ ] detached 보존
- [ ] restart persistence
- [ ] migration/regression test

완료 기준: Investigation domain 필드를 오염시키지 않고 provenance가 재시작 후 복원됨.

### 3/7 Preview + transactional apply sync engine

- [ ] preview diff 계산
- [ ] create/unchanged/evidence_changed/stale/detached 판정
- [ ] Node materialize
- [ ] relation Item + Item→Node link materialize
- [ ] one-request transaction/idempotency
- [ ] 사용자 편집/Task overlay 보존

완료 기준: application/service tests로 first sync와 second sync가 결정적으로 검증됨.

### 4/7 HTTP + neutral agent/MCP boundary

- [ ] preview HTTP
- [ ] apply HTTP
- [ ] stable error contract
- [ ] agent-tool schema/executor
- [ ] MCP daemon shared CodeMapService wiring
- [ ] HTTP/MCP consistency tests

완료 기준: Web과 MCP가 같은 canonical DB/Code Map cache를 통해 동일 결과를 봄.

### 5/7 Web Extract / Sync UX

- [ ] Code Map action
- [ ] preview list/counts/status
- [ ] detached/stale confirmation
- [ ] apply result
- [ ] Open Investigation navigation
- [ ] Code Map/Stale badge

완료 기준: 브라우저에서 index 후 preview/apply/navigation이 동작함.

### 6/7 Safety / resync / drift regression

- [ ] rerun no-duplicate
- [ ] Node rename/description/position 보존
- [ ] Item edit 보존
- [ ] Task overlay 보존
- [ ] stale no-delete
- [ ] detached no-auto-recreate
- [ ] stale→active 복귀

완료 기준: destructive overwrite/delete가 없음을 자동 테스트로 증명.

### 7/7 Actual SCIP E2E + final audit

- [ ] 실제 SCIP 6-node/5-relation projection에서 preview
- [ ] actual apply 후 Investigation 6 node / 5 item / 5 link
- [ ] browser UI E2E
- [ ] MCP/HTTP 결과 일치
- [ ] `npm verify` 100% PASS
- [ ] QuestBoard TODO/Claim 정리

완료 기준: 실제 source → SCIP → Code Map → Investigation Graph 전체 경로가 한 번에 증명됨.

---

## 15. 작업 중 금지 사항

- 기존 사용자가 만든 Investigation Node/Item 자동 삭제 금지
- stale source 자동 삭제 금지
- sync 때 기존 title/description/position 자동 덮어쓰기 금지
- Task 중복 생성 금지
- Code Map provenance를 description 문자열에 숨겨 저장 금지
- MCP에서 별도 SQLite/별도 Code Map cache 생성 금지
- unrelated dirty files reset/checkout/clean/revert/delete 금지
- 사용자 명시 없이 commit/push 금지

---

## 16. 최종 완료 정의

이 기능은 단순히 "Code Map 데이터를 복사했다"가 아니라 다음이 모두 만족될 때 완료다.

```text
실제 source code
  -> SCIP index
  -> Code Map projection
  -> sync preview
  -> explicit apply
  -> persistent Investigation Nodes
  -> relation Items
  -> Item-origin flow links
  -> canonical Task overlay 보존
  -> re-index / re-sync
  -> user edits 보존
  -> stale/detached fail-safe
  -> HTTP / MCP / Web 동일 결과
```

이 경로가 actual E2E와 전체 회귀 테스트로 증명된 뒤에 Wiki 구현으로 넘어간다.
