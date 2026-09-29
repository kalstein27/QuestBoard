# Phase 3H Independent Review Result

- Date: 2026-09-29 (Asia/Seoul)
- Verdict: **PASS**
- QuestBoard: `main` / `87c34f743fffad39c3c19c7a5bf88b6314aba022`
- ChatGPT2Codex fixture: `docs/windows-install-refresh` / `49d34c44d2e158965062552e40ef1ce9b98c89e0`
- Final Phase 3H: `done`, revision `4`
- Final Phase 3 parent: `done`, revision `14`
- Next canonical Task: `82505848-0988-4be6-ae56-1f1c4e051943` `Code-aware 4/6: Persistent Task ↔ CodeScope binding + scope Goal/TODO UX`, `planned` revision `1`
- Phase 4 implementation: **not started**

## Findings

Severity: **none**.

No blocker, major, or minor acceptance finding remains. The worker handoff left one material question open: whether scenario 6 had proven a semantically genuine provider-missed code-to-code relation rather than only overlay mechanics. This review resolved that question positively with fresh source, type-checker, query, HTTP, browser, reindex, and regression evidence.

## Actual mixed-language measurements

Fresh indexing used the real `<CHATGPT2CODEX_REPO>` fixture with temporary DB/index state outside the fixture repo.

| Metric | Result |
| --- | ---: |
| total files | 540 |
| TypeScript | 315 |
| JavaScript | 12 |
| Swift | 3 |
| Shell | 23 |
| PowerShell | 20 |
| C# | 1 |
| unknown/other | 166 |
| raw nodes | 20,461 |
| raw relations | 47,678 |
| compatibility projection | 1 node / 0 relations |

Coverage/provider snapshot:

- TypeScript: 315 discovered, 137 semantic-indexed, 19,921 symbols, `semantic-call`, providerIds=`[scip-typescript]`, `partial_coverage`.
- JavaScript: 12 discovered, 0 semantic-indexed, file-only, one trusted SCIP install option visible.
- Swift: 3 discovered, file-only, `no_trusted_provider_available`, install options 0.
- Shell: 23 discovered, file-only, `no_trusted_provider_available`, install options 0.
- PowerShell: 20 discovered, file-only, `no_trusted_provider_available`, install options 0.
- The single C# file stays in provider-neutral inventory but is grouped into the generic unknown capability bucket because no C# semantic capability is configured.

## Representative raw identity/query evidence

Representative symbol:

- `registerTools`
- raw node ID `code:node:76dfb2290b950e8304249049`
- kind `function`
- path `src/server/tools.ts`
- canonical identity `scip:type=scip-typescript npm chatgpt-to-codex . . src/server/tools.ts registerTools().`

Fresh verification established exact raw-ID/canonical-identity parity between application query, HTTP, and agent surfaces. Real headless Chrome search opened `registerTools` at `src/server/tools.ts:4024:17`. The actual SCIP browser E2E also exercised raw cross-file relation navigation and Back with exact raw node IDs. Bounded query limits remained enforced; no full graph dump was required.

## Genuine provider-missed relation and Manual wiring

The independent review scanned the actual TypeScript program with the TypeScript compiler AST/type checker and matched declarations back to exact Code Map nodes.

It found a real missing relationship:

- from: `scanWorkspace`, node `code:node:870f454352f733e7f8a8e0f5`, `src/workspace/registry.ts`, function starts line 123
- to: `DomainError`, node `code:node:8c05a9b6cb8c96ce6080c420`, `src/types.ts`, class starts line 219
- source evidence: `src/workspace/registry.ts:134` contains `new DomainError('not_found', 'Workspace is not configured')`
- semantic meaning: `scanWorkspace` **instantiates** local class `DomainError`
- fresh raw graph observation: there was no provider-derived `instantiates` edge between those exact nodes

This is a genuine provider miss, not an invented or mechanics-only relation.

A temporary Manual `instantiates` augmentation was then created between the exact endpoints in isolated review state. Results:

- immediately `active`
- bounded query exposed `DomainError` with Manual provenance/providerId `manual`
- canonical cached raw graph stayed unchanged and did not contain `manual:<id>`
- application/agent and HTTP/agent relation results matched
- real headless-browser inspector showed `scanWorkspace` -> `Instantiates` -> `DomainError` with `Manual` badge
- after a real reindex with the same endpoints, the augmentation remained active/query-visible
- fresh regression verified endpoint removal or exact identity drift becomes `stale` and is never fuzzy-relinked

All temporary acceptance state was removed afterward.

## Acceptance matrix

| Criterion | Result | Evidence |
| --- | --- | --- |
| 1. real mixed-language inventory | PASS | 540 real files measured; target languages retained |
| 2. TS hierarchy/call/reference navigation | PASS | exact `registerTools` raw identity, bounded queries, HTTP/agent parity, actual browser + SCIP E2E |
| 3. Swift/Shell/PowerShell visibility | PASS | 3 / 23 / 20 files remain as file nodes |
| 4. explicit coverage/provider gaps | PASS | partial TS coverage and no-provider gaps explicitly reported |
| 5. install-option/no-provider semantics | PASS | install requests remain declarative/approval-gated; unsupported languages expose no trusted option |
| 6. genuine manual wiring | PASS | source/type-checker-proven `scanWorkspace -> DomainError` provider miss represented as separate Manual `instantiates` overlay |
| 7. reindex persistence + stale safety | PASS | exact endpoints persist active; disappearance/identity drift stale, no fuzzy relink |
| 8. raw graph independent of projection | PASS | raw 20,461 / 47,678 usable while projection is only 1 / 0 |
| 9. Quest/Flow/Task/Resume/Code-to-Flow regressions | PASS | full verify 161/161 + race; actual SCIP/browser E2E PASS |

