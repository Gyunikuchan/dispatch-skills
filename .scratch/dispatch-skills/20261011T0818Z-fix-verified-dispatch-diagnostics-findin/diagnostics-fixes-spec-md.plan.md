# Fix verified dispatch diagnostics findings

> **TL;DR:** The thin-driver plan run lost 10 m to a fixed review timeout, needed user quotes for minor intent findings, reported a false "raise the cap" diagnostic, and sent rule frames too large to read. Scale the timeout by level, let the orchestrator rule settled intent findings, stop H2 from flagging designed MUST continuation, and move rule-frame finding bodies into a file.
>
> **Parent:** `diagnostics-fixes.spec.md` · sha256:ed08f58e7ff0378203236632b20f7512e4b63677bc888110bd021553b3319f06
>
> **Decide:** none
>
> **Risk:** low — four local changes in review machine, frame emission, diagnostics, and contract prose; no protocol type removed.
>
> **Scope:** `skills/dispatch/scripts/machines/review.ts`, `skills/dispatch/scripts/machines/types.ts`, `skills/dispatch/scripts/core/frame.ts`, `skills/dispatch/scripts/core/interpreter.ts`, `skills/dispatch/scripts/lib/session.ts`, `skills/dispatch/scripts/core/diagnostics.ts`, `skills/dispatch/scripts/domain/diagnostics.ts`, `skills/dispatch/references/review-rules.md`, `skills/dispatch/SKILL.md`, tests.

## Background

- Review delegate timeout: `skills/dispatch/scripts/machines/review.ts:21` `DEFAULT_TIMEOUT_MS = 600_000`, used at L50 unless run override `timeout` (seconds) is positive. Successful agy `medium` reviews took 5 m 35 s, 8 m 43 s, 8 m 26 s; one timed out at 10 m.
- Intent rulings: `validateRulings` (`machines/review.ts:318-332`) accepts an intent finding only as `needs-user` or `accept`/`reject` with `quote`; `onRulings` (L341-344) records `resolution: user: <quote>`. Frame hint at `core/frame.ts:21`; prose at `references/review-rules.md` L9 and L13 and `SKILL.md` "Await rule".
- Round policy: `policy/rounds.ts:46-54` runs a `delta` round past the cap only for fixed MUST findings. H2 (`domain/diagnostics.ts:337-356`) reports any `rounds > cap` as "cap reached" with fix "Raise the round cap or narrow scope". Review facts are built in `core/diagnostics.ts:169-214` and carry no round scope.
- Rule frame: `machines/review.ts:778-783` projects `findings: roundOpen(c)` (full bodies); `core/frame.ts:55` builds one `RULINGS` example entry per finding; the frame prints as one JSON line. Frames pass through `boundaryFrame` (`core/interpreter.ts:365,375,398`) or directly (`core/interpreter.ts:485,487,634`).

## Key Decisions & Context

- **Orchestrator decides minor intent calls (user).** User: "if it's not a major decision that needs me, I'd prefer if the orchestrator can make the call". An intent finding may be ruled `accept`/`reject` with `by: "orchestrator"` and a nonblank `reason` that cites the settled decision. The user gate (`needs-user` or user `quote`) stays for changed intent, a new external dependency or runtime prerequisite, or discarded work. The driver cannot classify these triggers; the contract states them and the reason is journaled. Rejected: keeping the quote-only rule (one user round trip per minor finding).
- **Timeout by level, not prompt size.** Defaults: `low` and `medium` 600 s, `high` 900 s, `xhigh` and `max` 1200 s. A positive run override `timeout` still wins. Rejected: provider session resume on timeout (larger change across providers; no evidence it finishes sooner); prompt-size scaling (no measured correlation).
- **H2 treats MUST continuation as designed.** Rounds past the cap whose scope is `delta`, with no re-raised findings and no escalation, are normal convergence. Rejected: raising the cap (adds rounds).
- **Findings file instead of inline bodies.** The driver writes the round's full open findings to `<run>/rule-<round>.findings.json` and the `rule` frame carries `findingsPath` plus `{id, severity, category, locus}` summaries. The suggested `RULINGS` event stays (ids only, no bodies). Rejected: truncation markers (loses findings silently).
- **Verify-filter finding (F4) is already planned** in the thin-driver plan T5; not repeated here.

## User Review Required

None.

## Open Questions & Assumptions

- Assumption: this plan lands after the thin-driver plan T1, which also edits `core/frame.ts`; writers rebase on the current tree.

## Proposed Changes

### T1 — Review machine: level-scaled timeout and orchestrator intent rulings
- Outcome: Slow providers finish within the default at `high` and above; the orchestrator rules settled intent findings without a user round trip.
- Prerequisites: none
- Criteria: SC1, SC2

