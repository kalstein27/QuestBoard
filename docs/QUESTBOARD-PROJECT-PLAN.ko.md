# QuestBoard 프로젝트 계획서

상태: 구현 진행 / Foundation + Local HTTP API + Web Quest Board + Investigation Board MVP + CLI + MCP + Evidence Layer

이 문서는 **QuestBoard**라는 독립 프로젝트의 제품 방향, 범위, 데이터 모델, 에이전트 연동 방식, 단계별 구현 계획을 정의한다. 최초 작성 시점에는 구현 전 계획 문서였으며, 현재는 agent-neutral core, SQLite foundation, localhost/Tailnet HTTP API, Web Quest Board, CLI/MCP adapter, Artifact/Relation 기반 Evidence layer와 첫 Investigation Board MVP까지 구현이 진행되었다.

---

## 1. 이름과 콘셉트

제품명: **QuestBoard**

핵심 이미지:
- 게임 속 길드의 의뢰 게시판처럼 여러 작업이 걸려 있고, 에이전트가 의뢰를 선택해 수행하는 공간
- 추리물/형사물의 사건 보드처럼 작업, 증거, 관련 문서, 에이전트 활동, 의존성을 카드와 연결선으로 배열하는 공간

QuestBoard는 단순 TODO 앱이 아니라 **사람과 여러 AI 에이전트가 함께 사용하는 로컬 우선 작업 조정 보드**를 목표로 한다.

---

## 2. 핵심 목표

QuestBoard는 ChatGPT/C2CT, Claude, Antigravity 및 향후 추가되는 다른 에이전트가 특정 벤더에 종속되지 않고 같은 작업 상태를 공유할 수 있게 한다.

주요 목표:
1. 사용자와 여러 에이전트가 같은 Task / Project / Activity 상태를 읽고 수정할 수 있다.
2. 작업이 어느 에이전트에 의해 진행 중인지 명확하게 표시한다.
3. 한 에이전트가 남긴 작업 결과를 다른 에이전트가 자연스럽게 이어받을 수 있다.
4. 작업의 문서, 파일, 커밋, 스크린샷, 로그 등 관련 증거를 하나의 카드 주변에 연결할 수 있다.
5. 특정 에이전트의 내부 개념을 핵심 데이터 모델에 강제하지 않는다.

---

## 3. 비목표

QuestBoard 초기 버전은 다음을 목표로 하지 않는다.

- 범용 프로젝트 관리 SaaS
- GitHub/Jira/Linear 대체
- 원격 다중 사용자 인증 시스템
- 에이전트 런타임 자체
- 코드 실행기
- C2CT의 work lane이나 runtime approval을 대체하는 권한 시스템

QuestBoard의 Claim은 협업 상태이고, 로컬 프로젝트 변경 권한은 각 에이전트/도구의 별도 보안 경계를 따른다.

---

## 4. 핵심 개념

### Project

여러 Task가 속하는 작업 단위.

초기 필드 예시:
- id
- name
- description
- rootPath optional
- status
- createdAt
- updatedAt

### Task

QuestBoard의 핵심 카드.

초기 필드 예시:
- id
- projectId
- title
- description
- status
- priority
- tags
- createdBy
- createdAt
- updatedAt
- revision

초기 상태:
- Inbox
- Planned
- Ready
- In Progress
- Blocked
- Review
- Done

### Agent

Task를 읽거나 Claim할 수 있는 주체.

특정 제품명을 domain type으로 만들지 않는다.

예:
- actor id
- provider
- displayName

### Claim

Task를 누가 맡고 있는지 나타내는 협업용 coordination signal. 사용자/에이전트에게는 잠금처럼 보이지 않으며 일반 Task mutation을 차단하지 않는다.

초기 원칙:
- Task당 active Claim 하나
- 같은 actor의 재Claim은 idempotent
- 다른 actor의 active Claim은 conflict
- release는 Claim owner만 가능
- Claim TTL은 초기에는 사용하지 않음

Claim은 권한이 아니다.
Claim은 일반 mutation lock도 아니다. release 시 관찰한 `claimId`를 함께 보내면 release/re-Claim 사이의 stale release를 방지할 수 있다.

### Activity

append-only 작업 이력.

초기 type:
- task_created
- task_updated
- status_changed
- task_claimed
- task_released
- note_added
- artifact_attached
- relation_added
- agent_handoff

### Artifact

