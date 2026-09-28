# QuestBoard 프로젝트 계획서

상태: 제품 방향 재정렬 / AI-human work continuity 중심

이 문서는 **QuestBoard**의 제품 방향에 대한 최상위 기준이다. 현재 구현에는 Task/Claim/Activity/Artifact/Relation, Investigation Graph, Code Map, HTTP/CLI/MCP/Web이 포함되어 있지만, 기능의 존재 자체가 앞으로도 유지·확장해야 할 이유는 아니다. 이후 기능 판단은 항상 **사람과 AI가 작업 목표와 현재 위치를 공유하고, 컨텍스트가 끊겨도 최소 토큰과 최소 액션으로 같은 작업 흐름에 복귀할 수 있는가**를 기준으로 한다.

아래 세 가지 원칙이 하위 구현 세부사항과 충돌하면 이 원칙을 우선한다.

1. **Continuity first**: AI의 세션·컨텍스트·메모리가 끊겨도 작업은 이어져야 한다.
2. **Minimal outside, dense inside**: 사람에게 보이는 화면과 조작은 단순하게, 내부 연결과 복구 정보는 촘촘하게 유지한다.
3. **Do not replace specialist tools**: Git, Jira, Confluence, Mantis가 잘하는 일을 QuestBoard가 다시 만들지 않는다.

---

## 1. 제품 정체성

제품명: **QuestBoard**

QuestBoard는 개인 작업자가 AI와 함께 요구사항을 구현하고 개선할 때 사용하는 **작업 연속성(work continuity) 협업 도구**다.

핵심 질문은 세 개뿐이다.

- **무엇을 하려는가?** — 공유된 Goal / Task
- **지금 어디까지 왔는가?** — 현재 Focus / 의미 있는 Checkpoint
- **다음에 무엇을 해야 하는가?** — Next Action / Blocker / 최소 Evidence

사람은 이 세 질문의 답을 짧게 보고 판단할 수 있어야 한다. AI는 필요할 때만 뒤에 연결된 코드 위치, 검증 결과, 관련 Task, Activity, Artifact, Code Map 근거를 더 읽는다.

QuestBoard가 성공하면 새 AI 세션은 긴 대화 기록을 재독하거나 사용자가 장문의 인수인계를 다시 작성하지 않고도 몇 번의 조회만으로 기존 작업 레일에 복귀할 수 있다.

---

## 2. 핵심 목표

1. **사람과 AI가 같은 목표를 본다.** 요청의 목적, 현재 범위, 완료 기준을 하나의 짧은 작업 상태로 공유한다.
2. **현재 작업 위치를 잃지 않는다.** 지금 진행 중인 단계, 방금 확인된 사실, 다음 액션, 막힌 이유를 명확히 남긴다.
3. **AI가 싸게 복귀한다.** 새 채팅, 컨텍스트 압축, 모델 교체, 에이전트 교체 뒤에도 최소 조회와 최소 토큰으로 작업을 재개할 수 있다.
4. **사람이 쉽게 따라간다.** 내부 추론 전문을 노출하지 않고도 어떤 목표를 향해 어떤 단계가 완료됐고 무엇이 남았는지 이해할 수 있다.
5. **필요한 근거만 연결한다.** 코드 위치, 테스트 결과, 스크린샷, operation, 문서 링크 등 재개와 판단에 필요한 Evidence만 연결한다.
6. **vendor-neutral을 유지한다.** ChatGPT/C2CT, Claude, CLI, MCP 및 미래 에이전트가 같은 canonical work state를 공유할 수 있게 한다.

### Resume Capsule

QuestBoard의 핵심 산출물은 거대한 작업 일지가 아니라, 언제든 다시 작업을 시작할 수 있게 하는 작은 **Resume Capsule**이다.

개념적으로 다음 정보면 충분해야 한다.

