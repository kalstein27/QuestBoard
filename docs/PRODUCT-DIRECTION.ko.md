# QuestBoard Product Direction

상태: 제품 방향 기준 문서

## 한 문장 정의

**QuestBoard는 사람과 AI가 같은 작업 목표와 현재 위치를 공유하고, AI의 세션·컨텍스트·메모리가 끊겨도 최소 토큰과 최소 액션으로 같은 작업 흐름에 복귀하게 해 주는 로컬 작업 연속성 보드다.**

QuestBoard의 목표는 프로젝트 관리를 더 많이 하는 것이 아니다. **작업을 잃지 않고 다시 이어가는 비용을 줄이는 것**이다.

## 1. 대상 사용자

개인 작업자가 AI를 활용해 요구사항을 구현하고 개선하는 상황을 우선한다.

사람은 빠르게 다음을 알 수 있어야 한다.

- 지금 무엇을 만들고 있는가
- 어디까지 왔는가
- 무엇이 확인됐는가
- 다음에 무엇을 해야 하는가
- 막힌 것이 있는가

AI는 새 채팅이나 새 세션에서도 긴 대화 기록을 재독하지 않고, 위 상태와 필요한 최소 근거만 읽어서 바로 작업을 이어갈 수 있어야 한다.

## 2. 핵심 원칙

### Continuity first

세션, 모델, 에이전트, 컨텍스트가 바뀌어도 작업 흐름은 이어져야 한다.

### Minimal outside, dense inside

사람에게 보이는 화면과 조작은 얇게 유지한다. 내부에는 재개에 필요한 연결과 근거를 촘촘하게 보존한다.

### Resume cost over feature count

기능 수보다 작업 재개까지 필요한 조회 수, 토큰 수, 사용자 재설명 횟수를 줄이는 것이 더 중요하다.

### Specialist tools stay specialist

QuestBoard가 이미 잘 존재하는 전문 도구를 다시 만들지 않는다.

- Git / GitHub: 코드 버전, diff, branch, backup, release
- Jira / Linear: 일정, sprint, 조직 backlog, resource 관리
- Confluence / Wiki: 장문 문서, 지식 베이스
- Mantis / bug tracker: 정식 오류 관리와 triage
- IDE / code browser: 전체 symbol hierarchy, call graph, 코드 편집

필요하면 이 도구들의 링크와 anchor만 연결한다. 별도의 source of truth를 복제하지 않는다.

## 3. 세 가지 질문

### Quest: 무엇을 하는가

현재 Goal과 Task를 보여준다.

### Flow: 어디까지 왔는가

의미 있는 checkpoint와 현재 위치를 보여준다.

### Code: 어디를 보고 있는가

현재 작업과 관련된 코드 영역, 파일, 핵심 symbol, 근거로 빠르게 이동하게 한다.

이 세 surface는 독립적인 거대한 제품이 아니다. 모두 작업 재개를 돕는 보조 관점이다.

## 4. 핵심 단위: Resume Capsule

QuestBoard의 가장 중요한 산출물은 거대한 작업 일지가 아니라 작은 Resume Capsule이다.

```text
Goal      지금 해결하려는 것
Now       현재 도달한 상태 / 마지막으로 확인된 사실
Next      바로 다음 액션
Blocked   막힌 조건이 있을 때만
Guardrail 다시 하면 안 되는 것 / 반드시 보존할 제약이 있을 때만
Code      관련 코드 위치가 필요할 때만
Evidence  테스트·로그·스크린샷 등 판단에 필요한 최소 근거
```

모든 필드를 항상 채우지 않는다. 다른 AI가 이 Capsule을 읽고 바로 다음 행동을 정확히 할 수 있을 만큼만 남긴다.

## 5. Checkpoint 원칙

남길 가치가 있는 것:

- 작업 시작점
- 방향을 바꾼 결정
- 중요한 확인 결과
- blocker 발생과 해소
- 의미 있는 분기
- 테스트 / 실제 검증 결과
- 다음 단계로 넘어간 이유
- 완료 checkpoint

남기지 않는 것:

- 모든 tool call
- 모든 파일 read
- 모든 재시도
- 내부 chain-of-thought
- 전체 debug log 복제
- 실행 transcript 전체

Flow는 AI의 사고 과정을 재현하는 로그가 아니라 사람과 다음 AI가 현재 위치를 이해하는 지도다.

## 6. Code Map의 역할 제한

우선 가치가 있는 기능:

- 현재 Task / Flow와 관련된 architecture 영역 focus
- 파일명 / 핵심 symbol / relation 검색
- Task / Flow → Code 이동
- Code → 관련 Task / Flow 복귀
- relation을 신뢰할 최소 source evidence

우선 만들지 않는 기능:

- 독자적인 코드 snapshot / version history
- Git 대체 diff 저장
- 전체 symbol hierarchy browser
- 전체 call graph explorer
- 대규모 자체 impact-analysis engine
- 코드 편집기

