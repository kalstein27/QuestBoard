# QuestBoard 제품 방향 인수인계

작성일: 2026-09-26

## Resume Capsule

**Goal**

QuestBoard를 개인 작업자가 AI와 함께 요구사항을 구현·개선할 때 쓰는 **작업 연속성(work continuity) 협업 도구**로 정리한다. 사람과 AI가 같은 목표와 현재 위치를 공유하고, AI의 세션·컨텍스트·메모리가 끊겨도 최소 토큰과 최소 액션으로 같은 작업 흐름에 복귀할 수 있어야 한다.

**Now**

- Task/Claim/Activity/Artifact/Relation, Investigation, Code Map, HTTP/CLI/MCP/Web 기반은 이미 구현되어 있다.
- Code Map은 managed MCP 설치만으로 SCIP TypeScript 인덱싱이 가능하도록 self-contained 상태까지 검증되었다.
- Code Map → Investigation Sync와 UI/UX 2차 1/4~4/4는 구현·회귀검증이 완료된 상태다.
- 제품 방향 문서와 Agent onboarding은 이미 continuity-first 방향으로 재정렬되어 있다.
- 현재 작업 트리에는 기존 다른 세션의 문서 변경이 있으므로 이 인수인계 작성에서는 해당 파일을 덮어쓰지 않았다.

**Next**

기능을 더 붙이기 전에 기존 backlog와 UI를 아래 원칙으로 감사한다.

1. Resume Capsule을 제품의 중심 단위로 만들기
2. AI가 한두 번의 호출로 Resume / Checkpoint 할 수 있는 고수준 API 설계
3. Investigation을 Minimal Flow로 축소
4. Code Map을 Contextual Code surface로 축소
5. 실제 세션 전환을 이용한 Cross-agent resume E2E 검증

**Guardrail**

QuestBoard가 Git, Jira/Linear, Confluence/Wiki, Mantis/bug tracker, IDE/code browser를 다시 만들지 않는다. 기능이 이미 구현되어 있다는 이유만으로 계속 확장하지 않는다.

---

## 1. 제품의 한 문장 정의

**QuestBoard는 사람과 AI가 같은 작업 목표와 현재 위치를 공유하고, AI의 세션·컨텍스트·메모리가 끊겨도 최소 토큰과 최소 액션으로 같은 작업 흐름에 복귀하게 해 주는 로컬 작업 연속성 보드다.**

이 제품의 목적은 프로젝트 관리 기능을 많이 제공하는 것이 아니다.

핵심은 다음 두 가지다.

- 사람이 AI의 작업 흐름을 쉽게 따라간다.
- AI가 컨텍스트를 잃어도 작업을 싸고 정확하게 복구한다.

---

## 2. 대상 사용자와 사용 상황

우선 대상은 **개인 작업자 + AI**다.

예:

- 사용자가 요구사항을 설명한다.
- AI가 코드를 분석하고 구현한다.
- 테스트하고 실제 환경에서 확인한다.
- 중간에 새 채팅으로 넘어가거나 컨텍스트가 압축된다.
- 다른 AI/에이전트가 이어받을 수 있다.
- 사람은 현재 어디까지 왔고 무엇이 남았는지 빠르게 보고 싶다.

QuestBoard는 이 흐름의 연속성을 유지한다.

팀 단위 일정, 조직 리소스, sprint 관리, 정식 bug triage가 주목적이 아니다.

---

## 3. 핵심 제품 질문은 세 개뿐

### Quest: 무엇을 하는가

현재 Goal과 Task를 보여준다.

사람이 첫 화면에서 이해해야 하는 것은 복잡한 metadata가 아니라:

- 목표
- 현재 상태
- 다음 액션

이다.

### Flow: 어디까지 왔는가

현재 Investigation 기능을 이 역할로 재해석한다.

Flow는 AI의 모든 행동을 기록하는 transcript가 아니다.

남기는 것은:

- 작업 시작점
- 의미 있는 checkpoint
- 방향 전환
- blocker와 해소
- 검증 결과
- 다음 단계로 넘어간 이유
- 완료 지점

정도다.

### Code: 어디를 보고 있는가

현재 Code Map을 이 역할로 제한한다.

목적은 범용 코드 탐색기가 아니라:

- 이 Task와 관련된 architecture 영역이 어디인지
- 다시 봐야 할 파일/symbol이 무엇인지
- relation을 믿을 최소 source evidence가 무엇인지
- Task/Flow와 Code 사이를 빠르게 왕복할 수 있는지

를 해결하는 것이다.

---

## 4. 핵심 데이터 단위: Resume Capsule

QuestBoard의 가장 중요한 산출물은 긴 작업 일지가 아니다.

다른 AI가 읽고 바로 다음 행동을 할 수 있는 작은 **Resume Capsule**이다.

개념 필드:

```text
Goal      지금 해결하려는 것
Now       현재 도달한 상태 / 마지막으로 확인된 사실
Next      바로 다음 액션
Blocked   막힌 조건이 있을 때만
Guardrail 다시 하면 안 되는 것 / 반드시 보존할 제약이 있을 때만
Code      관련 코드 위치가 필요할 때만
Evidence  판단에 필요한 테스트·로그·스크린샷·operation 등 최소 근거
```