```text
Goal      지금 해결하려는 것
Now       현재 도달한 상태 / 방금 확인한 사실
Next      바로 다음 액션
Next Task Next가 `next-task` relation으로 특정 canonical child Task를 명시할 때만 opaque task id reference
Blocked   진행을 막는 조건이 있을 때만
Code      관련 코드/컴포넌트 위치가 필요할 때만
Evidence  테스트·로그·스크린샷 등 판단에 필요한 최소 근거
Guardrail 다시 하지 말아야 할 것 / 보존해야 할 제약이 있을 때만
```

모든 필드를 항상 채우는 것이 목표가 아니다. **재개에 필요한 최소 정보만 남기는 것**이 목표다.

---

## 3. 비목표

QuestBoard는 다음 제품을 대체하지 않는다.

- **Git / GitHub**: 소스 백업, 버전 이력, branch, diff, merge, release 관리
- **Jira / Linear**: 일정, sprint, 조직 단위 backlog, 담당자·리소스·프로젝트 관리
- **Confluence / Wiki**: 장문 지식 베이스, 상세 설계 문서, 조직 문서 허브
- **Mantis 등 bug tracker**: 정식 오류 접수, triage, 버그 수명주기 관리
- **IDE / code browser**: 범용 symbol explorer, 전체 call graph 탐색, 소스 편집 환경
- **AI transcript recorder**: chain-of-thought, 모든 시행착오, 모든 tool call을 영구 기록하는 시스템
- **에이전트 런타임 / 권한 시스템**: 코드 실행, filesystem 권한, C2CT lane/runtime approval 대체
- **범용 프로젝트 관리 SaaS**: 조직 운영 전반을 한곳으로 흡수하는 제품

QuestBoard의 Claim은 협업 상태이고, 로컬 프로젝트 변경 권한은 각 에이전트/도구의 별도 보안 경계를 따른다.

외부 전문 도구의 정보를 QuestBoard에 복제해서 또 하나의 source of truth를 만들지 않는다. 필요하면 링크나 짧은 참조만 둔다.

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

### Flow Work Group

Flow에서 사람이 작업 덩어리를 공간적으로 이해하기 위한 **시각적 Work Context**. canonical Task hierarchy와는 별도의 hierarchy이며 둘을 동일 source of truth로 취급하지 않는다.

- Work Group은 child Work Group을 포함할 수 있다.
- Task와 Investigation Node는 어느 깊이의 Work Group에도 직접 속할 수 있으며 leaf Group까지 내려갈 필요가 없다.
- 따라서 상위 `Code Map` Group에 직접 속한 Task와 `Code Map > SCIP` 같은 하위 Group의 Task가 동시에 존재할 수 있다.
- Group은 title / goal / visual bounds / collapse state를 가지며 canonical Task 연결은 optional이다.
- optional linked Task 또는 Task hierarchy는 Goal/progress/context 추천에 활용할 수 있지만 visual membership을 강제하지 않는다.
- 상위 Group 이동은 descendant Group과 명시적으로 포함된 Investigation Node의 상대 배치를 보존한다. 내부 Node/child Group의 개별 이동도 허용한다.
- Group 경계는 Flow edge routing obstacle이 아니다.

즉 Quest의 Task hierarchy, Flow의 visual Work Group hierarchy, Code의 code hierarchy는 서로 다른 topology이며 필요한 binding을 통해 연결한다.

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

제품 경험은 기능 수가 아니라 **작업 재개 비용**을 줄이는 방향으로 설계한다.

개념적으로 세 surface면 충분하다.

### Quest — 무엇을 하는가

- 현재 목표와 Task
- 상태와 다음 액션
- 필요할 때만 Claim/actor 표시
- 상세 정보는 drawer에서 요청 시 노출

### Flow — 어디까지 왔는가

현재 구현의 Investigation 기능을 이 역할로 사용한다.

- 전체 사고 과정을 그리지 않는다.
- 의미 있는 단계, 결정, 분기, blocker, 완료 checkpoint만 표현한다.
- 사람이 현재 위치와 다음 흐름을 빠르게 파악하는 것이 목적이다.
- Node/Item/edge의 존재가 목적이 아니라 **현재 작업의 지도**가 되는 것이 목적이다.
- 관련 Task/Node를 nested Work Group으로 공간적으로 묶을 수 있으며, 세부 Group이 아직 정해지지 않은 Task/Node는 상위 Group에 직접 둘 수 있다.
- visual Work Group 배치는 Task parent/child 관계를 복제하는 화면이 아니다. 사람이 현재 일을 이해하기 좋은 공간 구조를 우선한다.

