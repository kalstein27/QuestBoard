# Source Structure → Flow S5 API·보안 인계

상태: S5 구현 완료, 운영 적용은 **서버 측 인증 권한 미구성으로 기본 차단**. S6 UI 시작 전 인증을 별도 설계·승인해야 한다. 코드/테스트는 합성 환경에서만 검증되었으며 운영 DB·Flow를 변경하지 않았다.

## 새 API

- HTTP `GET /projects/:projectId/source-structure/flow-sync/candidates`: `offset`, `limit`(1~12), `pathPrefix`, 후속 페이지에는 `expectedSnapshotId`, `expectedSourceIndexedAt`. 서버가 보유한 최신 Code Map으로부터 경로·ID·집계만 반환한다.
- HTTP `POST /projects/:projectId/source-structure/flow-sync/preview`: `selectionKey`, `selectedSubsystemIds`(1~12), 선택적 `selectedRawAnchorIds`, `selectedRelationIds`, `offset`/`limit`/`pathPrefix`, 필수 `expectedSnapshotId`와 `expectedSourceIndexedAt`. preview 응답에 CAS용 `selectionFingerprint`, `expectedSelectionRevision`을 돌려준다.
- HTTP `POST /projects/:projectId/source-structure/flow-sync/apply`: Preview와 **정확히 동일한 선택·핀**과 `expectedSelectionFingerprint`, `expectedSelectionRevision`(신규면 `null`), `approved:true`. `x-questboard-request-id` 헤더와 `x-questboard-actor-id`·`x-questboard-actor-provider` 헤더가 필수지만 이 헤더들은 신원·권한 증명이 아니다. 런타임의 명시적 `authorizeSourceStructureApply(request, projectId, claimedActor)`가 인증된 Actor를 확인하지 못하면 항상 403 `source_structure_apply_unauthorized`.
- MCP/agent 도구: `questboard_list_source_structure_candidates`, `questboard_preview_source_structure_flow_sync`, `questboard_apply_source_structure_flow_sync`. 적용 권한은 호스트 내부의 `sourceStructureApplyAuthority`로만 부여되며 JSON/MCP tool arguments는 권한을 부여할 수 없다.
- CLI: `source-structure-candidates`, `source-structure-preview`, `source-structure-apply`. 선택 ID는 `--subsystems ID[,ID]`, `--anchors`, `--relations`에 입력. 적용에는 `--selection-fingerprint`, `--new-selection` 또는 `--selection-revision N`, `--approved`, `--request-id`가 필수. CLI actor 플래그도 인증이 아니다.

세 채널은 `src/adapters/agent-tools.ts`의 동일 계약과 `src/application/source-structure-channel.ts`의 입력 검증을 공유한다. **전체 Source Graph·subsystemPage·Flow binding은 클라이언트에서 받아들이지 않는다.** 선택된 page는 서버 캐시에서 매번 재생성한다. 최대 12 nodes / 24 relations / 16 evidence samples, 요청 본문 최대 24KiB, bounded pagination, deterministic pin/CAS/idempotency. 모델에 전달하는 결과에는 소스 본문·절대 호스트 경로·PHP 코드·credential·운영 DB 내용이 없다.

## 신뢰 경계와 배포 주의

현재 `src/server/main.ts`는 정상적인 pinned `CodeMapService` snapshot read만 `SourceStructureFlowSyncService`에 주입한다. **적용 허용자(authorizer)는 주입하지 않는다.** HTTP의 `x-questboard-daemon-client:1` 역시 인증이 아니라는 점에 주의. MCP Proxy/CLI에 해당 헤더가 있어도 Apply는 닫힌다. 외부 인증 계층 없이 `authorizeSourceStructureApply` 또는 `sourceStructureApplyAuthority`를 무조건 true로 연결하면 안 된다.

기존 `questboard_preview_code_map_investigation_sync` / `questboard_apply_code_map_investigation_sync`, 저장소의 기존 6-role binding, 수동 Flow는 건드리지 않았다. S4 적용 엔진은 수동 제목·위치·링크 변경과 detached/stale/evidence_changed binding을 자동 복구하지 않는다. 하나의 BEGIN IMMEDIATE 안에서 Flow 생성+S3 receipt를 처리한다.

## 검증 및 S6

`tests/source-structure-sync-s5.test.ts` 9개: HTTP/MCP/CLI 후보와 미리보기 일치, 인증 없는 Apply 거절, 인증 주입을 사용한 3채널 동일 request replay, CAS/동시 적용 충돌, 핀 변경, cross-project, malformed/DoS, CLI 명시 승인, 기존 도구 계약 검증. `npm:test` 전체 318/318 PASS, `npm:typecheck`, `npm:check:web`, `npm:test:race` 별도 PASS. 검증은 메모리 또는 독립 임시 SQLite만 사용한다.

S6는 새 UI에서 read-only 후보·미리보기를 제공할 수 있으나, **기존 로그인/서버가 확인 가능한 mutation 권한이 준비되지 않으면 Apply 버튼을 활성화하지 말 것**. 미리보기에는 `stale`, `detached`, `blocked`, `evidence_changed`를 명확하게 노출한다. 운영 배포·서비스 재시작·도구 카탈로그 refresh, 비공개 PHP 실데이터 검증은 별도 명시 승인 때만 한다.
