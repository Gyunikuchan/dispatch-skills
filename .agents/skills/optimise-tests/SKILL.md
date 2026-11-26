---
name: optimise-tests
description: Measure this repository's test suite, run dynamic recon scouts and scoped writers against Dispatch's testing bar, and report measured deltas.
disable-model-invocation: true
metadata:
  internal: true
---

# Optimise Tests

You, the lead, reduce reported leaf tests and suite wall time while maintaining a green suite where every surviving test earns its keep under Dispatch's [testing quality bar](../../../skills/dispatch/references/templates/quality-bar.md#testing).

Fix `<run>` once at the start as local `yyyy-mm-dd-hhmm`; `<work>` is `.scratch/optimise-tests/<run>`. Keep shared helpers and fixtures (`tests/helpers/**`, `tests/fixtures/**`, `tests/unit/*/fixtures/**`), cross-file moves/tier downgrades, and production files (including test-only production helpers) strictly lead-owned. Coverage is informational feedback only.

## 1. Baseline

Verify `git status --porcelain` shows a clean tree under `tests/`, `skills/`, `scripts/`, and `.agents/skills/optimise-tests/scripts/`; if dirty, stop and ask the user to commit or stash first so deltas stay attributable.

Create `<work>/before`, save `git status --porcelain` to `<work>/baseline-status.txt`, capture `npm test` output and exit code immediately before running `inventory.ts`, and take the starting test inventory.

`bash` / `zsh`:

```bash
mkdir -p <work>/before
git status --porcelain > <work>/baseline-status.txt
npm test > <work>/before/npm-test.log 2>&1; echo "npm-test-exit=$?" >> <work>/before/npm-test.log
node .agents/skills/optimise-tests/scripts/inventory.ts --out <work>/before --coverage
```

PowerShell:

```powershell
New-Item -ItemType Directory -Force -Path <work>/before | Out-Null
git status --porcelain | Out-File -Encoding utf8 <work>/baseline-status.txt
$LASTEXITCODE = -1; npm test 2>&1 | Out-File -Encoding utf8 <work>/before/npm-test.log; Add-Content -Encoding utf8 <work>/before/npm-test.log "npm-test-exit=$LASTEXITCODE"
node .agents/skills/optimise-tests/scripts/inventory.ts --out <work>/before --coverage
```

Use `<work>/before/npm-test.log` (covering typecheck, maintain, hashes, terms, and config checks) alongside `inventory.json` `failures` to separate all pre-existing baseline failures from new regressions. Keep baseline-failing tests untouched during writer edits unless resolved by lead or user disposition.

**Done when:** `<work>/baseline-status.txt`, `<work>/before/npm-test.log` (ending with `npm-test-exit=<code>`), and `<work>/before/inventory.json` (with nonzero `totals.tests`) exist and every baseline failure is recorded.

## 2. Resolve Dispatch utility models and concurrency

Initialize a Dispatch session and resolve utility launch parameters dynamically for your `<platform>` (`claude`, `agy`, `copilot`, `opencode`, `codex`, or any Dispatch-configured host):

```bash
node skills/dispatch/scripts/dispatch.ts session init --objective "optimise-tests <run>" --host <platform>
node skills/dispatch/scripts/dispatch.ts doctor run --session <session> --host <platform>
```

Read the result JSON at the printed `path` and inspect `ok` and `reason` first:

- If `ok` is `false` (for example `config-invalid` or `integrity-drift`), stop and report the blocker with `reason` and `problems`.
- If `ok` is `true`, read `utility[<platform>]` (`models`, `effort`, `contextLimit`, `launchAs`) and `writeConcurrency` unchanged (defaults to `1` when omitted). Follow `utility[<platform>].launchAs` from [Dispatch routing](../../../skills/dispatch/SKILL.md#routing) and [launch and continue](../../../skills/dispatch/SKILL.md#launch-and-continue) when launching scouts and cleanup subagents; unlike Dispatch task worktrees, parallel cleanup subagents here run in utility write mode on strictly disjoint file scopes. Fall back to sequential inline execution in your own context only when `ok` is `true` and your host lacks a subagent launch tool.

**Done when:** `doctor run` returned `ok: true` and `utility[<platform>].launchAs` plus `writeConcurrency` are resolved.

## 3. Recon scouts and scope partitioning

Launch parallel read-only recon scouts using `utility[<platform>].launchAs` (or run sequentially inline only under the step-2 fallback). Give each scout a slice of `<work>/before/inventory.json` (`files` and `candidates`: `budgetOverruns`, `denseFiles`, `slowestTests`, `duplicateTitles`, `sharedImports`, `mergeClusters`) and instruct it to scan test and source files for:

- **Stale tests** guarding removed, moved, or superseded specs or code (_the past_).
- **Over-tiered tests** observable at a cheaper layer (unit over integration over e2e).
- **Low-signal or trivial tests** (_nothing_, _the implementation_, or straight-line/lightly-branching glue without complex logic or simplicity-floor boundaries per [testing quality bar](../../../skills/dispatch/references/templates/quality-bar.md#testing)).
- **Slow or test-dense files** needing splitting, rewriting, or consolidation.
- **Test-only production helpers** referenced only by deleted or candidate tests.

Partition scout targets into disjoint writer scopes (explicit test file lists per writer), keeping `tests/helpers/**`, `tests/fixtures/**`, `tests/unit/*/fixtures/**`, cross-file moves/downgrades, and production files outside every writer's scope.

**Done when:** every scout has reported and disjoint writer file scopes are assigned.

## 4. Parallel cleanup writers

Launch up to `writeConcurrency` cleanup subagents in parallel using `utility[<platform>].launchAs` (queuing remaining disjoint scopes until a slot frees, or running sequentially inline only when `ok` is `true` and the host has no launch tool). Pass each subagent its in-scope baseline failure list combining identifiable failing tests from `<work>/before/inventory.json` and `<work>/before/npm-test.log` (reconciling any unidentifiable baseline failure before assigning its scope; pass `none` when none apply) and brief it:

```text
Optimise these test files: <assigned test file paths>.
Baseline failures in scope (preserve untouched pending lead/user disposition): <file:test-title list from <work>/before/inventory.json and <work>/before/npm-test.log, or none>.
Standard: read skills/dispatch/references/templates/quality-bar.md#testing and aggressively delete, merge, rewrite, or downgrade in-scope tests (including stale tests) under its four retention gates and - Prune: rules.
Boundaries: edit only your assigned test files; keep listed baseline-failing tests and lead-owned exclusions (tests/helpers/**, tests/fixtures/**, tests/unit/*/fixtures/**) untouched; run no Git write commands and no Dispatch toolkit commands.
Verify: run the focused Node test command from AGENTS.md § Verification Details over your surviving assigned test files (account for any whole-file deletions in the report).
Report: changed and deleted paths, deleted/merged/rewritten counts, test pass/fail output, and any proposed cross-file moves, cross-layer tier downgrades, shared helper/fixture edits, or test-only production helpers for the lead.
```

**Done when:** every writer has returned verified edits or a blocker.

## 5. Lead verification, moves, and helper removal

Compare `git status --porcelain` against `<work>/baseline-status.txt` and assigned scopes; inspect any unexpected edit outside assigned scopes, retain it untouched, and escalate to the user for disposition rather than reverting automatically. Run the focused Node test command (`AGENTS.md` § Verification Details) over all surviving modified and replacement test files, accounting for whole-file deletions via the diff and full-suite verification, and resolving or reverting only verified writer regressions.

Execute lead-owned work serially:

- Apply cross-file moves, splits, and cross-layer tier downgrades (re-home e2e/integration tests down to cheaper unit/integration layers and delete superseded upper-tier tests).
- Apply required updates in `tests/helpers/**`, `tests/fixtures/**`, and `tests/unit/*/fixtures/**`.
- Remove verified test-only production helpers after confirming zero remaining production or retained-test callers, then verify affected tests.

**Done when:** all lead-owned moves, downgrades, fixture updates, and helper removals are applied and focused runs over touched test files show zero new regressions (accounting for any preserved baseline failures).

## 6. After measurement, audit, and handoff

Run the after snapshot with delta comparison and full verification after the last change:

```bash
node .agents/skills/optimise-tests/scripts/inventory.ts --out <work>/after --coverage --compare <work>/before/inventory.json
npm test
```

Run `npm run test:e2e` as well when e2e tests, toolkit, Git, or subprocess behavior changed.

Completion requires a green `npm test` (and `npm run test:e2e` when applicable) after the last edit with zero new regressions; if any pre-existing failure blocks those required completion commands, report the run incomplete/blocked until resolved, while preserving and accounting for unrelated baseline failures outside the required suite in the handoff.

Audit the final diff against [testing quality bar](../../../skills/dispatch/references/templates/quality-bar.md#testing) to verify deletions, downgrades, and surviving tests satisfy the bar. Hand off in `AGENTS.md` § Long-Running Work and Handoff format, linking `<work>/after/delta.md` with measured leaf-test, file-count, and wall-clock duration deltas, baseline vs. after failure status, informational coverage changes, removed test-only helpers, and any unmet objective or blocker.

**Done when:** the final green verification, audit, and handoff are complete.
