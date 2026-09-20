# Investigation Graph 내부 TODO

상태: 1차 Graph 구현 완료 / P1·P2 확장 TODO 추적 중

이 문서는 QuestBoard Investigation 화면을 단순 Task/Artifact 관계도에서 **프로젝트 동작 구조와 그 구조에 걸린 실제 할 일을 동시에 읽을 수 있는 시각적 실행 지도**로 확장하기 위한 내부 TODO를 정리한다.

핵심 문장:

> Investigation은 할 일 그래프가 아니라, 프로젝트 동작 구조 위에 할 일을 겹쳐 보는 실행 지도다.

기존 Quest Board의 Task/Claim/Activity 흐름은 유지한다. Investigation은 Task를 대체하지 않고, 프로젝트의 기능·흐름·시스템 구조를 설명하는 별도 그래프 위에 기존 Task를 연결해 보여준다.

---

## 1. 사용자 목표

Investigation 화면에서 다음을 직관적으로 파악할 수 있어야 한다.

- 프로젝트가 어떤 기능/단계/컴포넌트로 구성되는가
- 어떤 단계가 다음 어떤 단계로 이어지는가
- 각 단계 내부에 어떤 세부 항목이 있는가
- 각 세부 항목이 다른 어떤 Node로 연결되는가
- 각 세부 항목에 현재 어떤 할 일이 남아 있는가
- 할 일이 진행 중인지, 막혔는지, 완료됐는지
- 아직 흐름에 연결하지 않은 아이디어/TODO/후보 Node가 무엇인가

대표 사용 예:

```text
[로그인 흐름]
  설명: 클라이언트 인증부터 게임 진입 전까지의 흐름

  ├─ 토큰 검증
  │   설명: JWT / 만료 / 재발급 검증
  │   Tasks: [토큰 캐시 추가] [만료 처리 수정]
  │   └──> [세션 생성]
  │
  ├─ 계정 상태 확인
  │   설명: 정지 / 탈퇴 / 점검 상태 확인
  │   Tasks: [정지 메시지 분리]
  │   └──> [캐릭터 선택]
  │
  └─ 실패 로깅
      설명: 인증 실패 사유 기록
      Tasks: 없음
```

멀리 축소하면 `로그인 → 세션 → 캐릭터 선택 → 월드 입장`의 전체 흐름을 읽고, 가까이 확대하면 각 Node 내부 Item의 설명과 실제 Task를 확인하는 형태가 목표다.

---

## 2. 핵심 개념

### 2.1 InvestigationNode

프로젝트 구조를 표현하는 독립적인 그래프 카드.

Node는 Task가 아니다. 기능, 처리 단계, 시스템, 서브시스템, 주제, 설계 묶음, 임시 TODO 묶음 등 무엇이든 표현할 수 있다.

초기 필드 후보:

```text
id
projectId
title
description
kind optional
createdAt
updatedAt
revision
```

`kind`는 초기에 강한 domain enum으로 묶지 않아도 된다. 필요하다면 UI 분류용으로 아래 정도를 optional하게 검토한다.

```text
flow
component
system
topic
todo
note
other
```

중요 원칙:

- Node는 다른 Node와 연결되어 있지 않아도 생성 가능하다.
- Item이 하나도 없는 빈 Node도 허용한다.
- Task가 하나도 연결되지 않은 Node도 허용한다.
- Artifact가 없어도 Node는 독립적으로 존재할 수 있다.
- Node 자체에 설명을 작성/수정할 수 있어야 한다.

즉, 보드 한쪽에 "나중에 연결할 TODO", "검토 필요", "새 기능 후보" 같은 독립 Node를 던져둘 수 있어야 한다.

### 2.2 InvestigationItem

Node 안에 들어가는 세부 항목.

한 Node는 0..N개의 Item을 가진다.

초기 필드 후보:

```text
id
nodeId
title
description
sortOrder
createdAt
updatedAt
revision
```