## Relevant source review

`src/application/code-map-hierarchy.ts` only fills a missing semantic-node language when an exact path exists, using the exact file-node language or conservative extension inference. It does not rewrite IDs, canonical identities, provenance, or relations, and it preserves provider-native containment.

`src/application/code-map-provider-registry.ts` filters only internal `file-inventory` / `questboard:file-*` provenance from semantic `providerIds`; raw graph provenance remains untouched and actual semantic providers such as `scip-typescript` remain visible.

`src/application/code-map-augmentation.ts` persists Manual relations separately from provider facts. Exact node ID plus canonical identity governs active/stale state, and missing or identity-changed endpoints become stale without fuzzy reattachment.

## Fresh verification evidence

- `npm run build`: exit 0
- focused Code Map regression set (`hierarchy`, `provider-registry`, `augmentation`, augmentation Web contract, explorer Web contract, actual SCIP E2E): **19/19 PASS**, 0 fail
- actual ChatGPT2Codex real-repo acceptance: operation `bg_628c34f7-0b00-43b2-849f-0679b79c5ce9`, exit 0
- actual ChatGPT2Codex HTTP + headless-browser parity/manual proof: `bg_94e2e532-368c-46ff-a6e4-8ee558a20636`, exit 0
- `npm run verify`: `bg_85e271e8-79b8-40f4-abf5-9772b9e64c7b`, exit 0
  - typecheck PASS
  - Web syntax PASS
  - Node tests **161/161 PASS**, fail 0, skipped 0
  - multi-worker claim/revision race gate PASS
- `git diff --check`: `bg_326fce07-69ce-48ac-aa9e-2286447a53a1`, exit 0, no output

## Fixture integrity

ChatGPT2Codex before and after all indexing, manual-wiring, HTTP, and browser probes:

- branch `docs/windows-install-refresh`
- HEAD `49d34c44d2e158965062552e40ef1ce9b98c89e0`
- dirty files 0
- staged files 0

Thus the fixture source was not mutated. Generated SCIP/index state stayed in temporary external storage and was removed.

## QuestBoard workspace integrity

Before writing this mandatory result file, QuestBoard remained:

- `main` / `87c34f743fffad39c3c19c7a5bf88b6314aba022`
- upstream `origin/main`, up to date
- staged 0
- pre-existing dirty/untracked entries 30

Exact pre-existing set preserved:

`README.md`, `docs/AGENT-ONBOARDING.md`, `docs/architecture/FOUNDATION.md`, `src/adapters/agent-tools.ts`, `src/adapters/mcp/mcp-server.ts`, `src/application/code-map-hierarchy.ts`, `src/application/code-map-service.ts`, `src/application/quest-board-repository.ts`, `src/index.ts`, `src/server/code-map-config.ts`, `src/server/http-api.ts`, `src/server/main.ts`, `src/server/runtime.ts`, `src/storage/sqlite/sqlite-quest-board-repository.ts`, `tests/code-map-explorer-web-contract.test.ts`, `tests/code-map-hierarchy.test.ts`, `tests/code-map-sync-actual-scip-e2e.test.ts`, `tests/code-map-sync-web-contract.test.ts`, `web/app.js`, `web/index.html`, `web/styles.css`, `docs/PHASE-3G-INDEPENDENT-REREVIEW-HANDOFF.ko.md`, `docs/PHASE-3G-INDEPENDENT-REREVIEW-RESULT.ko.md`, `docs/PHASE-3H-INDEPENDENT-REVIEW-HANDOFF.ko.md`, `docs/PHASE-3H-REAL-WORK-ACCEPTANCE-RESULT.ko.md`, `src/application/code-map-augmentation.ts`, `src/application/code-map-provider-registry.ts`, `tests/code-map-augmentation-web-contract.test.ts`, `tests/code-map-augmentation.test.ts`, `tests/code-map-provider-registry.test.ts`.

No implementation source was edited by this reviewer. This result Markdown is the sole reviewer-added repository artifact.

## Final QuestBoard transitions

Strict-CAS live mutations:

- Phase 3H `313e25f4-bbd2-4c37-8999-b2da13df1dab`: `review` rev3 -> `done` rev4
- Phase 3 parent `3fbedb9e-731a-45f7-a27a-1b91aed98cd5`: `planned` rev13 -> `done` rev14

Phase 3A through 3G were already done, so the parent was closed only after Phase 3H independently passed.

## Residual risks / non-blocking notes

- JavaScript is visible but had zero semantic-indexed files in this fixture run. The gap is explicit and does not violate the Phase 3H acceptance target.
- C# remains visible in inventory but currently maps to the generic unknown capability bucket due to no configured C# provider.
- The genuine Manual relation was intentionally temp-only acceptance evidence; no live/fixture Code Map facts were changed.
- The pre-existing QuestBoard Phase 3 dirty tree remains uncommitted. This review performed no reset, clean, commit, push, deploy, provider install, or runtime apply.

## Next canonical work

`82505848-0988-4be6-ae56-1f1c4e051943`

**Code-aware 4/6: Persistent Task ↔ CodeScope binding + scope Goal/TODO UX**

Live state: `planned`, revision 1.

This review stops here. Phase 4 was not started.
