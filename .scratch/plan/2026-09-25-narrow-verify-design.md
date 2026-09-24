# Spec: Narrow verification for write subagents

## Problem

Write subagents in session `01LU26DvMbmZmeCySb4kXBA9` (local transcript `4de7fb43-…`) spent 475–1246s per run waiting on tools, almost all of it re-running whole driver test files (70–120s each; individual driver-fixture tests take 5–9s):

| Writer | Wall | Tool wait | Model | Turns |
|---|---|---|---|---|
| RED writer (restore) | 647s | 475s | 245s | 71 |
| RED writer | 1143s | 513s | 458s | 78 |
| Production SC1–SC7 | 1641s | 1246s | 581s | 125 |

Root cause: every plan `Verify:` line was a whole test file (e.g. `node --test tests/skills/dispatch/driver/scripted.test.mjs`, 39 tests, ~4 relevant). Writers ran exactly those commands, as instructed. Two sources teach file-level as "narrow":

- `skills/dispatch/references/templates/plan.md:30` — "narrowest feedback command" with no example or definition below file level.
- `skills/dispatch/scripts/driver/write.mjs:87` `VERIFICATION_RULES` — its only example is `node --test <changed test file>`.

## Goals

- Plan `Verify:` commands run only the criterion's tests.
- Writers iterate on their criteria's mapped commands, with the plan as the single source of verification scope.
- Write-brief prose is maintained as Markdown templates, consistent with review prompts.

## Non-goals

- No plan lint rule for verification scope (judgment belongs in plan review).
- No writer timeout rule (some commands legitimately run long).
- No driver test-count or test-name check (see ADR-001); this repo's guard lives in its own reporter (change 6).
- Profiling the slow ordinary driver fixture — tracked separately.

## Changes

### 1. Write briefs move to Markdown templates

- New `skills/dispatch/references/templates/write-brief.md` (shared frame) plus kind blocks `write-brief-tests-only.md` and `write-brief-production.md`, assembled by the existing `scripts/review/fill-template.mjs` mechanism (frame + per-kind block, as `review-prompt.md` + `review-prompt-<kind>.md`).
- Templates hold prose only: verification and edit rules, purpose, production instruction and conflict rule, tests-only admission-repair wording (as a block, not placeholder conditionals).
- Stay generated in `write.mjs` and embedded in the brief as structured data: `envelope`, `selfCheck`, `packet` (schema-validated), `manifest`, `boundaries`, `criteria` with mapped `commands`, `admissionDefects`. Rationale: these are coupled to `parseImplementationOutcome` / `selfCheck()` validators; copying them into Markdown invites drift.
- Host launch instructions emitted by `writeAction` (`write.mjs:148–150`) stay in code (driver branch-point emissions, not writer prose).
- Brief is still written beside run state and hashed over filled content; `promptPath`/`promptHash` unchanged.
- New templates enter `skill-hashes.json` (`npm run hashes`).

### 2. Writer rules (frame; replaces `VERIFICATION_RULES`)

```
- Verify with your criteria's mapped commands only; after each change, rerun just the commands it
  affects. Never run an aggregate suite such as `npm test`: the driver runs every gate after you return.
- Edit with your file edit/write tools, batching related changes; do not chain shell text rewrites
  (sed, awk, python) over source files.
```

### 3. Tests-only block adds

```
- Name each test so its criterion's mapped command selects it.
```

Test names describe behavior, never plan-scoped criterion IDs (`SC#` collides across plans; tests outlive plans). The writer owns test names within its approved paths, so a mismatch is fixed by renaming tests, never by editing the approved plan (which would change its hash and force re-review, `implement-state.mjs:29`).

### 4. Plan template `Verify:` comment (`plan.md:30`)

```
<!-- command running only this criterion's tests, e.g. `node --test --test-name-pattern="apply-fixes (regenerates|leaves) skill-hashes" <file>` rather than the whole file when it holds other tests; prefer a form that exits nonzero when it selects no tests; red: never the aggregate suite; append [FINAL] to a broad or slow proof run only at required gates -->
```

### 5. Plan review (`review-prompt-plan.md`, `## against`)

```
- The plan's `## Success Criteria`: each criterion observable and paired with a named test or exact
  verification step whose command runs only that criterion's tests and matches existing test names.