모든 필드를 매번 채우면 안 된다.

목표는 데이터 충실도가 아니라 **올바른 작업 재개에 필요한 최소량**이다.

### AI 측 성공 조건

새 세션이 QuestBoard를 읽고:

1. 목표를 이해하고
2. 현재 검증된 상태를 알고
3. 다음 행동을 선택하고
4. 필요한 코드만 추가로 읽고
5. 바로 작업을 시작

할 수 있어야 한다.

전체 Activity, 전체 Investigation Graph, 전체 Code Map을 기본적으로 읽게 만들면 실패다.

---

## 5. 사람이 보는 UI 원칙

표면은 최대한 조용하게 유지한다.

- 한 화면에 하나의 주된 질문
- 한 화면에 하나의 주된 액션
- Goal / Now / Next 최우선
- Blocked / Guardrail은 있을 때만 표시
- raw ID, revision, provider, provenance는 기본 화면에서 숨김
- Claim, priority, tag도 항상 보이지 않음
- detail/evidence는 drill-down
- 한두 번의 클릭으로 주요 조작 완료
- 정보가 많아져 복잡해지면 화면을 늘리기보다 먼저 정보를 줄임

내부 모델과 관계는 촘촘할 수 있지만 사용자에게 그 복잡성을 그대로 노출하지 않는다.

---

## 6. QuestBoard가 하지 않을 일

전문 도구와 역할을 분리한다.

### Git / GitHub 영역

QuestBoard에서 하지 않는다.

- 코드 백업
- branch 관리
- source version history
- 자체 diff history
- merge/release 관리

필요하면 commit/file/path anchor만 연결한다.

### Jira / Linear 영역

QuestBoard에서 하지 않는다.

- 일정 관리
- sprint
- 조직 backlog
- resource allocation
- 복잡한 담당자 workflow

### Confluence / Wiki 영역

QuestBoard에서 하지 않는다.

- 장문 지식 베이스
- 상세 설계 문서 허브
- 조직 문서 저장소

긴 문서는 외부 문서를 링크한다.

### Mantis / bug tracker 영역

QuestBoard에서 하지 않는다.

- 정식 오류 접수
- bug triage
- severity/workflow 관리
- bug lifecycle 시스템

### IDE / Code Browser 영역

QuestBoard에서 하지 않는다.

- IDE급 전체 symbol hierarchy
- 전체 call graph browser
- source editor
- 대규모 자체 impact-analysis engine

---

## 7. 기존 구현의 재해석

### 유지할 것

- Project / Task
- 최소 Activity / meaningful checkpoint
- Artifact / Evidence reference
- Resume Capsule
- Resume / Checkpoint 고수준 API
- Minimal Flow
- Code Search / Focus
- 관련 file/symbol anchor
- 최소 source evidence
- Quest / Flow / Code 양방향 navigation
- vendor-neutral HTTP/MCP/CLI boundary
- cross-agent resume 검증

### 축소할 것

#### Investigation

현재 자유도가 높은 Investigation Graph를 **Minimal Flow**로 다듬는다.

- 모든 사고/도구 행동을 Node로 만들지 않는다.
- 의미 있는 checkpoint만 표현한다.
- Node/Item/edge 수가 많아지는 것은 성공이 아니다.
- 현재 위치와 다음 이동이 잘 보이는 것이 성공이다.

#### Code Map

- 기본 6-node macro architecture 같은 단순한 overview는 유용하다.
- Node drill-down은 전체 hierarchy가 아니라 현재 작업과 관련된 file/symbol anchor 중심으로 제한한다.
- source evidence는 relation 신뢰에 필요한 만큼만 노출한다.
- changed-file impact는 독자 engine으로 키우지 않고 변경 파일 → 관련 architecture focus 정도로 제한한다.

#### 작업 경로 시각화

기존 `작업 경로 / 진행 과정 시각화 구현` backlog는 모든 행동을 기록하는 기능이 아니라 **checkpoint navigation**으로 축소해야 한다.

### 보류 또는 중단할 것

- Wiki / Knowledge Base
- Code Map durable snapshot + 자체 Diff history
- 전체 AI work transcript
- 모든 tool execution history 시각화
- IDE급 symbol hierarchy / call graph
- 대규모 자체 impact engine
- 일정 / sprint / resource 관리
- 정식 bug tracker 기능

---

## 8. 기존 Code Map+ backlog 재정렬

기존 계획을 그대로 1/6~6/6 구현하지 않는다.

### 유지 가치 높음

- Search / Filter / Focus
- Task 또는 Flow와 관련된 코드 focus
- 최소 source evidence
- Quest / Flow / Code 양방향 navigation

### 축소

- Node drill-down + hierarchy
  - 전체 hierarchy browser로 만들지 않는다.
  - 관련 file / class / method / symbol anchor만 보여준다.