Item도 자체 설명을 가진다.

예:

```text
Node: 로그인 흐름
  Item: 토큰 검증
  Item: 계정 상태 확인
  Item: 실패 로깅
```

Item은 단순 텍스트 bullet이 아니라, 다른 Node 및 실제 Task와 연결되는 그래프의 **세부 포트/앵커** 역할을 한다.

### 2.3 InvestigationItem → Node 연결

연결선의 출발점을 Node 전체가 아니라 Item으로 세분화한다.

```text
InvestigationItem  --link-->  InvestigationNode
```

예:

```text
[로그인 흐름]
  토큰 검증 --------> [세션 생성]
  계정 상태 확인 ----> [캐릭터 선택]
```

초기에는 Item 하나가 0..N개의 Node로 연결될 수 있게 설계한다. 하나만 허용하면 나중에 분기 흐름을 표현하기 어렵다.

연결 필드 후보:

```text
id
projectId
fromItemId
toNodeId
label optional
kind optional
createdAt
```

향후 필요하면 조건/분기 표현을 위해 `label`을 사용할 수 있다.

예:

```text
성공 -> 세션 생성
실패 -> 로그인 실패 처리
점검중 -> 점검 안내
```

### 2.4 InvestigationItem → Task 연결

Item 하나는 0..N개의 기존 QuestBoard Task를 가질 수 있다.

```text
InvestigationItem  <-->  Task
```

별도 "Investigation 전용 TODO"를 복제해서 만들지 않는다. 실행 가능한 실제 할 일은 기존 Task를 canonical source of truth로 유지한다.

따라서 Task의 아래 정보는 기존 Quest Board와 완전히 공유한다.

- status
- priority
- Claim
- actor attribution
- Activity
- description
- tags
- revision

Item에 Task를 붙였다고 해서 Task 데이터가 복사되면 안 된다.

초기 연결 테이블 후보:

```text
investigation_item_tasks
  itemId
  taskId
  sortOrder optional
  createdAt
```

동일 Task를 여러 Item에 연결하는 것은 허용하는 방향을 기본안으로 둔다. 크로스커팅 작업을 표현할 수 있기 때문이다. 단, UI에서 같은 Task가 여러 위치에 연결되어 있다는 사실은 명확히 표시한다.

---

## 3. 기존 개념과의 관계

### Task

- Quest Board에서 실행/진행 상태의 canonical work item
- Investigation Item에 연결되어 "이 구조의 이 부분에서 해야 할 일"로 나타남
- Investigation 그래프 때문에 Task 상태 모델을 새로 만들지 않는다

### Artifact

- 파일, URL, 커밋, 스크린샷, 로그 등 증거/참고자료 역할 유지
- 장기적으로 Node 또는 Item에 Artifact를 붙일 수 있도록 확장 검토
- 초기 Investigation Graph 1차 구현에서는 Task link보다 우선순위를 낮춰도 됨

### Relation

현재 Task/Artifact endpoint 기반 Relation은 기존 Evidence layer의 관계로 유지한다.

새 Investigation 구조 연결은 의미가 다르므로 기존 Relation에 억지로 합치지 않는 방향을 우선 검토한다.

구분:

```text
기존 Relation
  Task/Artifact 사이의 증거/관련성 edge

Investigation Item Link
  프로젝트 구조상 한 Item이 다음 어떤 Node로 이어지는지 표현하는 flow edge
```

장기적으로 일반화할지는 실제 사용 후 판단한다.

### board_positions

현재 Investigation 위치 저장 구조는 재사용 가능하다.

새 InvestigationNode의 위치를 저장할 수 있도록 entity type 확장을 검토한다.

```text
entityType = investigation_node
entityId   = nodeId
```

기존 Task/Artifact 위치 데이터는 migration/호환성을 위해 유지한다.

---

## 4. 목표 UX

### 4.1 Node 카드

기본 카드 구조:

```text
┌──────────────────────────────┐
│ 로그인 흐름             ⋯    │
│ 클라이언트 인증부터 ...      │
├──────────────────────────────┤
│ 토큰 검증                 ○──┼──>
│ JWT / 만료 / 재발급 검증     │
│ [Ready 2] [In Progress 1]    │
│ + Task   + Connect           │
├──────────────────────────────┤
│ 계정 상태 확인            ○──┼──>
│ 정지 / 탈퇴 / 점검 상태     │
│ [Blocked 1]                 │
│ + Task   + Connect           │
├──────────────────────────────┤
│ + Add item                   │
└──────────────────────────────┘
```

필수 UX:

- Node 제목 편집
- Node 설명 추가/수정
- Item 추가/삭제/순서 변경
- Item 제목 편집
- Item 설명 추가/수정
- Item에 기존 Task 연결
- Item에서 새 Task 생성 후 바로 연결
- 연결된 Task 상태 표시
- Item에서 다른 Node로 연결
- 연결 해제
- Node 자체 삭제/보관 정책

### 4.2 독립 Node 생성

연결 대상이 없어도 Node를 먼저 만들 수 있어야 한다.

진입점 후보:

- Investigation toolbar의 `+ Node`
- 빈 캔버스 더블클릭
- 빈 캔버스 context menu

1차 구현은 명시적인 `+ Node` 버튼부터 시작한다.

새 Node는 현재 viewport 중앙 또는 사용자가 지정한 위치에 생성한다.

### 4.3 Task 연결 UX

Item의 `+ Task`를 누르면 두 경로를 제공한다.

```text
Link existing task
Create new task
```

기존 Task 검색 시 최소한 아래 정보 표시:

- title
- status
- priority
- Claim 여부

Task chip 예:

```text
[● In Progress · 세션 TTL 수정]
[✓ Done · 인증 실패 로그 분리]
```

Task chip을 누르면 기존 Task drawer를 열어야 한다.

### 4.4 Item → Node 연결 UX

초기 구현 후보:

1. Item 우측 연결 핸들 클릭
2. 대상 Node 선택
3. 선 생성

후속 UX:

- Item 연결 핸들 drag → 대상 Node drop
- 빠른 검색으로 대상 Node 선택
- 연결 label 입력

선은 반드시 **어느 Item에서 출발했는지** 시각적으로 구분되어야 한다.

### 4.5 Zoom과 정보 밀도

현재 구현한 50~150% canvas zoom을 Investigation Graph에 그대로 활용한다.

장기 목표는 semantic zoom이다.

예:

```text
50~70%
  Node title
  Item title
  Task 상태 개수
  주요 연결선

80~110%
  Node description 일부
  Item description 일부
  Task chips

120~150%
  상세 설명
  Task title/상태/Claim
  세부 조작 버튼
```

1차 구현에서 semantic zoom까지 모두 구현할 필요는 없지만 DOM 구조는 향후 정보 밀도 제어가 가능하게 만든다.

---

## 5. 데이터 모델 TODO

### P0

- [ ] `investigation_nodes` migration 설계
- [ ] `investigation_items` migration 설계
- [ ] `investigation_item_links` migration 설계
- [ ] `investigation_item_tasks` migration 설계
- [ ] Node/Item revision 정책 결정
- [ ] Node/Item delete 정책 결정
- [ ] Item 삭제 시 Node link / Task link cascade 정책 결정
- [ ] Project 삭제 시 Investigation graph cascade 확인
- [ ] board position에 `investigation_node` entity type 허용

권장 테이블 초안:

```text
investigation_nodes
  id PK
  project_id FK
  title
  description
  kind nullable
  revision
  created_at
  updated_at

investigation_items
  id PK
  node_id FK
  title
  description
  sort_order
  revision
  created_at
  updated_at

investigation_item_links
  id PK
  project_id FK
  from_item_id FK
  to_node_id FK
  label nullable
  kind nullable
  created_at

investigation_item_tasks
  item_id FK
  task_id FK
  sort_order nullable
  created_at
  PRIMARY KEY(item_id, task_id)
```