Task에 연결되는 결과물/증거.

향후 예:
- file
- URL
- commit
- screenshot
- operation reference
- log

### Relation

Task / Artifact / Note 사이의 연결.

장기적으로 Investigation Board의 엣지가 된다.

---

## 5. 제품 경험

QuestBoard는 두 개의 축으로 성장한다.

### Quest Board

작업 진행 관점.

- 여러 status column
- priority / tag
- Claim 표시
- agent/human attribution
- drag-and-drop
- task drawer

### Investigation Board

프로젝트 동작 구조와 그 위치의 실제 작업을 함께 보는 실행 지도 관점.

- 독립적인 Investigation Node로 기능/흐름/컴포넌트/아이디어를 표현
- Node마다 설명과 여러 Item을 보유하고, Item마다 별도 설명을 기록
- 하나의 Item에 여러 canonical Task를 연결해 Quest Board와 동일한 작업 상태를 공유
- 특정 Item에서 다른 Investigation Node로 방향성 flow edge 연결
- 아직 어디에도 연결하지 않은 Node도 TODO/후보 구조로 유지
- 기존 Artifact/Relation은 증거 관계로 보존하고 기존 Task/Artifact free-layout도 Graph 도입 전 프로젝트의 호환 화면으로 유지

1차 Investigation Graph는 Node/Item/Task overlay/Item-origin flow link의 SQLite·service·HTTP·Web·agent-tool/MCP 수직 슬라이스를 구현한다. Node 위치는 Task revision/Activity와 분리된 `board_positions`에 저장하며 기존 위치 이동 undo/redo와 50~150% 확대/축소를 그대로 사용한다. 검색/필터, Item reorder, 전용 pan, semantic zoom, 더 풍부한 편집 UI는 후속 단계다.

---

## 6. 중립성 원칙

QuestBoard core에는 특정 에이전트 개념을 넣지 않는다.

금지 예:
- chatgptTaskId
- codexLeaseId를 필수 domain field로 사용
- claudeSession을 core에 직접 저장

필요한 agent-specific metadata는 adapter 또는 optional metadata에 둔다.

---

## 7. 저장 방식

초기 canonical storage는 로컬 SQLite로 한다.

권장 이유:
- 하나의 로컬 source of truth
- transaction
- 여러 adapter에서 공유 가능
- Task/Claim/Activity query에 적합
- 향후 export 가능

초기 테이블:

```text
projects
tasks
claims
activities
```

Artifact/Relation 후속 migration은 구현되었다. Artifact는 Task에 연결되고, Relation은 현재 Task/Artifact endpoint 사이의 방향성 edge를 저장한다. Investigation Board 좌표는 별도 `board_positions` 테이블에 저장한다. Note는 아직 별도 graph entity가 아니라 Activity의 `note_added`로 유지한다.

SQLite DB는 기본적으로 `.questboard/questboard.sqlite`에 두며 Git에는 포함하지 않는다.

---

## 8. 데이터 원칙

### Task revision

모든 Task mutation마다 revision을 증가시킨다.

저장 계층은 revision 기반 compare-and-set을 사용한다. 일반 adapter 호출은 `expectedRevision`을 노출하지 않아도 되며, service가 최신 Task를 다시 읽어 bounded retry한다. 호출자가 특정 read 이후 변경이 없었음을 강제해야 할 때만 `expectedRevision`을 선택적으로 보내 strict-CAS로 사용한다.

### Mutation idempotency

mutation은 선택적 `requestId`를 받을 수 있다. 같은 actor/operation/input의 정확한 재시도는 저장된 receipt 결과를 반환하고 side effect를 중복 적용하지 않는다. 동일 `requestId`를 다른 입력에 재사용하면 conflict로 처리한다. Web/CLI/MCP는 일반 mutation에 request ID를 자동 생성하며, 외부 HTTP client는 재시도가 필요한 경우 동일 요청에 같은 ID를 재사용한다.

### Claim과 Task status

Claim과 Task status는 독립적이다.

예:
- Ready + claimed
- In Progress + claimed
- Blocked + claimed

Claim 시 자동으로 In Progress로 바꾸지 않는다.

### Activity

Task 변경/Claim/release는 Activity와 같은 transaction에서 기록한다.

클라이언트가 직접 추가 가능한 Activity는 초기에는:
- note_added
- agent_handoff

으로 제한한다.

---

## 9. 로컬 우선

초기 버전은 로컬 우선이다.