### Code — 실제 코드가 어떻게 생겼고 연결되는가

Code Map의 정본은 사람에게 설명하기 위한 macro architecture 그림이 아니라 **provider-neutral raw code graph**다. 사용자와 AI agent가 같은 실제 source identity를 기준으로 `어디에 정의됐는가 / 어디에 속하는가 / 누가 사용하는가 / 무엇을 호출·참조하는가`를 직접 따라가는 작업지도다.

- file/symbol identity, language, source path/range, signature와 실제 containment/relation evidence를 보존한다.
- architecture projection은 필요할 때 사용하는 optional compatibility lens이며 Code Map 성공 여부나 canonical identity를 결정하지 않는다.
- agent는 전체 graph를 선로딩하지 않고 bounded query로 symbol, parent/children, callers/callees, references를 단계적으로 조회한다.
- 혼합언어 repository에서 provider가 없는 언어도 최소 file node는 보존하며 해석 부족은 coverage gap으로 명시한다.
- 부족한 parser/indexer/provider는 명시적 승인 경계에서 추가할 수 있고, 자동 해석이 놓친 실제 관계는 provenance가 분리된 manual wiring으로 보완할 수 있다.
- Git이 담당하는 코드 snapshot/diff/version history와 IDE의 source editing 기능은 중복 구현하지 않는다.

화면은 기본적으로 현재 작업에 필요한 정보만 보여준다. 고급 구조와 근거는 drill-down으로 숨긴다. **백조처럼 표면은 조용하고, 내부 연결은 빠르고 정교하게** 유지한다.

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

Artifact/Relation 후속 migration은 구현되었다. Artifact는 Task에 연결되고, Relation은 현재 Task/Artifact endpoint 사이의 방향성 edge를 저장한다. Flow Node 좌표는 별도 `board_positions` 테이블에 저장한다. visual Work Group은 `flow_work_groups`, Task/Investigation Node의 직접 visual membership은 `flow_work_group_memberships`에 저장한다. 이 membership은 canonical Task hierarchy와 독립적이다. Note는 아직 별도 graph entity가 아니라 Activity의 `note_added`로 유지한다.

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

DB 자체를 Git으로 버전 관리하지 않는다.

QuestBoard가 저장 데이터의 버전관리·백업 시스템으로 확장되는 것도 목표가 아니다. 필요하면 **작업 상태 이동을 위한 얇은 export/import** 정도만 추가하고, 소스 이력은 Git, 문서 이력은 문서 도구, 백업은 OS/스토리지 도구에 맡긴다.

외부 시스템과 연동하더라도 전체 데이터를 복제하지 않고 QuestBoard의 resume에 필요한 reference/link만 유지하는 것을 기본으로 한다.

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

## 12. UI / interaction 원칙

QuestBoard의 화면은 정보를 많이 보여주는 것이 아니라 **다음 판단을 빨리 하게 하는 것**을 목표로 한다.

기본 원칙:
- 한 화면에는 하나의 주된 질문과 하나의 주된 액션만 둔다.
- 사람에게는 현재 Goal / Now / Next가 먼저 보이고, 나머지는 요청 시 펼친다.
- ID, revision, provider, raw relation, 내부 provenance 같은 구현 정보는 기본 chrome에서 숨긴다.
- priority, tag, Claim actor도 항상 보이지 않는다. 실제 판단에 필요할 때만 노출한다.
- 고급 정보는 삭제하지 않고 drill-down으로 내린다.
- 기능을 추가할수록 화면이 복잡해지면 기능을 다시 축소한다.

제품 surface는 개념적으로 **Quest / Flow / Code** 세 가지면 충분하다. 이름과 navigation은 구현 과정에서 더 단순해질 수 있지만 각 surface가 답하는 질문은 유지한다.