### 데이터 원칙

- [ ] 특정 에이전트 제품명을 Investigation core model에 넣지 않는다
- [ ] Claim을 Node/Item mutation permission으로 사용하지 않는다
- [ ] Task의 status/Claim/Activity는 기존 Task source of truth를 그대로 사용한다
- [ ] Node position은 내용 revision과 분리된 layout metadata로 유지한다
- [ ] 일반 mutation은 기존 requestId/idempotency 정책과 같은 수준으로 맞춘다
- [ ] Node/Item update에도 내부 optimistic concurrency 원칙 적용 검토

---

## 6. Service / API TODO

### P0 Node

- [ ] create Investigation Node
- [ ] list Project Investigation Nodes
- [ ] get Investigation Node
- [ ] update Investigation Node title/description/kind
- [ ] delete/archive Investigation Node

### P0 Item

- [ ] create Item under Node
- [ ] update Item title/description
- [ ] reorder Items
- [ ] delete Item

### P0 Item → Task

- [ ] link existing Task to Item
- [ ] unlink Task from Item
- [ ] list Tasks linked to Item
- [ ] create Task + link to Item composition flow

### P0 Item → Node

- [ ] create Item-to-Node link
- [ ] remove Item-to-Node link
- [ ] optional label update
- [ ] graph list endpoint에서 links 포함

### Graph query

한 화면 렌더에 지나치게 많은 HTTP round trip이 생기지 않도록 Project 단위 graph snapshot endpoint를 우선 검토한다.

예:

```text
GET /projects/:projectId/investigation/graph

{
  nodes: [...],
  items: [...],
  itemLinks: [...],
  itemTaskLinks: [...],
  tasks: [...],
  positions: [...],
  artifacts: [... optional]
}
```

- [ ] 현재 `/investigation` endpoint와 호환/교체 전략 결정
- [ ] graph snapshot payload 크기 검토
- [ ] mutation 후 전체 reload 없이 local patch 가능하도록 response shape 설계

---

## 7. Agent / CLI / MCP boundary TODO

Investigation Graph는 Web 전용 데이터가 아니다. QuestBoard의 vendor-neutral 원칙을 유지한다.

### P1

- [ ] neutral agent-tool에 Node create/list/get/update 추가
- [ ] Item create/update/reorder/delete 추가
- [ ] Item ↔ Task link/unlink 추가
- [ ] Item → Node link/unlink 추가
- [ ] Project graph snapshot read 추가
- [ ] CLI command 노출
- [ ] MCP `questboard_*` tool 노출
- [ ] mutation requestId 자동 생성/replay 계약 유지
- [ ] cross-agent E2E에서 다른 adapter가 만든 Node/Item을 Web에서 확인

에이전트가 활용할 수 있는 목표 예:

```text
"세션 생성 노드의 TTL 계산 항목에 이 Task를 연결해줘"
"로그인 흐름에서 아직 할 일이 없는 항목을 알려줘"
"Blocked Task가 붙어 있는 Investigation Item 목록을 보여줘"
```

---

## 8. Web UI 구현 TODO

### P0 1차 슬라이스

- [x] `+ Node` 버튼
- [x] 독립 Node 생성
- [x] Node card title + description 표시/편집
- [x] Node에 Item 추가
- [x] Item title + description 표시/편집
- [x] Item에 existing Task 연결
- [x] Item에서 new Task 생성 후 연결
- [x] Item에 연결된 Task chip/status 표시
- [x] Item → 다른 Node 연결
- [x] Item origin을 기준으로 edge 렌더
- [x] Node drag 위치 저장
- [x] 기존 zoom 적용
- [x] Node drag undo/redo와 연동

### P1 사용성