- SQLite 파일
- localhost HTTP
- 같은 Tailnet에서 선택적 private access
- CLI
- stdio MCP

public internet 노출과 원격 auth는 후속 범위다.

초기에는 DB를 Git에 직접 버전 관리하지 않는다.

필요하면 추후 다음을 추가한다.
- export/import JSON
- markdown snapshot
- backup
- external sync

---

## 10. API 원칙

Core server는 vendor-neutral local API를 제공한다.

권장 순서:

1. Local HTTP API
2. CLI
3. MCP adapter
4. agent-specific adapters

예상 API:

```text
GET    /projects
GET    /tasks
POST   /tasks
GET    /tasks/:id
PATCH  /tasks/:id
POST   /tasks/:id/claim
POST   /tasks/:id/release
POST   /tasks/:id/activity
POST   /tasks/:id/artifacts
POST   /relations
GET    /activity
```

Task mutation은 내부 revision/CAS로 경쟁 상태를 제어한다. 일반 호출은 충돌 시 최신 상태에 patch를 재적용해 외부에는 lockless하게 보이고, strict `expectedRevision` 모드에서는 stale writer를 명시적으로 거부한다. mutation receipt는 네트워크/클라이언트 재시도에 따른 중복 side effect를 막는다.

---

## 11. 에이전트 연결 방식

### ChatGPT / C2CT

QuestBoard adapter를 통해 다음이 가능해야 한다.
- 내 프로젝트 TODO 읽기
- Ready 작업 찾기
- Task claim
- 진행 상태 갱신
- 결과/문서/operation reference 기록
- 다른 에이전트가 남긴 handoff 읽기

C2CT의 work lane과 QuestBoard claim은 별개다.

```text
QuestBoard Claim
= 누가 이 일을 맡고 있는지

C2CT Work Lane
= 로컬 프로젝트를 실제로 변경할 권한
```

### Claude

가능한 연결 수단:
- MCP
- CLI
- HTTP adapter

CLAUDE.md 또는 agent onboarding 문서에는 QuestBoard 사용 규칙만 얇게 연결한다.

### Antigravity 및 기타 에이전트

특정 SDK를 core 요구사항으로 만들지 않는다.

최소 조건:
- HTTP 호출 가능 또는
- CLI 실행 가능 또는
- MCP 지원

이 셋 중 하나면 연결할 수 있는 구조를 목표로 한다.

---

## 12. UI 방향

QuestBoard UI는 일반적인 Kanban과 사건 보드 두 가지 관점을 제공하는 방향이 좋다.

### View A: Quest Board

- Inbox
- Planned
- Ready
- In Progress
- Blocked
- Review
- Done

카드는 작업 도구처럼 높은 정보 밀도와 낮은 장식성을 우선한다.

### View B: Investigation Board

후속 단계에서 구현한다.

- 자유 배치 node
- relation edge
- artifact preview
- activity/handoff trace

---

## 13. Task 카드 정보

최소 표시:
- title
- priority
- tags
- Claim actor
- status

상세 drawer:
- description
- edit
- Claim / Release
- Activity
- Note / handoff

---

## 14. Claim UX

Claim은 경쟁 잠금이 아니라 협업 신호로 표현한다.

UI/MCP/CLI 모두 같은 의미를 사용한다.

- unclaimed
- claimed by actor
- conflicting claim
- explicit release

다른 actor가 Claim 중이면 일반 mutation까지 금지하지 않는다. Claim은 coordination signal이다.

---

## 15. 에이전트 도구 인터페이스

현재 공통 adapter tool boundary는 다음을 제공한다.

```text
questboard_list_projects
questboard_create_project
questboard_list_tasks
questboard_get_task
questboard_create_task
questboard_update_task
questboard_get_claim
questboard_claim_task
questboard_release_task
questboard_list_activity
questboard_add_activity
```

CLI와 MCP가 같은 tool executor를 사용하고, executor는 `QuestBoardService`만 호출한다.

mutation은 neutral actor `{ id, provider, displayName? }`를 명시한다.

---

## 16. CLI 방향

CLI는 자동화/디버깅/비-MCP 에이전트용 얇은 surface다.

현재 명령:
- projects
- tasks
- task
- create-task
- update-task
- claim / release / claim-status
- activity / add-activity

출력은 JSON으로 유지한다.

---

## 17. MCP 방향