---

## 13. Quest — 무엇을 하고 있는가

Quest는 사람과 AI가 공유하는 현재 작업 상태다.

기본적으로 한 Task에서 가장 먼저 읽혀야 하는 정보:
- **Goal**: 무엇을 해결하려는가
- **Now**: 현재 확인된 상태 / 마지막 의미 있는 checkpoint
- **Next**: 바로 다음 액션
- **Blocked**: 진행을 막는 것이 있을 때만
- **Guardrail**: 다시 하지 말아야 할 것, 보존해야 할 제약이 있을 때만

Task 상태와 board column은 협업에 필요한 최소 workflow 표현으로 유지하지만, Jira식 일정·sprint·resource 관리로 확장하지 않는다.

Task card 기본 화면은 title과 현재 상태를 중심으로 얇게 유지한다. description, Activity, Claim, Evidence, relation, 내부 메타데이터는 상세 surface에서 필요할 때만 읽는다.

---

## 14. Flow — 어디까지 왔는가

현재 Investigation 기능은 범용 화이트보드가 아니라 **작업 흐름의 의미 있는 checkpoint 지도**로 다듬는다.

Flow에 남길 가치가 있는 것:
- 작업 시작점
- 방향을 바꾼 결정
- 중요한 확인/검증 결과
- blocker와 해소
- 의미 있는 분기
- 완료 checkpoint
- 다음 단계로 넘어간 이유

Flow에 남기지 않는 것:
- 모든 tool call
- 모든 파일 read
- 모든 재시도
- 내부 chain-of-thought
- 디버그 로그 전체
- 실행 시간순 transcript 복제

사람은 Flow를 보고 현재 위치와 큰 진행 방향을 이해할 수 있어야 한다. AI는 Resume Capsule만으로 부족할 때에만 Flow의 인접 checkpoint를 추가로 읽는다.

---

## 15. Code — 어디를 보고 있는가

Code Map의 역할은 **범용 코드 탐색**이 아니라 작업 컨텍스트 복구다.

우선 가치가 높은 기능:
- 현재 Task/Flow와 관련된 architecture 영역 focus
- 파일명 / 핵심 symbol / relation 검색
- Task·Flow에서 관련 코드 위치로 이동
- Code에서 관련 Task·Flow로 돌아오기
- 관계가 왜 존재하는지 확인할 최소 source evidence

우선순위에서 제외하거나 외부 도구에 맡기는 기능:
- 소스 버전 이력과 코드 snapshot/diff 저장
- Git 대체용 변경 추적
- IDE급 전체 symbol hierarchy browser
- 전체 call graph explorer
- 독자적인 대규모 impact-analysis engine
- 코드 편집 기능

Git/IDE가 이미 가진 정보를 QuestBoard가 다시 저장하지 않는다. 필요한 경우 file/symbol/commit 같은 **anchor만 연결**한다.

---

## 16. 기능 추가 판단 기준

새 기능은 구현 전에 아래 질문을 통과해야 한다.

1. 이 기능이 없으면 사람이나 AI가 **현재 목표·현재 위치·다음 액션을 잃기 쉬운가?**
2. 이 기능이 실제로 **재개에 필요한 조회 수, 토큰 수, 사용자 재설명 횟수**를 줄이는가?
3. Git / Jira / Confluence / Mantis / IDE 같은 전문 도구가 이미 더 잘 해결하는 문제인가?
4. 별도의 source of truth를 하나 더 만드는가?
5. 기본 화면에 항상 보여야 하는가, 아니면 drill-down으로 충분한가?
6. 같은 효과를 더 적은 필드·버튼·상태로 만들 수 있는가?

1~2의 답이 약하거나 3~4의 답이 강하면 QuestBoard core에 넣지 않는다. 외부 링크, Artifact reference, Code anchor처럼 얇게 연결하는 방식을 먼저 선택한다.

---

## 17. 에이전트 도구 인터페이스 방향