- [ ] Item reorder drag
- [ ] Node search
- [ ] 연결 대상 Node quick search
- [ ] Task quick search/filter
- [ ] 완료 Task 접기
- [ ] Node collapse/expand
- [ ] Item collapse/expand
- [ ] 연결선 hover 시 출발 Item/도착 Node 강조
- [ ] 선택 Node와 1-hop 이외 흐리기
- [ ] orphan/unlinked Node 필터
- [ ] Task 없는 Item 필터
- [ ] Blocked Task 포함 Node 강조
- [ ] In Progress Task 포함 Node 강조

### P2 Graph navigation

- [ ] canvas pan 전용 interaction
- [ ] fit graph to viewport
- [ ] selected Node focus
- [ ] minimap 검토
- [ ] semantic zoom
- [ ] auto layout 보조 기능 검토
- [ ] edge crossing 완화
- [ ] 분기 label 시각화

---

## 9. 기존 Investigation Board 마이그레이션 전략

현재 화면은 Task와 Artifact 자체가 Node처럼 떠 있고 Relation 선을 그린다.

새 모델로 한 번에 제거하지 않는다.

### 단계 A

새 InvestigationNode / Item model을 추가하되 기존 Task/Artifact 렌더와 데이터는 유지한다.

- 기존 Task/Artifact board position 보존
- 기존 Relation 보존
- 새 Graph Node를 병행 렌더하거나 feature flag 아래 도입

### 단계 B

새 Node 중심 UX가 충분히 동작하면 Task는 Node 자체가 아니라 Item에 붙는 work chip 역할을 기본으로 전환한다.

Artifact도 이후 Node/Item attachment 쪽으로 연결하는 UX를 추가한다.

### 단계 C

기존 Task/Artifact free-node 렌더가 실제 사용에 필요하지 않으면 legacy visualization로 축소하거나 제거한다.

주의:

- 기존 DB 데이터 자동 삭제 금지
- 기존 Relation 의미를 새 flow link로 자동 변환하지 않음
- 기존 board_positions를 무조건 migration하지 않음
- 사용자가 만든 현재 Investigation 배치를 보존할 것

---

## 10. Undo / Redo 범위 확장 TODO

현재 구현한 undo/redo는 Node 위치 이동 히스토리 중심이다.

Graph 편집이 늘어나면 아래 작업도 history 대상 후보가 된다.

- [ ] Node 생성/삭제
- [ ] Node title/description 수정
- [ ] Item 생성/삭제
- [ ] Item reorder
- [ ] Item → Node 연결/해제
- [ ] Item → Task 연결/해제

다만 서버 persisted mutation 전체를 일반적인 command stack으로 되돌리는 것은 복잡도가 커질 수 있다.

1차 Graph 구현에서는 **위치 이동 undo/redo만 유지**하고, 구조 mutation undo/redo는 별도 설계 후 추가한다.

---

## 11. 완료 기준

Investigation Graph 1차 구현 완료 기준:

- [x] 빈 보드에서 독립 Node를 만들 수 있다
- [x] Node에 설명을 작성할 수 있다
- [x] Node에 여러 Item을 만들 수 있다
- [x] 각 Item에 별도 설명을 작성할 수 있다
- [x] 각 Item에 0..N개의 기존 Task를 연결할 수 있다
- [x] Item에서 새 Task를 만들고 즉시 연결할 수 있다
- [x] Task 상태가 Item 내부에서 바로 보인다
- [x] 각 Item을 다른 Node에 연결할 수 있다
- [x] 연결선이 Node 전체가 아니라 출발 Item을 식별할 수 있다
- [x] 연결되지 않은 Node도 정상적으로 유지된다
- [x] Node 위치가 저장된다
- [x] 위치 이동 undo/redo가 유지된다
- [x] 확대/축소 상태에서도 drag 좌표와 edge가 정상이다
- [x] Quest Board에서 본 Task 상태와 Investigation의 Task 상태가 동일하다
- [x] reload/restart 후 Node/Item/link/task link/position이 모두 복원된다
- [x] HTTP/Web뿐 아니라 neutral service boundary에서 같은 데이터를 사용할 수 있다
- [x] 기존 Task/Artifact/Relation 데이터를 손실하지 않는다

