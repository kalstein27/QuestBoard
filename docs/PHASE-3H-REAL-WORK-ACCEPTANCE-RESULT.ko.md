# QuestBoard Phase 3H Real-Work Acceptance Result

- Date: 2026-09-29
- QuestBoard branch: `main`
- QuestBoard HEAD at worker acceptance: `87c34f743fffad39c3c19c7a5bf88b6314aba022`
- Phase 3H Task: `313e25f4-bbd2-4c37-8999-b2da13df1dab`
- Fixture: `<CHATGPT2CODEX_REPO>`
- Fixture branch: `docs/windows-install-refresh`
- Fixture HEAD: `49d34c44d2e158965062552e40ef1ce9b98c89e0`
- Worker outcome: **acceptance evidence passes after two provider-neutral correctness fixes; move Phase 3H to independent review, not Done**

## 1. Scope and integrity

Phase 3H dogfoods the actual ChatGPT2Codex repository as a mixed-language acceptance fixture. The fixture was indexed through temporary QuestBoard database and Code Map storage. No file in ChatGPT2Codex was modified.

Fixture status was checked before and after the acceptance run:

- branch `docs/windows-install-refresh`
- HEAD `49d34c44d2e158965062552e40ef1ce9b98c89e0`
- dirty files: none
- staged files: none

No commit, push, deploy, runtime apply, provider install, Managed MCP update, reset, checkout, clean, or revert was performed.

## 2. Findings discovered by real-repo dogfood

### Finding A: semantic node language omission produced false TypeScript zero-coverage

The first real ChatGPT2Codex index successfully produced a large semantic SCIP graph:

- 20,461 raw nodes
- 47,678 raw relations
- 19,921 semantic symbols
- SCIP provider status `fresh`, fidelity `semantic-call`

However the provider capability report showed TypeScript as `0 indexed files / 0 symbols`. The semantic nodes had exact TypeScript source paths but many omitted `node.language`, so language-based coverage accounting classified the semantic symbols outside the TypeScript bucket.

Fix:

- `src/application/code-map-hierarchy.ts`
- After canonical file hierarchy materialization, only semantic nodes whose language is missing are annotated from their exact `location.path`.
- The language source is the canonical file node for that exact path, falling back to `inferCodeLanguageFromPath(path)`.
- Node IDs, canonical identity, containment, relations, provenance, and provider facts are not changed.
- This is provider-neutral and does not hardcode ChatGPT2Codex architecture.

Regression:

- `tests/code-map-hierarchy.test.ts`
- The semantic fixture deliberately omits TypeScript language from `Service` and `run`; hierarchy materialization must recover `typescript` from the exact source path while preserving containment.

### Finding B: internal file-inventory provenance leaked into semantic providerIds

After Finding A was fixed, the real coverage report correctly showed semantic TypeScript coverage but reported internal `questboard:file-inventory` alongside `scip-typescript` as if it were a semantic provider.

Fix:

- `src/application/code-map-provider-registry.ts`
- provider capability `providerIds` now excludes legacy `file-inventory` and internal `questboard:file-*` provenance.
- File inventory still remains attached to raw node provenance; it is only excluded from the semantic-provider capability list.

Regression:

- `tests/code-map-provider-registry.test.ts`
- Uses canonical `questboard:file-inventory` fixture provenance.
- TypeScript providerIds must be exactly `["scip-typescript"]`.
- Swift/Shell/PowerShell with file-only inventory must have `providerIds: []`.

## 3. Actual ChatGPT2Codex repository measurements

The final fresh real-repo acceptance run used `FileSystemCodeFileInventory` and asserted that raw Code Map file-node count exactly matched the bounded repository inventory.

### File inventory

Total files: **540**

Language counts:

| Language | Files |
| --- | ---: |
| TypeScript | 315 |
| JavaScript | 12 |
| Swift | 3 |
| Shell script | 23 |
| PowerShell | 20 |
| C# | 1 |
| Unknown / non-language-classified | 166 |

Concrete unsupported-language file evidence included:

Swift:

- `macos/ChatGPTToCodexStatusBar/accessibility-bridge.swift`
- `macos/ChatGPTToCodexStatusBar/ax-helper.swift`
- `macos/ChatGPTToCodexStatusBar/main.swift`

Shell:

- `.runtime/install-chatgpt2codex-verified.sh`
- `script/apply_local_runtime.sh`
- `script/build_and_run.sh`

PowerShell:

- `scripts/verify-windows-portable.ps1`
- `start-chatgpt.ps1`
- `windows/Archive-Portable.ps1`

### Raw Code Map

- raw nodes: **20,461**
- raw relations: **47,678**
- compatibility architecture projection nodes: **1**
- compatibility architecture projection relations: **0**

This is direct evidence that a nearly-empty macro architecture projection does not make the raw Code Map unavailable or unindexed.

## 4. Provider coverage and gaps

### TypeScript

- discovered TypeScript files: **315**
- semantic-covered files: **137**
- TypeScript semantic symbols: **19,921**
- fidelity: `semantic-call`
- providerIds: `["scip-typescript"]`
- gap: `partial_coverage`

`partial_coverage` is expected to remain visible rather than being hidden: the provider produced a large semantic graph but not every inventoried `.ts` file contained indexed symbols.

### Unsupported semantic providers in this runtime

Swift:

- discovered: 3
- indexed: 0
- fidelity: file-only
- gap: `no_trusted_provider_available`
- trusted install options: 0

Shell script:

- discovered: 23
- indexed: 0
- fidelity: file-only
- gap: `no_trusted_provider_available`
- trusted install options: 0

PowerShell:

- discovered: 20
- indexed: 0
- fidelity: file-only
- gap: `no_trusted_provider_available`
- trusted install options: 0

No provider installation was attempted. The tested lifecycle regressions separately confirm that when a trusted install option exists, the request is approval-only/external-host and does not install or reindex by itself.

## 5. Representative raw symbol navigation and UI/agent parity

Representative real symbol selected from the indexed ChatGPT2Codex graph:

- name: `registerTools`
- kind: `function`
- source: `src/server/tools.ts`
- raw node ID: `code:node:76dfb2290b950e8304249049`
- canonical identity: `scip:scip-typescript npm chatgpt2codex 0.2.0 src/server/\`tools.ts\`/registerTools().`

Bounded semantic query results:

- callers: **1**
- callees: **20**
- references: **20**
- referenced-by: **1**
- bounded direct relation inspector result count: 100
- containment parent chain was present and returned exact parent raw IDs.

The same exact raw node was queried through the agent tool boundary and HTTP `/code-map/query` boundary. The following were asserted identical:

- selected node ID
- containment parent node IDs
- relation ID + target-node-ID sequence

Result: **HTTP/agent parity PASS**.

The existing fresh actual-SCIP headless-browser E2E also passed and verifies the shared Web query path, cross-file relation navigation, Back restoration, and Code→Flow compatibility.

## 6. Manual augmentation acceptance

A manual relation was created using two exact real TypeScript raw-node endpoints from the ChatGPT2Codex index.

The final acceptance overlay used relation kind `overrides` to make the manually-added relation unambiguous in a bounded relation query. An earlier `depends_on` attempt was valid but the selected high-degree symbol already had more provider `depends_on` facts than the 100-result query cap, so that particular manual edge was outside the bounded first page. The cap was not weakened.

Verified:

- manual relation is visible through bounded Code Map query
- provenance remains manual
- cached raw graph does not contain the `manual:*` overlay relation
- fresh real-repo reindex with unchanged exact endpoints keeps manual relation `active`
- no fuzzy relinking is used

Fresh targeted regression also proves the complementary stale path:

- endpoint removal → manual relation becomes `stale`
- stale reason is retained
- stale edge is excluded from active query facts
- raw provider graph remains unchanged

### Residual review question

The real-repo acceptance overlay used real indexed endpoints and fully validates the manual-wiring mechanism, but the semantic truth of that newly-added `overrides` edge was not independently established from source/runtime evidence as an actually provider-missed relation.

The independent reviewer should decide whether Phase 3H scenario 6 requires a specifically evidenced real provider omission rather than merely a real-repo exact-endpoint manual overlay. If that stronger interpretation is required, keep 3H in review and record the missing evidence instead of silently accepting it.

## 7. Architecture lens independence

Actual ChatGPT2Codex result:

- raw nodes: 20,461
- raw relations: 47,678
- architecture projection nodes: 1
- architecture projection relations: 0

Raw node search, containment, usages/calls, provider coverage, and manual wiring remained operational. This directly satisfies the intended raw-graph-over-projection invariant.

## 8. Fresh verification

Targeted acceptance suite after the fixes:

- build: PASS
- 10/10 tests PASS
- includes:
  - manual active query and stale-no-fuzzy behavior
  - manual SQLite restart persistence
  - agent/MCP manual parity
  - HTTP manual mutation/status
  - mixed-language file hierarchy
  - provider-neutral file inventory
  - provider mixed-language coverage gaps
  - approval-only install lifecycle
  - HTTP/agent install-option parity
  - actual SCIP + headless Chrome Web/Code→Flow E2E

Full fresh verification:

- `npm run typecheck`: PASS
- `npm run check:web`: PASS
- Node tests: **161/161 PASS**
- failures: 0
- skipped: 0
- claim-race gate: PASS
- `git diff --check`: PASS

## 9. Worker conclusion

The final worker-run evidence demonstrates that on the actual ChatGPT2Codex repository:

- mixed-language files are not silently dropped
- TypeScript semantic facts can be navigated by exact shared raw identity
- provider coverage gaps are explicit
- unsupported languages remain visible as file-only with `no_trusted_provider_available`
- manual overlay survives reindex when exact endpoints survive and stays separate from raw facts
- stale behavior is regression-tested
- raw Code Map remains useful even when architecture projection is nearly empty
- Quest/Flow/Task/Resume/Code→Flow compatibility regressions pass

Because this Phase 3H worker discovered and changed QuestBoard product source during dogfood, it must not independently mark its own acceptance Done. The Task was transitioned to `review / revision 3`, followed by a fresh independent review using the companion handoff document.

Final continuity state after this worker run:

- Phase 3H: `review / revision 3`
- Phase 3 parent: `planned / revision 13`, awaiting Phase 3H independent acceptance
- independent review handoff: `docs/PHASE-3H-INDEPENDENT-REVIEW-HANDOFF.ko.md`
- required independent review result: `docs/PHASE-3H-INDEPENDENT-REVIEW-RESULT.ko.md`
- Phase 4 implementation: not started