현재 저수준 CRUD/MCP tool은 호환성과 자동화를 위해 유지할 수 있다. 다만 AI가 정상적으로 작업을 재개하기 위해 여러 도구를 연속 호출해야 한다면 제품 목표에 맞지 않는다.

앞으로 가장 중요한 고수준 계약은 두 가지다.

### Resume

한 번의 읽기로 가능한 한 다음을 돌려준다.

```text
Goal
Now
Next
Blocked?
Guardrail?
필요한 경우에만 Code / Flow / Evidence pointer
```

기본 응답에는 전체 Activity history, 전체 graph, 전체 Code Map을 넣지 않는다.

### Checkpoint

의미 있는 상태 변화가 생겼을 때 한 번의 쓰기로 Resume Capsule을 최신화하고 필요한 최소 Activity/Evidence 연결을 남길 수 있어야 한다.

handoff는 별도의 장문 보고서 작성 작업이 아니라 **마지막 Checkpoint를 정확히 남기는 것**에 가깝게 만든다.

최적화 목표는 tool 개수가 아니라 **resume까지 필요한 round-trip 수**다.

---

## 18. 보안 경계

QuestBoard 자체 actor id/provider는 attribution이다.

제공하지 않는 것:
- authentication / authorization 대체
- filesystem permission
- process execution permission
- 에이전트 runtime lease / approval 대체

따라서 C2CT work lane, Codex sandbox, OS 권한 등 실제 실행 권한은 각 runtime/tool의 보안 경계를 그대로 따른다. QuestBoard Claim은 누가 작업 중인지 알려주는 coordination signal일 뿐이다.

Tailnet access도 trusted private-network deployment 전제로만 사용하며, 공개 인터넷 배포가 필요하면 별도의 인증/전송 보안 계층을 둔다.

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

## 20. 현재 제품 우선순위

기반 기능은 이미 충분히 넓다. 당분간 새로운 관리 영역을 추가하기보다 기존 기능을 **작업 연속성 중심으로 축소·연결**한다.

### Priority A: Resume flow

- Task에서 Goal / Now / Next / Blocker / Guardrail을 빠르게 읽고 갱신
- agent handoff를 장문 보고서가 아니라 Resume Capsule 갱신으로 단순화
- 새 에이전트가 한두 번의 조회로 이어서 작업할 수 있는 MCP/API 읽기 경로 정리

### Priority B: Minimal Flow

- Investigation을 범용 화이트보드가 아니라 의미 있는 checkpoint 흐름으로 다듬기
- 현재 위치와 다음 단계가 시각적으로 명확할 것
- 모든 tool call·재시도·내부 추론을 기록하지 않을 것

### Priority C: Contextual Code

- Search / Focus
- Task·Flow ↔ Code 양방향 이동
- 필요한 source evidence drill-down
- 범용 code browser, 자체 snapshot/diff, 과도한 impact-analysis는 우선순위에서 제외

### Priority D: Cross-agent resume E2E

- 한 에이전트가 중간에 멈춘 작업을 다른 세션/에이전트가 QuestBoard만 읽고 재개
- 재개에 필요한 조회 수와 토큰 비용을 실제 측정
- 사람이 같은 화면을 보고 현재 목표·현재 위치·다음 액션을 오해 없이 파악하는지 검증

### 명시적 보류

- Wiki / Knowledge Base
- 일정·sprint·resource 관리
- bug tracker 기능
- Git 대체용 Code Map snapshot/diff/version history
- 전체 AI work transcript / 모든 실행 단계 자동 기록
- 범용 IDE급 symbol hierarchy / call graph explorer

### 기존 backlog 정리 기준

현재 등록된 backlog는 아래처럼 해석한다.

