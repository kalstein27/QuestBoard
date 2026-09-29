# ChatGPT2Codex Code Map Fresh Quality Audit

- Date: 2026-09-29
- QuestBoard task: `5de0ba78-7135-4a3c-88cb-231cca33bc3d`
- Fixture project: ChatGPT2Codex
- Fixture branch: `docs/windows-install-refresh`
- Fixture HEAD: `24d93bca3f3a8c5041473f683d0f82ef331eb3f4`
- Method: modified local QuestBoard build + fresh `scip-typescript` index + temporary external Code Map storage
- Fixture mode: read-only

## 1. Fixture integrity

Before indexing:

- branch: `docs/windows-install-refresh`
- HEAD: `24d93bca3f3a8c5041473f683d0f82ef331eb3f4`
- staged: 0
- dirty files: exactly 2
  - `src/runtime/output-policy.ts`
  - `src/server/chatgpt-consent-widget.ts`
- dirty diff summary: `2 file(s) changed, +22/-18`

After indexing:

- branch: unchanged
- HEAD: unchanged
- staged: 0
- dirty files: exactly the same 2 files
- dirty diff summary: exactly the same `+22/-18`

Result: **fixture integrity PASS**. No ChatGPT2Codex source file was modified by the audit. Generated SCIP/Code Map state existed only under a temporary external directory and was removed after measurement.

## 2. Fresh raw graph

- total file nodes: **540**
- total symbol nodes: **20,233**
- raw nodes: **20,773**
- raw relations: **48,458**

Relation kinds:

| Kind | Count |
| --- | ---: |
| calls | 3,888 |
| contains | 20,233 |
| depends_on | 24,332 |
| implements | 5 |

Historical pre-improvement dogfood values were roughly 20,461–20,478 raw nodes and 47,678–47,712 relations. Those historical values were not reused as current evidence. The fresh run is independently measured above.

## 3. Fresh file inventory

| Language | Files |
| --- | ---: |
| TypeScript | 315 |
| JavaScript | 12 |
| Swift | 3 |
| Shell script | 23 |
| PowerShell | 20 |
| C# | 1 |
| Unknown / non-language-classified | 166 |

Total: **540** files.

## 4. Provider coverage

### TypeScript

- discovered: **315**
- semantic-indexed files: **137**
- semantic symbols: **19,942**
- fidelity: `semantic-call`
- providerIds: `[scip-typescript]`
- gap: `partial_coverage`

### JavaScript

- discovered: **12**
- semantic-indexed files: **12 / 12**
- semantic symbols: **291**
- fidelity: `semantic-call`
- providerIds: `[scip-typescript]`
- gap: **none**

This is the principal acceptance result. Before the JavaScript overlay fix, ChatGPT2Codex JavaScript files were visible only as file inventory and had zero semantic symbols. The fresh current run indexes every discovered JavaScript file semantically.

Indexed JavaScript paths:

- `scripts/benchmark-runtime.mjs`
- `scripts/check-publication-boundary.mjs`
- `scripts/reject-ambiguous-macos-command.mjs`
- `scripts/scan-public-secrets.mjs`
- `scripts/scan-public-secrets.test.mjs`
- `scripts/verify-build.mjs`
- `scripts/verify-package-integrity.mjs`
- `scripts/verify-public-repository.mjs`
- `scripts/verify-windows-release-identity.mjs`
- `src/exec/chatgpt-c2ct-command.mjs`
- `src/mcp/fixtures/managed-mcp-lifecycle-service.mjs`
- `src/mcp/fixtures/managed-mcp-lifecycle-stdio.mjs`

### Unsupported/file-only languages

- Swift: 3 discovered / 0 indexed / `no_trusted_provider_available`
- Shell: 23 / 0 / `no_trusted_provider_available`
- PowerShell: 20 / 0 / `no_trusted_provider_available`
- C#: 1 / 0 / `no_trusted_provider_available`
- Unknown: 166 / 0 / `no_trusted_provider_available`

## 5. Unknown-language query normalization

Fresh bounded query using `language=unknown`:

- matchedCount: **166**
- returned page: 100 due to hard query bound

This now agrees with the provider/file inventory bucket rather than returning zero.

Representative returned paths include `.agents/CHATGPT-SEND.md`, `.agents/FAILURE-LOG.md`, `.chatgpt2codex-source-root`, and `.codex/environments/environment.toml`.

Result: **unknown filter consistency PASS**.

## 6. Representative TypeScript navigation

Representative high-degree TypeScript symbol:

- name: `registerTools`
- kind: function
- path: `src/server/tools.ts`
- line: 4024
- degree: 6420
- callers: **1**
- callees: **100** bounded at query cap
- exact-name-first ranking: **PASS**
- neighborhood first page: all useful `calls` relations, no broad `depends_on` relation displaced them

Result: **TypeScript semantic navigation remains healthy**.

## 7. Representative JavaScript navigation

Representative high-degree JavaScript symbol:

- name: `runBuildVerification`
- kind: function
- path: `scripts/verify-build.mjs`
- line: 126
- degree: 70
- callers: **1**
- callees: **9**
- exact-name-first ranking: **PASS**
- matching search count: 2, exact symbol placed first
- bounded neighborhood relation sequence begins with `contains` + `calls` and keeps `depends_on` out of the useful first page

Result: **JavaScript semantic navigation PASS**.

## 8. Query-quality acceptance

Fresh real-repo checks confirm:

1. `language=unknown` follows the same normalization as provider coverage.
2. exact symbol name ranks before enclosing canonical-identity substring matches.
3. hierarchy query is source-order stable for the inspected path.
4. neighborhood relation priority keeps broad `depends_on` behind direct navigation relations such as `calls` / `contains`.
5. query bounds remain intact.

## 9. Verification context

The local QuestBoard implementation used for this dogfood had already passed:

- targeted actual SCIP + headless E2E: 4/4 PASS
- targeted query/provider regressions: 9/9 PASS
- full `npm run verify`: **177/177 PASS**
- skipped: 0
- race gate: PASS
- `git diff --check`: PASS

No runtime apply, Managed MCP update, provider install, commit, push, reset, checkout, clean, revert, or deploy was performed for this audit.

## 10. Conclusion

The fresh ChatGPT2Codex dogfood demonstrates that the local QuestBoard Code Map quality changes materially improve real repository coverage without weakening existing TypeScript navigation:

- JavaScript coverage improved from file-only/zero semantic symbols to **12/12 files and 291 semantic symbols**.
- TypeScript remains at **137/315 semantically covered files and 19,942 symbols**.
- raw graph is **20,773 nodes / 48,458 relations**.
- unknown-language filtering is consistent with inventory.
- exact-name ranking and bounded neighborhood ordering behave as intended on real symbols.
- external fixture integrity is preserved exactly.

The implementation remains local and has not been applied to the live QuestBoard Managed MCP runtime.
