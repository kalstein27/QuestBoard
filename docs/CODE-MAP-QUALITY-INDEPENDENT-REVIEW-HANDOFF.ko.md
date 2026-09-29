# Code Map 품질 개선 Independent Review Handoff

- Date: 2026-09-29
- Purpose: 구현 worker와 분리된 새 채팅/리뷰어가 Code Map 품질 개선과 ChatGPT2Codex fresh dogfood를 독립 검증한다.
- Worker must not self-accept this review.

## Review targets

1. `docs/CODE-MAP-QUALITY-IMPROVEMENT-RESULT.ko.md`
2. `docs/CHATGPT2CODEX-CODE-MAP-FRESH-QUALITY-AUDIT.ko.md`
3. current source/diff in:
   - `src/adapters/code-intelligence/scip-provider.ts`
   - `src/application/code-map-query.ts`
   - `tests/code-map-query.test.ts`
   - `tests/code-map-sync-actual-scip-e2e.test.ts`
   - `tests/scip-provider.test.ts`

Live Tasks:
- Code Map 품질 개선: `0b740348-0a96-4093-a17a-f3afc65ddbcd`
- ChatGPT2Codex fresh quality audit: `5de0ba78-7135-4a3c-88cb-231cca33bc3d`

## Required independent acceptance

### A. JavaScript semantic indexing

Verify that:
- original repository `tsconfig.json` and source checkout are not modified;
- JavaScript overlay is generated only under external Code Map storage;
- overlay covers `.js/.jsx/.mjs/.cjs` inventory safely;
- TypeScript project indexing remains intact;
- actual SCIP index exposes real JavaScript semantic nodes and call relations.

Fresh real-repo evidence to reproduce or independently corroborate:
- ChatGPT2Codex JavaScript discovered: 12
- semantic-indexed: 12/12
- semantic symbols: 291
- representative `runBuildVerification` in `scripts/verify-build.mjs`
- callers: 1
- callees: 9

### B. Query quality

Verify:
- `language=unknown` uses the same normalization as coverage/status;
- exact `node.name` ranks ahead of prefix/substring/canonical-only matches;
- hierarchy children are stable in path/source-line order;
- bounded neighborhood preserves query limits while prioritizing direct navigation relations over broad `depends_on`;
- no relation facts are deleted or fabricated by ordering logic.

Fresh real-repo evidence:
- unknown matchedCount: 166
- representative TS `registerTools` exact-name-first PASS
- representative JS `runBuildVerification` exact-name-first PASS
- useful `calls`/`contains` relations precede broad `depends_on` in bounded neighborhoods.

### C. Existing TypeScript quality regression

Verify TypeScript semantic navigation remains healthy.
Fresh worker measurement:
- 315 TypeScript files discovered
- 137 semantic-indexed files
- 19,942 TypeScript semantic symbols
- fidelity `semantic-call`
- gap `partial_coverage`

### D. Raw graph / fixture integrity

Fresh worker measurement:
- 540 file nodes
- 20,233 symbol nodes
- 20,773 raw nodes
- 48,458 relations

ChatGPT2Codex fixture before/after must remain identical:
- branch `docs/windows-install-refresh`
- HEAD `24d93bca3f3a8c5041473f683d0f82ef331eb3f4`
- staged 0
- pre-existing dirty exactly:
  - `src/runtime/output-policy.ts`
  - `src/server/chatgpt-consent-widget.ts`
- diff summary unchanged `+22/-18`

Use temp-only QuestBoard DB/index storage. Do not mutate the ChatGPT2Codex checkout.

### E. Verification gates

Freshly run the closest relevant regressions and full verification. Worker evidence was:
- actual SCIP + headless E2E 4/4 PASS
- targeted query/provider 9/9 PASS
- full `npm run verify` 177/177 PASS
- skip 0
- race gate PASS
- `git diff --check` PASS

Do not accept merely because worker reported these numbers. Re-run enough fresh evidence to independently establish correctness.

## Review outcome rules

### PASS

If all acceptance items pass:
- move both Tasks to `done`;
- write `docs/CODE-MAP-QUALITY-INDEPENDENT-REVIEW-RESULT.ko.md`;
- also create `/mnt/data/QuestBoard_CodeMap_Quality_Independent_Review_Result.md` for chat delivery;
- explicitly note that commit/push/Managed MCP update are separate publication actions and were not performed by the review unless the user separately asks.

### FAIL

If any correctness blocker is found:
- keep affected Task(s) in `review`;
- record exact source/test/evidence blocker and minimal required fix;
- do not start a broad redesign;
- do not commit/push/deploy/update Managed MCP.

## Guardrails

- preserve the current dirty QuestBoard working tree;
- no reset / checkout / clean / revert / unrelated deletion;
- ChatGPT2Codex is read-only acceptance fixture;
- no commit / push / deploy / runtime apply / provider install / Managed MCP update during independent review;
- Raw CodeGraphSnapshot remains canonical; do not invent facts to make acceptance pass.