```

### 6. Repo tooling: quiet reporter guards zero selection and reports every failure (dispatch-skills only)

One reporter and one command form for every test run in this repo, so agents never choose between runners or reporters.

- `scripts/test-reporter.mjs`:
  - **Zero-selection guard.** On a per-file `test:summary` with `counts.tests === 0`, record the file. After the stream ends, write one line `✖ Selected no tests: <relative paths>` to stderr and exit 1. Rationale: a filtered file that selects nothing still counts as one passing top-level test in the global summary (Node 24: `tests 1, pass 1`); only its own file summary reports zero.
  - **Drop fail-fast.** Remove the immediate `exit(1)` on `test:fail`; collect non-parent failures into the existing (currently unused) `failures` array and emit through the existing summary branch, then exit 1. Rationale: the RED gate requires the file's exact failing set; fail-fast exposes only the first failure, breaking admission for criteria with more than one RED test.
  - **Context hygiene.** Passing output unchanged (one summary line). Failures: the first prints its full `formatFailure` block; later ones print only `✖ <name>` + `  Location: <file:line:col>` (the shape `verification/test-failures.mjs` already parses). Zero-selection adds one line only when triggered.
  - Update the header `@description` (no longer fail-fast).
- `tests/scripts/test-reporter.test.mjs`: cases for zero-selection (single and multi-file), multiple failures all reported with only the first expanded, parent `subtestsFailed` suites still excluded, pass path unchanged.
- `.claude/CLAUDE.md` (repo convention, host-owned): add under Verify: "Run tests, including plan Verify commands, as `node --test --test-reporter=./scripts/test-reporter.mjs [--test-name-pattern=\"…\"] <file>`." `npm test` already uses this reporter.
- Trade-off accepted: a failing `npm test` now runs the whole suite instead of stopping at the first failure (slower red runs; green runs unchanged).
- The shipped plan-template example (change 4) stays runner-generic; this repo's convention overrides it through workspace rules.

## Constraints

- Agent-read prose: apply `writing-for-agents`; net-neutral word count (plan comment and review bullet grow slightly; writer rules replace `VERIFICATION_RULES` one-for-one).
- Brief format change is reader-facing for write subagents; envelope schema is unchanged.
- Host neutrality: no runner-specific logic added to the driver.

## Success criteria (draft)

- [SC1] Tests-only and production briefs render from Markdown templates; structured fields remain generated and schema-valid; brief hash covers filled content.
- [SC2] Writer rules in the brief name mapped commands as the verification scope and contain no whole-file example.
- [SC3] Tests-only brief carries the test-naming rule.
- [SC4] Plan template Verify comment carries the filtered example, the no-selection preference, and existing red/[FINAL] rules.
- [SC5] Plan review `against` bullet requires criterion-scoped commands matching existing test names.
- [SC6] The repo reporter exits 1 with one `Selected no tests` line when any file selects zero tests.
- [SC7] The repo reporter reports every failing test (first expanded, rest name + location) and no longer exits at the first failure; the driver's quiet-reporter parser extracts the full failing set.
- [SC8] `.claude/CLAUDE.md` names the single test command form.
- [SC9] `npm test` passes; `skill-hashes.json` regenerated.

## ADR-001: Accept unguarded zero-selection for verify-class criteria

**Status:** Accepted (2026-09-25)

**Context.** Filtered Verify commands can select zero tests (typo in the pattern, test later renamed). Criteria have one evidence class:

- `red` — the RED gate requires a nonzero exit with named failing tests, so a zero-selection filter is rejected. Guarded.
- `verify` — the driver only requires exit 0 at verification gates. A zero-selection command passes vacuously.
- `review` — no command.

Runner behavior on zero selection varies: pytest exits 5 and jest exits 1 (self-guarding); Node's test runner exits 0 (verified on Node 24: `node --test --test-name-pattern=<no match> <file>` reports the file itself as one passing test). The gap predates filtering — a verify command pointing at the wrong file passes the same way — but filters make typos likelier.

**Options considered.**

- A. Driver parses reporter output and fails on zero real tests. Rejected: runner-specific (Node spec/TAP/quiet only via `verification/test-failures.mjs`); every other runner falls through unguarded; Node's file-wrapper quirk (`tests 1, pass 1` on zero match) needs special-casing; grows a parser set.
- B. Rely on runner exit codes; planners prefer self-guarding command forms. **Chosen.**
- C. Production envelope lists proving test names per verify criterion; driver requires each name in gate output. Rejected: fails when the reporter is silenced or terse (pytest dots, go without `-v`); skipped tests still print names; adds a shared envelope-schema field.
- D. Code-review backstop only. Retained as the backstop, not sufficient alone.

**Decision.** No driver check. The plan template asks for a command form that exits nonzero on zero selection where the runner supports it. Plan review checks that filters match existing test names. Code review's existing bullet ("a test passing without exercising it" → `intent`) is the backstop.

**Consequences.**

- Runners that fail on zero selection are guarded with no dispatch code.
- dispatch-skills is guarded by repo tooling, not dispatch: its quiet reporter fails on zero selection (change 6), and its workspace convention routes every test run through it. This is the pattern for host repos: guard in the host's own runner configuration.
- Other Node repos without such a reporter remain unguarded for verify-class criteria; detection relies on plan and code review judgment.
- Red criteria remain deterministically guarded by the RED gate.
- Revisit if vacuous verify passes are observed in practice; option A (or a runner-provided fail-on-no-tests flag) is the upgrade path.