- Changed-files impact
  - 자체 impact engine을 키우지 않는다.
  - Git의 changed file 정보나 사용자 입력을 architecture focus와 연결하는 수준으로 제한한다.

### 중단 후보

- Durable snapshot + Diff

Git과 중복되며 현재 제품 핵심 목표인 resume cost 감소에 비해 범위가 크다.

---

## 9. 다음 구현 우선순위

### 1. Resume Capsule 중심화

Task가 단순 title/description/status 카드에 머물지 않고 다음 정보를 최소 UI로 제공해야 한다.

- Goal
- Now
- Next
- Blocked optional
- Guardrail optional
- Code/Evidence pointer optional

기존 schema를 최대한 재사용하고, 불필요한 필드 추가는 피한다.

### 2. 고수준 Resume API

새 AI가 정상적인 재개를 위해 여러 CRUD를 조합하지 않게 한다.

예시 개념:

```text
resume(project/task)
→ Goal + Now + Next + optional pointers
```

기본 응답은 작아야 한다.

필요한 경우에만 추가 drill-down pointer를 따른다.

### 3. 고수준 Checkpoint API

의미 있는 상태 변화가 있을 때 한 번의 호출로:

- Resume Capsule 갱신
- checkpoint 추가
- 최소 Evidence 연결

이 가능해야 한다.

사소한 tool call마다 기록하지 않는다.

### 4. Minimal Flow

Investigation UI와 모델을 현재 작업 위치를 읽는 지도에 맞게 단순화한다.

### 5. Contextual Code

먼저 필요한 것만 구현한다.

- Search / Focus
- 관련 file/symbol
- 최소 evidence
- Task/Flow ↔ Code 이동

### 6. Cross-agent resume E2E

제품의 진짜 수용 기준이다.

실제 시나리오:

1. Agent A가 구현 중 의미 있는 checkpoint를 남긴다.
2. A의 chat/session context를 사용하지 않는다.
3. Agent B가 QuestBoard의 작은 Resume 응답만 읽는다.
4. 필요한 최소 Code/Evidence pointer만 추가 조회한다.
5. 사용자 재설명 없이 올바른 다음 작업을 수행한다.
6. 잘못된 옛 상태를 따라가지 않는다.

측정할 것:

- 재개까지 API/tool 호출 수
- 읽은 token 양
- 사용자 재설명 횟수
- 실제 Next Action 도달까지 걸린 단계 수

---

## 10. 기능 판단 규칙

새 기능을 제안할 때 마지막에 반드시 이 질문을 한다.

> 이 기능이 없으면 사람이나 AI가 작업 목표, 현재 위치, 다음 액션을 잃거나 다시 찾는 데 실제 비용이 커지는가?

**아니라면 QuestBoard core에 넣지 않는다.**

두 번째 질문:

> 이미 Git/Jira/Confluence/Mantis/IDE가 더 잘하는 일인가?

**그렇다면 복제하지 말고 link/anchor만 둔다.**

세 번째 질문:

> 기능을 추가했을 때 사람의 기본 화면과 조작이 더 복잡해지는가?

그렇다면 먼저 기능 범위를 줄이거나 drill-down으로 숨긴다.

---

## 11. 현재 repository 작업 시 주의

이 인수인계 작성 시점 기준:

- branch: `main`
- baseline HEAD: `a42dc5b62dbf0f67513d3a74ba05d3a8e74b20af`
- upstream: `origin/main`
- 기존 working tree에 이미 다른 문서 변경이 존재한다.
- 기존 dirty 파일을 reset / checkout / clean / revert / overwrite 하지 말 것.
- commit / push는 사용자의 명시적 요청이 있을 때만 수행한다.

특히 현재 dirty 상태에 포함된 문서:

- `AGENTS.md`
- `README.md`
- `docs/AGENT-ONBOARDING.md`
- `docs/QUESTBOARD-PROJECT-PLAN.ko.md`
- `docs/PRODUCT-DIRECTION.ko.md`

이 문서들은 이미 본 인수인계의 방향과 상당 부분 정렬되어 있다. 다음 세션은 이 문서를 최신 제품 의도 요약으로 사용하되, 실제 working tree와 기존 제품 방향 문서를 함께 확인해야 한다.

---

## 12. 다음 세션 시작 체크리스트

1. `AGENTS.md` 읽기
2. `docs/PRODUCT-DIRECTION.ko.md` 읽기
3. 이 인수인계 문서 읽기
4. repository dirty 상태 확인
5. QuestBoard의 현재 Task 목록에서 기존 계획과 새 방향이 충돌하는 항목 식별
6. `유지 / 축소 / 보류 / 제거`로 backlog 재정렬
7. Resume Capsule + Resume/Checkpoint API부터 상세 설계
8. 구현 전에 "이 기능이 resume cost를 실제로 줄이는가" 재확인

최종 목표는 QuestBoard에 많은 정보를 저장하는 것이 아니다.

**사람과 AI가 아주 조금만 읽고 써도, 같은 목표와 작업 흐름으로 정확하게 돌아오는 것**이 최종 제품 기준이다.