Code Map은 어디를 다시 봐야 하는지 빠르게 찾는 장치다.

## 7. Investigation의 역할 제한

현재 Investigation은 범용 화이트보드보다 Minimal Flow로 다듬는다.

목표는 현재 위치, 완료된 의미 있는 단계, 다음 단계, 중요한 분기와 blocker가 바로 보이는 것이다.

Node, Item, Relation 수가 많아지는 것은 성공 지표가 아니다. 화면이 복잡해진다면 정보를 더 넣기보다 먼저 줄인다.

## 8. 명시적으로 걷어낼 영역

- Wiki / Knowledge Base
- 일정 / sprint / resource 관리
- 정식 bug tracker 기능
- 코드 backup / version 관리
- Code Map durable snapshot + 자체 diff history
- 모든 AI 작업 단계 자동 기록
- 모든 tool execution history 시각화
- IDE급 symbol hierarchy / call graph
- 범용 프로젝트 관리 기능

기능이 이미 구현되어 있더라도 존재한다는 이유만으로 계속 확장하지 않는다.

## 9. AI용 고수준 인터페이스

저수준 CRUD는 호환성을 위해 유지할 수 있지만 정상적인 작업 재개가 여러 호출을 요구해서는 안 된다.

### Resume

한 번의 조회로 가능한 한 다음을 반환한다.

```text
Goal
Now
Next
Blocked?
Guardrail?
Code pointer?
Flow pointer?
Evidence pointer?
```

전체 Activity, 전체 graph, 전체 Code Map은 기본 응답에 넣지 않는다.

### Checkpoint

의미 있는 상태 변화가 생겼을 때 한 번의 갱신으로 Resume Capsule 최신화, 필요한 checkpoint 추가, 최소 Evidence 연결을 수행할 수 있어야 한다.

handoff는 장문의 보고서 작성이 아니라 정확한 마지막 checkpoint를 남기는 행위에 가깝게 만든다.

## 10. 사람용 UI 원칙

- 한 화면에 하나의 주된 질문과 하나의 주된 액션
- Goal / Now / Next를 가장 먼저 노출
- Blocked / Guardrail은 있을 때만 노출
- raw ID, revision, provider, provenance는 기본 화면에서 숨김
- Claim, priority, tag도 항상 보이지 않음
- 세부 근거는 drill-down
- 기능 추가 때문에 화면이 복잡해지면 기능을 축소
- 조작은 가능한 한 한두 번의 클릭으로 끝냄

표면은 조용해야 한다. 복잡성은 내부 연결이 떠맡는다.

## 11. 현재 backlog 재해석

### 유지

- Resume Capsule / Resume API
- Checkpoint 갱신 흐름
- Minimal Flow
- Code Search / Focus
- Source evidence drill-down
- Quest / Flow / Code 양방향 navigation
- Cross-agent resume E2E

### 축소

- Code Map Node drill-down: 전체 hierarchy가 아니라 관련 file / symbol anchor 중심
- 작업 경로 시각화: 모든 행동이 아니라 의미 있는 checkpoint 중심
- Changed-files impact: 독자 engine이 아니라 changed-file anchor와 architecture focus 연결 수준

### 보류 / 중단

- Code Map durable snapshot + 자체 Diff
- Wiki
- 전체 work transcript
- IDE급 code explorer
- 일정 / sprint / bug tracker 기능

## 12. 다음 구현 우선순위

1. **Resume Capsule 중심화**: Task에서 Goal / Now / Next / Blocked / Guardrail을 최소 UI와 API로 읽고 갱신한다.
2. **고수준 Resume / Checkpoint API**: 새 AI가 여러 CRUD를 조합하지 않고 바로 작업을 재개하게 한다.
3. **Minimal Flow**: Investigation을 checkpoint 중심으로 단순화한다.
4. **Contextual Code**: Search / Focus, 최소 source evidence, Quest·Flow 양방향 이동만 먼저 완성한다.
5. **Cross-agent resume E2E**: 한 세션이 멈춘 실제 작업을 다른 세션 또는 다른 에이전트가 QuestBoard만 읽고 이어서 완료하게 한다.

## 13. 성공 지표

- 새 AI가 목표를 이해하기까지 필요한 조회 수
- 실제 Next Action까지 필요한 토큰 수
- 사용자가 같은 설명을 다시 해야 하는 횟수
- 잘못된 오래된 상태를 따라가는 빈도
- 사람이 현재 Goal / Now / Next를 파악하는 데 걸리는 시간
- checkpoint 하나를 남기는 데 필요한 조작 수

목표는 QuestBoard를 많이 쓰는 것이 아니라 **조금만 읽고 써도 작업이 정확히 이어지는 것**이다.

## 기능 판단용 마지막 질문

> **이 기능이 없으면 사람이나 AI가 작업 목표, 현재 위치, 다음 액션을 잃거나 다시 찾는 데 실제 비용이 커지는가?**

아니라면 QuestBoard core에 넣지 않는다.
