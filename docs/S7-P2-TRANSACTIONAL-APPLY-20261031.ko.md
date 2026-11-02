# QuestBoard S7 · P2 Flow Apply / CodeScope mutation 트랜잭션 격리 (2026-10-31)

## 판정

**일반 HTTP·agent/MCP 경로의 P2 Source Structure Apply, Code Map→Investigation Apply, CodeScope attach/create Task/relink: PASS.**
**S7 전체 운영 배포: 보류.** 실제 브라우저 UI E2E와 사용자 명시 취소/HTTP 연결 종료 전파는 남아 있다. 운영 SQLite/Flow는 변경하지 않았다.

이전 P2 reads + scale baseline: `docs/S7-P2-WEB-FLOW-ISOLATED-READ-20261030.ko.md`, `docs/S7-P2-SCALE-STABILITY-20261031.ko.md`.

## 핵심 구현

- `src/application/code-map-persistence.ts` 및 `src/adapters/code-intelligence/code-map-persistence.ts`: persisted snapshot에 대한 메모리 상수 크기의 **파일 리비전 토큰**을 제공한다. 기존 snapshot 저장은 신규 임시 파일 fsync 후 원자적 rename을 사용하므로, 파일 dev/inode/size/mtimeNs/ctimeNs 중 변경이 생기면 토큰이 달라진다. 토큰은 Graph 해시가 아니라 **교체 감지용 경계**다.
- `src/application/code-map-service.ts`: 읽기 전 토큰을 확보하고 별도 P2 자식에서 신뢰된 원본 그래프의 pinned 데이터를 가져온 뒤 부모에서 변경 여부를 재검증한다. `snapshotRevisionToken`, `assertSnapshotRevision`, `sourceStructureApplySourceAsync`, `pinnedNodeForMutation`, `pinnedRelinkForMutation` 사용. 원본 전체 그래프는 부모로 전달되지 않는다.
- `src/server/code-map-read-child.ts`: `source_structure_apply`가 **동일한 자식에서 동일한 스냅샷**으로 검증된 subsystem page와 선택 SourceStructureSyncGraph를 함께 생성한다. `code_scope_relink`는 전체 native 그래프 안에서 canonical identity/path+signature 유일성을 판별한다. 모두 기존 1MiB IPC cap, timeout, process group kill 경계 안에 있다.
- `src/application/source-structure-flow-sync.ts`: 기존 명시 승인 + actor + idempotency requestId + selection fingerprint/snapshotId/indexedAt + SQLite binding revision/Flow CAS는 그대로 유지한다. P2에서는 작은 신뢰된 그래프를 사용하고, **동일 트랜잭션 안에서 쓰기 전과 쓰기 후** snapshot revision을 검증한다. 변경되면 예외로 전체 롤백한다.
- `src/application/code-map-investigation-sync.ts`: 호환 Investigation Apply에도 같은 pinned projection + 파일 revision CAS를 사용한다. detached/stale/manual Flow 방어, preview fingerprint, request receipt 유지.
- `src/application/code-scope-binding.ts`: Attach, Create Task, Relink에서 P2 native exact-node 또는 유일한 relink 후보만 사용한다. SQLite 내부 추가/변경 전후 token 검사, binding revision CAS, collision 확인 유지. **이미 active인 relink도 explicit expectedRevision이 오래되면 충돌**하도록 보강했다.
- `src/adapters/agent-tools.ts`, `src/server/http-api.ts`: 격리 모드에서 async preflight→synchronous SQLite mutation으로 라우팅. Source Structure Apply는 **인증된 transport authority가 없는 한 403으로 거부**한다. 기본 미인가 동작 유지. 비격리 직접 호출 및 이전 테스트 계약 유지.
- CodeScope agent/MCP read-only binding 목록도 P2에서는 full graph를 부모로 읽지 않고 `unverified/not_checked` 상태로 제공한다.

## 핵심 검증과 결과

새 `tests/code-map-isolated-apply.test.ts` 10건 실제 **별도 Node P2 read child + 격리 SQLite/스냅샷** 시험:

1. 허가된 Source Structure 정상 적용과 동일 requestId replay, 무인가 Apply 차단.
2. 자식 read 직후 원자적 스냅샷 교체를 감지해 쓰기 거부.
3. SQLite Flow 쓰기 직후·커밋 직전 스냅샷 교체를 감지해 **Node/Item/Link/Binding 전체 롤백**.
4. Investigation HTTP/agent Preview→Apply 원본 투영 fingerprint 일치, 오래된 snapshot 거부.
5. CodeScope attach/create Task exact native 노드 검사 및 source 교체 시 Task/Binding 롤백, HTTP 경로 일치.
6. Relink는 유일한 동일 canonical identity에만 재연결, 모호한 후보는 거부, stale `expectedRevision` 거부.

검증 fixture는 원본 `getCached`/synchronous Source Structure source read를 강제로 예외 처리해 **P2 Apply 경로의 부모 그래프 hydration이 없음을 검증**했다.

- `npm run verify` **349/349 tests PASS**, TypeScript typecheck, Web syntax, Node race test PASS.
- **`git diff --check` PASS**, HEAD `9bb87ecb19194b689f16c5d8721d1003bec8eecd` 유지. 기존 사용자 dirty 파일을 보존했으며 이번 변경 포함 총 dirty=69. Commit/push 없음.
- Git commit/push, 운영 서비스 재시작, 실제 사용자 Flow/SQLite 변경 없음.

## 아직 남은 것

- 브라우저 Code Map 트리 탐색/심볼 Inspector/Source Structure·Code→Flow Preview/Apply 대화상자의 실제 사용자 E2E.
- 사용자 명시 취소·HTTP 연결 종료 시 in-flight P2 child 취소 전파. 현재는 timeout 및 프로세스 소유자 종료 정리를 검증했고, 요청별 취소는 미완료.
- 파일 토큰의 적용 선형화 시점은 **SQLite commit 직전 마지막 검증**이다. 외부 파일 시스템 자체의 범용 다중-daemon write lock을 도입한 것은 아니다. 다중 독립 writer를 전제로 하는 배포라면 별도 직렬화 계약이 필요하다. 일반 기존 단일-daemon 운영과 격리 스냅샷 교체 모델은 현 구현을 사용한다.

이번 변경 완료 기준은 **기존 승인/CAS를 유지하면서 P2 주요 쓰기 경로에서 부모 전체 그래프 hydration 제거 및 rollback 증명**이다. 이 기준은 충족했다. S7 전체 GO는 아직 선언하지 않는다.
