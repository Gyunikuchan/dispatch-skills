# Walkthrough — Fix audit findings A-61, A-90, A-101

Fixes three findings from `.scratch/audits/2026-09-11-2211-audit.md`:

- **A-61** (portability): the delegate env whitelist stripped non-secret proxy, CA, XDG and config-dir vars, and the stripping of token env auth was undocumented.
- **A-90** (tooling): only `skills/dispatch` had a hash manifest; the review skills' prompt/walkthrough templates had no integrity coverage. The chosen option (of the two the finding proposed) is **extend hashing to the review skills and verify in `fill-template`**.
- **A-101** (tooling): `.agents/hooks.json` and `.agents/mcp_config.json` were no-op configs.

## Changes Made

### A-61 — env whitelist
- **[MODIFY]** `skills/dispatch/scripts/common.mjs` — `SAFE_ENV_WHITELIST` gains non-secret reachability/identity vars: `HTTP(S)_PROXY`/`ALL_PROXY`/`NO_PROXY` (both cases), `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `XDG_CONFIG_HOME`/`XDG_CACHE_HOME`/`XDG_DATA_HOME`/`XDG_STATE_HOME`, `CLAUDE_CONFIG_DIR`, `USER`, `USERNAME`, `LOGNAME`, `TZ`. None matches `SENSITIVE_ENV_KEY_PATTERN`, so credential stripping is unchanged.
- **[MODIFY]** `skills/dispatch/scripts/opencode-run.mjs` — dropped `XDG_CONFIG_HOME` from `OPENCODE_EXTRA_ENV_ALLOWLIST` (now redundant against the shared whitelist); the local-endpoint WAN trap now derives its keys from the whitelist — every whitelisted `*_PROXY` except `NO_PROXY` is overwritten with the dead proxy — so a proxy-shaped var added to the whitelist later cannot silently restore WAN reachability for a local run. Remote/unknown-host providers inherit the user's real proxy (the point of the finding).
- **[MODIFY]** `skills/dispatch/README.md` — new "Delegate Environment & Authentication" subsection: what passes through, and "sign each CLI in interactively once — API-key and token env vars are not inherited".

### A-90 — integrity manifests for the review skills
- **[MODIFY]** `scripts/generate-hashes.mjs` — now generates/checks a manifest per hashed skill (`HASHED_SKILLS = dispatch, dispatch-code-review, dispatch-plan-review`). New `--skill <name>` restricts to one (once only); `--out <path>` still writes a single manifest (implies one skill, default `dispatch`) and is rejected with `--check`; `--check` reports drift as `<skill>/<key>`. Unknown skill names, a repeated `--skill`, and `--check --out` all exit 2.
- **[NEW]** `skills/dispatch-code-review/skill-hashes.json`, `skills/dispatch-plan-review/skill-hashes.json` — 3 entries each (`SKILL.md` plus both `references/*.md`).
- **[MODIFY]** `skills/dispatch/scripts/fill-template.mjs` — new `resolveSkillRoot()` (a `references/` template resolves to its skill root) and `assertTemplateIntegrity()`, called before reading the template: parses the owning skill's `skill-hashes.json` when present and hashes the template directly, exiting 1 when **the template being filled** drifted or the manifest is unreadable, warning (and filling) when the template is unlisted or a sibling file drifted (see Review Findings R1 and R2-1). A skill with no manifest fills unchecked and silently (packaging choice, not a violation).
- **[MODIFY]** `.husky/pre-commit` — `set -e` added, and the pattern widened to `skills/dispatch(-code-review|-plan-review)?/(SKILL.md|references/|scripts/)` as an ERE via `grep -qE`, with all three manifests staged. `implement-dispatch` still excluded (it ships no manifest) — the mismatch A-90 flagged.
- **[MODIFY]** `scripts/validate-configs.mjs` — manifest discovery loops over the three hashed skills × `skills/`, `.agents/skills/`, `.claude/skills/` roots instead of hardcoding `dispatch`.
- **[MODIFY]** `skills/dispatch/references/alignment.md` — § Prompt Template Filling documents the integrity gate and the regeneration command.

### A-101 — no-op configs
- **[DELETE]** `.agents/hooks.json` — a `PostToolUse` matcher with an empty `hooks` array.
- **[DELETE]** `.agents/mcp_config.json` — `{"mcpServers": {}}`.
- **[MODIFY]** `.agents/skills/audit-dispatch-skills/references/broad.md` — dropped both files from the broad audit scope list.

### Tests
- **[MODIFY]** `tests/skills/dispatch/common.test.mjs` — `getSanitizedEnv` passes the new non-secret vars through; every `SAFE_ENV_WHITELIST` entry survives `SENSITIVE_ENV_KEY_PATTERN` (guards a future credential-shaped addition).
- **[MODIFY]** `tests/skills/dispatch/opencode-run.test.mjs` — the "no proxy vars for a remote provider" test now clears ambient proxies first (they are inheritable by design); new test asserts a remote provider inherits an ambient `HTTPS_PROXY`/`ALL_PROXY` while a local one gets the trap value.
- **[MODIFY]** `tests/scripts/generate-hashes.test.mjs` — all three committed manifests cover `SKILL.md` (plus `references/prompt-template.md` for the review skills); `--skill dispatch-code-review --out <temp>` deep-equals the committed manifest and leaks no other skill's files; `--skill implement-dispatch`, a repeated `--skill`, and `--check --out` each exit 2.
- **[MODIFY]** `tests/skills/dispatch/fill-template.test.mjs` — fills a real review template with an intact manifest; appending to a hashed template makes fill exit 1 naming `references/prompt-template.md`; an unreadable manifest exits 1; an unlisted template warns and fills; drift in a sibling `SKILL.md` warns but still fills; a manifest-less skill fills with empty stderr.

## Verification & Validation
### Automated Tests
- Command: `npm test` — 688 tests, 686 pass, 0 fail, 2 skipped (re-run after round-2 fixes).
- Command: `node scripts/generate-hashes.mjs --check` — up to date for all three skills.
- Command: `node scripts/validate-configs.mjs` — 7 config files valid (now including both new manifests).
### Manual Verification
- Piped a sample staged-path list through the husky `SKILL_PATTERN` (both as BRE before the review fix and as the final ERE): matches `skills/dispatch-code-review/SKILL.md`, `skills/dispatch/scripts/x.mjs`, `skills/dispatch-plan-review/references/prompt-template.md`; does not match `skills/implement-dispatch/SKILL.md`, `skills/dispatch/README.md` or `skills/dispatch/skill-hashes.json`.
- `node scripts/generate-hashes.mjs --check` clean for all three skills; `--check --out x.json` exits 2; `--skill dispatch --skill dispatch-plan-review` exits 2.
- Filled a live review template (`--list` on `skills/dispatch-code-review/references/prompt-template.md`) with the manifest intact: exit 0, no warning.

## Key Deviations
- A-90 offered two options; the user selected extending hashing. The husky pattern had already been narrowed in a prior commit, so it was re-widened to exactly the hashed set rather than left narrow.
- A-61's proposal named the vars to whitelist; `ALL_PROXY`, `SSL_CERT_FILE`/`SSL_CERT_DIR` and `LOGNAME` were added for the same reason, and the opencode local trap was extended to `ALL_PROXY` to keep the WAN confinement airtight after the whitelist change.

## Review Findings & Resolutions

### Round 1 — Full review (2026-09-12)

**Dispatch**: all three external delegates failed — `agy` returned an empty response after 1 turn, `copilot` exited `[auth]` (not signed in), `opencode`/LM Studio reported "Model unloaded by user or API request". Fell back to the in-process orchestrator subagent per `dispatch`'s graceful-degradation path, so this round has **one reviewer and no cross-agent corroboration** — every claim was adjudicated against the cited lines individually.

| # | Claim (severity) | Verdict | Resolution |
|---|---|---|---|
| R1 | The gate verifies the whole skill dir, so editing a sibling `SKILL.md` aborts an unrelated fill (`fill-template.mjs:176`) — SHOULD-FIX | **Accept** — verified: `verifySkillIntegrity` walks every manifest entry, and the review skills' `SKILL.md` is in the manifest | Abort only on the filled template's own drift; other drift warns and continues. New test covers the sibling-drift warn path. |
| R2 | "A tampered template can't be dispatched" overstates the guarantee — the manifest itself is unhashed and a missing manifest skips silently — SHOULD-FIX | **Accept** — verified: `common.mjs` hashes only `SKILL.md`/`scripts/*.mjs`/`references/*.md`, never the manifest | Reworded `fill-template.mjs` header and `alignment.md` to "detects an unnoticed or accidental modification", explicitly not tamper resistance. |
| R3 | `alignment.md` points users at `node scripts/generate-hashes.mjs`, which is repo-root tooling and not shipped inside the skill — SHOULD-FIX | **Accept** — verified: `skills/dispatch/scripts/` contains no generation entry point | `alignment.md` now says regeneration is repo tooling and names the host remedy (regenerate there or reinstall the skill). |
| R4 | `--check` silently ignores `--out` **and** narrows the drift check to `dispatch` alone, so `--check --out …` exits 0 with stale review manifests — SHOULD-FIX | **Accept** — verified: `outPath` participates in target selection, and the check branch never uses it | `--out` with `--check` now exits 2. Test added. |
| R5 | A repeated `--skill` silently keeps the last one — CONSIDER | **Accept** (cheap, and matches audit A-62's stance on silently-swallowed flags) | Second `--skill` exits 2. Test added. |
| R6 | The WAN trap duplicates the whitelist's proxy list by hand; a future `FTP_PROXY` in the whitelist would re-open local WAN reachability — CONSIDER | **Accept** | Trap keys now derived from `SAFE_ENV_WHITELIST` + `OPENCODE_EXTRA_ENV_ALLOWLIST` by `/_PROXY$/i`, excluding `NO_PROXY`. |
| R7 | `\|`/`\?` are GNU BRE extensions; on BSD/BusyBox grep the hook fails open and stops regenerating — CONSIDER | **Accept** — the repo's portability mandate names macOS explicitly | Switched to `grep -qE` with an ERE pattern. Re-verified positive and negative matches. |
| R8 | No `set -e`, so a failed generation still stages all three manifests and the commit proceeds — CONSIDER | **Accept** | `set -e` added (the `if` condition's `grep -q` exit 1 stays exempt, so a no-match commit is unaffected). |
| R9 | Both `getOpencodeEnv` locality tests are environment-dependent through `LM_STUDIO_URL`, which outranks the model when resolving locality — SHOULD-FIX | **Accept** — verified at `opencode-run.mjs:906-908`: `process.env.LM_STUDIO_URL` is read ahead of any config value | `LM_STUDIO_URL` deleted in both blocks, with a comment saying why. |
| R10 | The "writes a manifest…" test only reads committed files — it asserts repo state, not script behaviour, and `--skill`'s happy path is untested — SHOULD-FIX | **Accept** | Title corrected to "the committed manifests cover…"; new test runs `--skill dispatch-code-review --out <temp>` and deep-equals the committed manifest while asserting no other skill's files leaked in. |
| R11 | The live-template fill test is coupled to repo state — CONSIDER | **Accept as resolved by R1** | With violations filtered to the template, an unrelated local edit no longer fails it. |
| — | `resolveSkillRoot` edge cases (`references/sub/x.md`, a cwd named `references`) | **Reject** (reporter's own assessment, confirmed) | Not shapes this repo produces, and both fail closed into "no manifest → unchecked", never into a false pass. |
| — | Three copies of the hashed-skill list (`generate-hashes.mjs`, `.husky/pre-commit`, `validate-configs.mjs`) | **Noted, no change** | Crosses the hook/script boundary where the repo shares no constants; two of the three carry sync comments. |

**Clean axes**: no finding against the A-61 whitelist itself (no newly admitted name is credential-bearing or matches `SENSITIVE_ENV_KEY_PATTERN`), the dependency-flow invariant (`fill-template.mjs` names no downstream skill; the names live in repo tooling outside `skills/`), architecture/module design, simplicity, and `process.env` leakage across tests.

### Round 2 — Re-review (2026-09-12)

**Dispatch**: `agy` (Antigravity 2.0, gemini-3.8-flash, effort high), read-only. This round exists because Round 1's `agy` attempt was investigated: the CLI had exited 0 with `status: SUCCESS` but an empty `response` after burning 14.7k output tokens (12.2k thinking) on one turn, which `resolveRunnerExitCode` ([common.mjs:1824](../../skills/dispatch/scripts/common.mjs)) maps to exit 1, cascading. A trivial probe and a re-run of this exact prompt both succeeded, so the empty response was a one-off on Antigravity's side — not a dispatch defect. Verdict returned: "Ready to ship", no MUST-FIX.

| # | Claim (severity) | Verdict | Resolution |
|---|---|---|---|
| R2-1 | The Round-1 scoping fix made the gate **fail open**: an unparseable manifest yields `violations: [<manifest path>]`, which is not `templateKey`, so it only warns and fills; and a template absent from the manifest is never hashed at all (`verifySkillIntegrity` walks manifest keys only, returning `valid: true`) — SHOULD-FIX | **Accept** — verified both paths by reading `fill-template.mjs:176-198` against `common.mjs:1089-1120`. A genuine regression introduced by R1, where any violation previously aborted | Rewrote `assertTemplateIntegrity`: parses the manifest itself and hashes the template directly via `hashFile`, so the decisive check no longer reads a verdict off the whole skill. An unreadable manifest exits 1; an unlisted template warns and fills unverified (a host repo may legitimately add its own template); sibling drift still warns only. Two tests added. |
| R2-2 | The locality comment still says a remote provider "gets no proxy variables at all", contradicting A-61's passthrough and the new inheritance test — SHOULD-FIX | **Accept** — verified stale at `opencode-run.mjs:1248-1250` | Comment now says the function sets no proxy var for a remote provider, which therefore inherits whatever ambient proxy the whitelist passed through. |
| R2-3 | `ALL_PROXY`/`all_proxy` joined the trap but are missing from the locality test's clearance and absence loops, so an ambient `ALL_PROXY` would go unnoticed — SHOULD-FIX | **Accept** — verified at `opencode-run.test.mjs:372,380` | Both loops now iterate a shared `PROXY_KEYS` constant covering all eight keys, so a name added to the whitelist is cleared and asserted by both tests. |
| R2-4 | A repeated `--out` is silently overwritten, asymmetric with the `--skill` guard added in R5 — CONSIDER | **Accept** | Duplicate-flag guard now covers both flags with one check. |
| R2-5 | The committed-manifest test asserts `references/prompt-template.md` but omits `references/walkthrough-template.md` — CONSIDER | **Accept** | Test now asserts every `references/*.md` on disk appears in the manifest, so a new reference file cannot silently escape coverage. |
| R2-6 | The pre-commit hook hashes worktree state, so staging a partial skill change commits a manifest referencing unstaged hashes — CONSIDER | **Reject as out of scope** — real, but pre-existing: the hook has always regenerated from the worktree, and A-90 changed which skills it covers, not that. Stashing inside a pre-commit hook is a foot-gun (it can lose work on hook failure) | Logged under Follow-ups instead. |

**Clean axes**: architecture/module design, simplicity/anti-bloat, and the A-61 whitelist and WAN trap themselves (reviewer confirmed the trap remains airtight with proxy inheritance in place).

## Follow-ups
- Round 1 ran with a single in-process reviewer because every external delegate failed (auth, empty response, unloaded local model). A re-review once a delegate is available would add the cross-agent corroboration this round lacks.