---

## 12. 구현 순서 제안

### Phase 1: Foundation

1. [x] InvestigationNode / Item / ItemLink / ItemTaskLink domain type
2. [x] SQLite migration + repository
3. [x] service CRUD
4. [x] graph snapshot read
5. [x] HTTP contract + tests

### Phase 2: Basic Graph UI

1. [x] `+ Node`
2. [x] Node description
3. [x] Item list + Item description
4. [x] 기존 zoom/drag/position integration
5. [x] 독립 Node persistence

### Phase 3: Work Overlay

1. [x] existing Task link/unlink: backend/MCP/Web 연결·해제 지원
2. [x] new Task + link
3. [x] Task status/priority/Claim chips
4. [x] Task drawer integration

### Phase 4: Flow Links

1. [x] Item → Node link model
2. [x] edge render anchor를 Item으로 이동
3. [x] link create/remove UI
4. [x] label/branch 표시

### Phase 5: Agent-neutral adapters

1. [x] agent-tool
2. [ ] CLI 전용 command UX
3. [x] MCP (`tools/list` / `tools/call` 공통 boundary)
4. [x] agent-tool + MCP regression test

### Phase 6: Navigation polish

1. orphan/filter/highlight
2. fit-to-view
3. pan
4. semantic zoom
5. graph readability 개선

---

## 13. 구현 시 지켜야 할 핵심 원칙

1. **Investigation Node와 Task를 같은 개념으로 합치지 않는다.**
   - Node는 구조/흐름을 설명한다.
   - Task는 실행 가능한 실제 일이다.

2. **Task는 중복 생성하지 않는다.**
   - Investigation Item은 기존 Task에 링크한다.
   - Quest Board와 Investigation은 같은 Task 상태를 본다.

3. **연결의 출발점은 Item이다.**
   - 그래야 한 Node 내부에서 서로 다른 다음 흐름을 표현할 수 있다.

4. **연결되지 않은 Node를 1급 상태로 허용한다.**
   - 아직 구조에 넣지 않은 아이디어/TODO도 보드에 둘 수 있어야 한다.

5. **그래프는 프로젝트 이해와 실행 상태를 동시에 보여줘야 한다.**
   - 구조만 보여주는 다이어그램도 아니고,
   - Task만 보여주는 TODO 그래프도 아니다.

6. **기존 데이터와 adapter-neutral core를 깨뜨리지 않는다.**
   - Web 편의 기능을 core domain에 제품 종속 개념으로 밀어 넣지 않는다.

7. **멀리서는 흐름, 가까이서는 작업이 보여야 한다.**
   - 향후 semantic zoom과 정보 밀도 제어의 기준으로 사용한다.

---

## 14. 이번 TODO의 우선 결론

가장 먼저 구현할 실제 slice는 다음으로 잡는다.

```text
InvestigationNode
  title
  description
  position
  0..N InvestigationItem

InvestigationItem
  title
  description
  0..N linked Task
  0..N outgoing Node link
```

첫 E2E 시나리오:

```text
1. 독립 Node "로그인 흐름" 생성
2. Node description 작성
3. Item "토큰 검증" 생성 + description 작성
4. 기존 Task 두 개를 Item에 연결
5. Item에서 "세션 생성" Node로 연결
6. 별도 독립 Node "TODO 후보" 생성, 연결하지 않은 채 유지
7. reload
8. 모든 Node/Item/Task link/flow link/position이 복원되는지 확인
9. Quest Board에서 Task 상태 변경
10. Investigation Item 내부 Task 상태가 같은 값으로 반영되는지 확인
```

이 시나리오가 통과하면 사용자가 원하는 "프로젝트 동작 흐름 + 그 위치의 실제 할 일"이라는 핵심 경험이 처음으로 완성된 것으로 본다.