- #### [MODIFY] skills/dispatch/scripts/machines/review.ts
  - Changes: Replace the single `DEFAULT_TIMEOUT_MS` use at L50 with `defaultTimeoutMs(level)` returning 600_000 (`low`, `medium`), 900_000 (`high`), 1_200_000 (`xhigh`, `max`); keep `DEFAULT_TIMEOUT_MS` (600_000) for the L901 report-only spec. In `validateRulings`, accept an intent `accept`/`reject` when `quote` is present (user) or when `by === 'orchestrator'` and `reason` is nonblank; otherwise return `event.rulings.<id>.ruling: expected needs-user, accept|reject with the user's quote, or accept|reject by orchestrator with a reason, for an intent finding`. In `onRulings`, record `resolution: orchestrator: <reason>` for the orchestrator path.
  - Invariants: user-quote and `needs-user` paths unchanged; non-intent rulings unchanged; positive run override `timeout` wins.
- #### [MODIFY] skills/dispatch/scripts/machines/types.ts
  - Changes: Add optional `by?: 'orchestrator'` to `Ruling`.
- #### [MODIFY] tests/unit/machines/review-rule.test.ts
  - Changes: Tests `accepts orchestrator intent ruling with reason`, `rejects orchestrator intent ruling without reason`, `records orchestrator intent resolution`.
- #### [MODIFY] tests/unit/machines/review-rounds.test.ts
  - Changes: Test `scales default review timeout by level` (roster `timeoutMs` per level, override wins).

### T2 — Rule frame: findings file and summaries
- Outcome: Hosts read a short rule frame and open one file for finding bodies; no finding is lost to a truncated line read.
- Prerequisites: T1
- Criteria: SC3
- Constraints: T1 edits `machines/review.ts` first; this task does not edit it.

- #### [MODIFY] skills/dispatch/scripts/lib/session.ts
  - Changes: Add `runPaths(runDir).ruleFindings(round)` → `<runDir>/rule-<round>.findings.json`.
- #### [MODIFY] skills/dispatch/scripts/core/interpreter.ts
  - Changes: Add `withRuleFindings(ports, runDir, runRel, frame)`: when `frame.await === 'rule'`, write `data.findings` (full) to `ruleFindings(data.round)` atomically, then replace `data.findings` with `{id, severity, category, locus}` rows and add `data.findingsPath` (run-relative, forward slashes). Apply it to every frame return path at L365, L375, L398, L485, L487, and L634.
  - Invariants: journal and state unchanged; replay rewrites the same file content; non-rule frames unchanged.
- #### [MODIFY] skills/dispatch/scripts/core/frame.ts
  - Changes: The intent hint at L21 names both shapes: `{ ruling: accept|reject, quote: <user words> }` and `{ ruling: accept|reject, by: orchestrator, reason: <settled decision> }`. The `RULINGS` example at L55 reads only `id`, `category`, `locus` (works on summaries).
- #### [MODIFY] tests/unit/core/frame.test.ts
  - Changes: Test `rule frame intent hint names orchestrator ruling`.
- #### [MODIFY] tests/unit/core/interpreter.test.ts
  - Changes: Test `rule frame moves finding bodies to findings file` (file exists with full findings; frame rows hold only id, severity, category, locus; `findingsPath` set).

### T3 — Diagnostics: H2 ignores designed MUST continuation
- Outcome: The diagnostics report stops recommending a higher cap when the extra round was MUST continuation.
- Prerequisites: none
- Criteria: SC4

- #### [MODIFY] skills/dispatch/scripts/core/diagnostics.ts
  - Changes: Record each review round's `scope` (`full` | `delta` | `disputes-only`) on `ReviewFacts` from the round's prepare/wave journal data; omit when absent.
- #### [MODIFY] skills/dispatch/scripts/domain/diagnostics.ts
  - Changes: Add optional `scope` to `ReviewFacts` and parse it in the report reader (L279-289). In H2, when every round past the cap has `scope: 'delta'`, no re-raised findings and no escalation, skip the phase. Otherwise keep current output.
  - Invariants: existing H2 cases (no cap, re-raise, regression, deadlock) unchanged.
- #### [MODIFY] tests/unit/domain/diagnostics-report.test.ts
  - Changes: Test `h2 skips must continuation delta rounds past cap`.

### T4 — Contract prose and hashes
- Outcome: The orchestrator learns the intent ruling path and its user-gate triggers from the always-loaded contract and review rules.
- Prerequisites: T1, T2, T3
- Criteria: SC5, SC6

- #### [MODIFY] skills/dispatch/references/review-rules.md
  - Changes: L9 "Intent conflicts require `needs-user`" and L13 intent sentence become: rule an intent finding `needs-user`, `accept`/`reject` with the user's `quote`, or `accept`/`reject` with `by: "orchestrator"` and a reason citing the settled decision; use the user gate when the ruling changes intent, adds an external dependency or runtime prerequisite, or discards work. Name `findingsPath` as the source of finding bodies on `rule` frames.
