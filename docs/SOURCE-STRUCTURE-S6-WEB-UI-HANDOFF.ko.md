# QuestBoard Source Structure → Flow S6/8 UI 인계

날짜: 2026-10-21 (KST)
상태: **S6 UI 구현과 격리 회귀 완료**, 운영 설치·배포·인증된 Apply 미진행.

## 변경한 파일

- `web/index.html`: 기존 `Sync to Flow`와 구별되는 `Source → Flow` 버튼 및 별도 Source Structure chooser 다이얼로그 추가. 프로젝트 상대 경로 필터, 선택 체크박스 영역, 이전/다음 페이지, Preview 버튼, 결과 영역과 잠긴 Apply 버튼을 포함.
- `web/app.js`: 서버 `GET /projects/:projectId/source-structure/flow-sync/candidates`, `POST .../preview`만 호출. 12개 단위 페이지/선택, pinned snapshotId/indexedAt, exact offset/limit/pathPrefix, 비동기 응답 순서 번호를 재검증하여 이전 요청 결과 폐기. 프로젝트 변경·Code Map 조회·재색인·페이지/필터 변경 시 선택과 미리보기 초기화. 선택된 디렉터리만 Preview 요청; source graph/page 자체는 전송하지 않음. 결과는 create/unchanged/evidence_changed/stale/detached/blocked, 관계 raw evidence 개수/ID·truncation, 고립 노드, 이유·omitted relation을 표기. 관계가 없어도 임의 선은 생성하지 않음.
- `web/styles.css`: 기존 다크 테마·반응형 구성에 맞춘 목록, 포커스, 페이지, 경고 및 권한 잠금 스타일.
- `tests/source-structure-sync-s6-web-contract.test.ts`: 새 대화상자 독립성, unauthenticated Apply 차단, 핀/선택 lifecycle 무효화, evidence and no-invented-edge 진단 4개.

## 안전 경계

기존 6-role `code-map/investigation-sync` API·창·Flow·사용자 수정 데이터는 보존. S6에는 **Apply 핸들러가 아예 없다.** `source-structure-apply` 버튼은 `disabled aria-disabled=true`, JS render에서 늘 `disabled=true`. 서버 측 인증 `authorizeSourceStructureApply`도 여전히 운영에 미구성이다. 배우 ID/daemon-client header/UI confirmation으로 권한을 가정하지 말고, 서버 신원·프로젝트 권한을 별도 승인·검증하기 전에는 잠금 해제 금지. S7/8 이후에 한해 명시적 사용자 승인 뒤 안전하게 진행.

## 검증 증거

- `npm:test`: operation `bg_72580a74-f97a-4773-bece-420d366c536d`, **322 PASS / 0 FAIL**, 기존 318개 + S6 새 4개.
- `npm:check:web`: operation `bg_5f3ceb36-9e96-4f90-bc37-971509e59763`, exit 0.
- `npm:test:race`: operation `bg_5e819440-0ae4-42bd-8aaf-f92d1f5f5597`, exit 0.
- Git HEAD `9bb87ecb19194b689f16c5d8721d1003bec8eecd` 불변. 기존 dirty 26개 보존, 현재 30개(신규 UI/테스트 4개). staged 0. 운영 SQLite/SCIP snapshot/Flow/서비스 재시작·build/apply/deploy·commit/push 없음.
- Web 정적/계약 테스트와 합성 서비스 테스트 성공; 실제 브라우저 육안 E2E, 운영 데이터 PHP acceptance 및 실운영 UI 노출은 아직 미실시.

## 다음 인계 (S7/8)

S6 UI의 실제 렌더링/접근성/비동기 경합을 허용된 격리 브라우저·합성 Code Map 서버에서 E2E로 검증할 것. 만약 기능상 raw anchors / selectedRelationIds가 필요한 추가 선택 UX가 있다면 12/24 caps 내에서 별도 검토. **Apply 잠금은 서버 인증 없이는 해제하지 말 것.** 툴 catalog refresh/daemon restart/deploy/운영 DB 검증과 외부 private PHP/SCIP 원문 요청은 사용자 별도 명시 승인 없이 금지.

S6 QuestBoard Task/Activity 원격 쓰기는 도구 응답이 `NOT_IMPLEMENTED`로 실패한 경우 저장하지 못했음을 별도 보고해야 한다.