현재 런타임은 **daemon 1 + session client N** 구조다. 장기 실행 QuestBoard daemon 하나가 SQLite, `QuestBoardService`, Web UI/API를 독점 소유하고, Claude 등 MCP host가 세션마다 띄우는 MCP executable은 DB를 열지 않는 얇은 stdio proxy로 동작한다. 각 proxy는 수명 동안 고유 session id를 유지해 자동 mutation requestId 격리를 보존하며, proxy 종료는 daemon이나 다른 세션을 종료하지 않는다. 기본 daemon endpoint는 `127.0.0.1:4317`; daemon의 LAN/Tailnet 노출은 기존처럼 명시적 opt-in이고 MCP/CLI client는 `QUESTBOARD_DAEMON_URL`로 접속점을 선택한다. 공개 인터넷 직접 노출은 지원 범위가 아니다.

지원:
- initialize
- ping
- tools/list
- tools/call

agent SDK나 특정 vendor SDK를 core/runtime 의존성으로 추가하지 않는다.

---

## 18. 보안 경계

QuestBoard 자체 actor id/provider는 attribution이다.

아직 제공하지 않는 것:
- authentication
- authorization
- filesystem permission
- process execution permission

따라서 Tailnet access도 trusted private-network deployment 전제로만 사용한다.

---

## 19. 테스트 전략

초기 검증:
- domain/service flow
- SQLite reopen persistence
- HTTP E2E
- Web asset serving
- common agent tool flow
- MCP stdio initialize/tools/list/tools/call
- CLI neutral actor override

후속:
- 실제 외부 MCP client와 교차 E2E
- 여러 실제 provider/client를 장시간 함께 사용하며 handoff/재시작/재전송 시나리오 검증

구현됨:
- worker thread + 독립 SQLite connection 기반 동시 Claim 경합
- strict revision CAS race
- revision token을 노출하지 않는 lockless Task update race
- requestId exact replay / misuse conflict
- claimId stale-release 보호

---

## 20. 단계별 구현

### MVP 0: Foundation
- core domain
- SQLite schema
- service/repository boundary
- architecture decisions

### MVP 1: Shared Quest Board
- Project/Task CRUD 기본
- status/priority/tags
- Claim/Release
- Activity
- local HTTP API
- minimal Web Kanban

### MVP 2: Agent connectivity
- CLI
- MCP adapter
- neutral actor/tool boundary
- agent-neutral onboarding 문서
- 실제 외부 client cross-agent E2E

### MVP 3: Evidence / Investigation
- Artifact
- Relation
- Investigation Board
- search/filter

---

## 21. 제품 정체성

QuestBoard를 한 문장으로 정의하면:

> **사람과 여러 AI 에이전트가 의뢰를 맡고, 단서를 연결하고, 작업의 흔적을 공유하는 로컬 작업 보드.**

제품이 성장해도 단순 "AI TODO 앱"보다 이 정체성을 유지한다.

---

## 22. 구현 시작 시 첫 작업

향후 다른 에이전트가 구현을 시작한다면 다음 순서로 진행한다.

1. 독립 저장소 `QuestBoard` 생성
2. AGENTS.md / agent onboarding 문서에 agent-neutral 원칙 기록
3. architecture + schema 문서 확정
4. SQLite schema와 core domain 구현
5. local API 구현
6. 최소 Web Kanban 구현
7. CLI 구현
8. MCP adapter 구현
9. ChatGPT + Claude 교차 E2E
10. Evidence Board 확장

각 단계는 작게 검증하고, 초기부터 C2CT 전용 데이터 모델로 굳히지 않는다.

---

## 23. 결정된 사항

- 제품명: **QuestBoard**
- ChatGPT2Codex와 별도의 독립 repo로 설계
- GPT뿐 아니라 Claude, Antigravity 등 여러 에이전트가 사용 가능해야 함
- Core는 agent/vendor-neutral
- 로컬 우선
- SQLite 권장
- HTTP API + CLI + MCP adapter 계층
- Claim은 협업 상태를 표시하는 coordination signal이며 일반 Task mutation을 막지 않음
- Kanban형 Quest Board + 사건/증거형 Investigation Board를 장기 UI 방향으로 사용
- Shared Browser는 후속 확장

## 24. 아직 결정하지 않은 사항

실제 구현 시 선택할 항목:
- graph UI library
- Task id 형식
- Claim TTL 기본값
- remote authentication 방식
- public deployment 여부