- #### [MODIFY] skills/dispatch/SKILL.md
  - Changes: "Await rule": read bodies from `data.findingsPath`; intent: `needs-user`, user `quote`, or `by:"orchestrator"` with settled-decision reason; user gate for changed intent, new dependency, or discarded work. Keep the section within one more line.
- #### [GENERATED] skills/dispatch/skill-hashes.json
  - Command: `npm run hashes`
  - Inputs: skills/dispatch/SKILL.md, skills/dispatch/references/review-rules.md, skills/dispatch/scripts/machines/review.ts, skills/dispatch/scripts/machines/types.ts, skills/dispatch/scripts/core/frame.ts, skills/dispatch/scripts/core/interpreter.ts, skills/dispatch/scripts/lib/session.ts, skills/dispatch/scripts/core/diagnostics.ts, skills/dispatch/scripts/domain/diagnostics.ts

## Success Criteria
- [SC1] Review roster `timeoutMs` defaults by level (600/600/900/1200/1200 s); positive run override wins.
  - Changes: skills/dispatch/scripts/machines/review.ts, tests/unit/machines/review-rounds.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="scales default review timeout by level" tests/unit/machines/review-rounds.test.ts`
  - Evidence: red
  - Test rationale: Asserts per-level roster timeoutMs through the review spec; fails today because every level returns 600 s.
- [SC2] Intent findings accept an orchestrator ruling with a nonblank reason, reject it without one, and record `orchestrator: <reason>`.
  - Changes: skills/dispatch/scripts/machines/review.ts, skills/dispatch/scripts/machines/types.ts, tests/unit/machines/review-rule.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="orchestrator intent" tests/unit/machines/review-rule.test.ts`
  - Evidence: red
  - Test rationale: Drives RULINGS through the review machine; fails today because the validator demands a user quote.
- [SC3] Rule frames carry `findingsPath` and id/severity/category/locus summaries; the file holds full findings; the intent hint names the orchestrator shape.
  - Changes: skills/dispatch/scripts/lib/session.ts, skills/dispatch/scripts/core/interpreter.ts, skills/dispatch/scripts/core/frame.ts, tests/unit/core/frame.test.ts, tests/unit/core/interpreter.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="rule frame" tests/unit/core/frame.test.ts tests/unit/core/interpreter.test.ts`
  - Evidence: red
  - Test rationale: Checks the emitted frame and file through the interpreter; fails today because bodies stay inline.
- [SC4] H2 emits no finding for MUST-continuation delta rounds past the cap; existing H2 tests pass.
  - Changes: skills/dispatch/scripts/core/diagnostics.ts, skills/dispatch/scripts/domain/diagnostics.ts, tests/unit/domain/diagnostics-report.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="h2" tests/unit/domain/diagnostics-report.test.ts`
  - Evidence: red
  - Test rationale: Feeds a capped run with a delta round past the cap into the report; fails today because H2 reports cap reached.
- [SC5] `review-rules.md` and `SKILL.md` state the orchestrator intent path, its three user-gate triggers, and `findingsPath`.
  - Changes: skills/dispatch/references/review-rules.md, skills/dispatch/SKILL.md
  - Verify: `node -e "const fs=require('fs');const t=['skills/dispatch/references/review-rules.md','skills/dispatch/SKILL.md'].map(f=>fs.readFileSync(f,'utf8'));const miss=t.flatMap((s,i)=>['orchestrator','findingsPath','dependency','discard'].filter(k=>!s.includes(k)).map(k=>i+':'+k));if(miss.length){console.error(miss);process.exit(1)}"`
  - Evidence: verify
  - Test rationale: New prose check; fails today because neither file names the orchestrator intent path.
- [SC6] Full suite passes after hashes regenerate.
  - Changes: skills/dispatch/skill-hashes.json
  - Verify: `npm test` [FINAL]
  - Evidence: verify
  - Test rationale: Aggregate gate; adds no test.

## Verification Plan
### Automated Tests
- None: each criterion Verify covers it.
### Manual Verification
- Run `dispatch.ts send --dry-run` against a review run at `rule` and confirm the frame line is short and `findingsPath` opens.

## Out of Scope
- Verify-filter rule for plan-named tests (thin-driver plan T5).
- Provider session resume after timeout.
- Merging the 16 internal event types (thin-driver follow-up).
- Re-review of thin-driver plan round-4 `fixedUnreviewed` fixes.

## Rollback & Blast Radius
Hosts that parse `data.findings` bodies on `rule` frames must read `findingsPath`; SKILL.md tells them. Revert per task; no journal migration.

## Review Findings & Resolutions

### Review 20261011T0818Z-fix-verified-dispatch-diagnostics-findin/001-plan/plan.review

#### Round 1 — full

- Reviewers: agy[0] gemini-3.8-flash (low)
- No findings.