- **UI/UX 보완 2차**: 1/4~4/4 결과를 현재 baseline으로 삼고 부모 작업은 최종 audit 후 닫는다.
- **Code Map+ 1/6 Search / Filter / Focus**: 유지. 다만 현재 Task/Flow와 관련된 코드에 빠르게 도달하는 범위로 제한한다.
- **Code Map+ 2/6 Node drill-down / symbol-file hierarchy**: 축소. 전체 hierarchy browser가 아니라 관련 file/symbol anchor 몇 개를 보여주는 수준으로 흡수한다.
- **Code Map+ 3/6 Source evidence explorer**: 유지. relation을 신뢰할 최소 근거만 drill-down으로 제공한다.
- **Code Map+ 4/6 Investigation / Task 양방향 navigation**: 유지. Quest / Flow / Code 사이의 복귀 비용을 줄이는 핵심 기능으로 본다.
- **Code Map+ 5/6 Durable snapshot + Diff**: 중단/보류. Git과 역할이 겹치므로 QuestBoard가 별도 source of truth를 만들지 않는다.
- **Code Map+ 6/6 Changed-files impact**: 축소. 독자 impact engine은 만들지 않고, 필요하면 Git changed-file anchor와 현재 architecture focus를 연결하는 정도만 검토한다. 최종 E2E는 Cross-agent resume E2E로 재정의한다.
- **작업 경로 / 진행 과정 시각화**: 축소. 모든 행동 기록이 아니라 Flow checkpoint와 현재 focus를 사람에게 보여주는 기능으로 재정의한다.
- **Wiki / Knowledge Base**: 보류. 장문 지식과 상세 문서는 외부 문서 도구를 source of truth로 사용한다.

backlog 이름이 남아 있더라도 위 해석과 충돌하는 세부 요구사항은 그대로 구현하지 않는다. 실제 Task 설명은 구현에 들어가기 전에 이 제품 기준에 맞춰 갱신한다.

---

## 21. 제품 정체성

QuestBoard를 한 문장으로 정의하면:

> **사람과 AI가 같은 작업 목표와 현재 위치를 공유하고, 컨텍스트가 끊겨도 최소 비용으로 다시 이어서 일하게 해 주는 로컬 작업 연속성 보드.**

기능을 추가할 때는 항상 "이 기능이 없으면 작업 재개가 실제로 어려운가?"를 먼저 묻는다. 답이 아니면 QuestBoard core에 넣지 않거나 외부 도구 링크로 해결한다.

---

## 22. AI 작업 재개 원칙

새 세션이나 다른 에이전트가 작업을 이어받을 때 권장 흐름은 다음과 같다.

1. Project와 active Task를 찾는다.
2. Task의 Resume Capsule을 읽는다.
3. 필요한 경우에만 연결된 Flow checkpoint와 Code anchor를 읽는다.
4. 바로 다음 액션을 수행한다.
5. 의미 있는 상태 변화가 생겼을 때만 Resume Capsule / checkpoint / Evidence를 갱신한다.

목표는 "QuestBoard를 많이 읽고 많이 쓰는 것"이 아니다. **가장 적게 읽고 써도 정확히 이어갈 수 있는 것**이다.

따라서 handoff 품질을 다음 지표로 본다.

- 새 세션이 작업 목표를 이해하기까지 필요한 조회 수
- 실제 다음 액션에 도달하기까지 필요한 토큰 수
- 사용자가 추가 설명을 반복해야 하는 횟수
- 오래된/중복 상태 때문에 잘못된 방향으로 진입하는 빈도

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
- 핵심 목적은 **AI-human work continuity / cheap resume**
- UI는 **minimal outside, dense inside** 원칙을 따름
- Quest / Flow / Code 세 관점으로 현재 작업을 설명하되 기존 구현 명칭은 점진적으로 정리
- Flow에는 의미 있는 checkpoint만 남기고 AI 내부 추론 전문은 저장하지 않음
- Code Map은 작업 컨텍스트 탐색 보조이며 Git/IDE를 대체하지 않음
- Wiki, 일정 관리, bug tracker, 소스 버전 관리는 외부 전문 도구 영역으로 유지
- 외부 도구의 데이터를 QuestBoard에 중복 복제하지 않고 필요 시 링크/참조만 연결

## 24. 아직 결정하지 않은 사항

실제 구현 시 선택할 항목:
- graph UI library
- Task id 형식
- Claim TTL 기본값
- remote authentication 방식
- public deployment 여부
