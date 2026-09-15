---
name: implement-dispatch
description: Run a feature or fix through a plan, approval gate, implementation, verification, and multi-agent review loop.
disable-model-invocation: true
---

# implement-dispatch

Run a feature or fix through `scope → plan → review → approval → implementation → verification → review → handoff`.
This skill owns orchestration; companion skills own runner behavior, review criteria, and templates.

| Dependency | Role | If unavailable |
|---|---|---|
| `dispatch` | Required runner, fallback, and provider integration | Stop and report the missing prerequisite |
| `dispatch-plan-review` | Optional plan template, review, and adjudication | Skip Step 3 |
| `dispatch-code-review` | Optional walkthrough template, review, and adjudication | Skip Steps 5–7 and record diagnostics on the plan |

**Review wave.** Before launching or adjudicating any plan/code review wave, read [`dispatch`'s alignment contract](../dispatch/references/alignment.md), especially Invocation Modes, Target → Flag Mapping, Reserve Substitution, Adjudication, Resolutions Log, and Artifact Lifecycle. That document owns delegate handover and finding grammar.

**Review failure.** When a review dispatch fails, read and apply [`dispatch`'s native fallback contract](../dispatch/references/providers.md#native-fallback). Use its terminal branch for configuration or integrity errors and its read-only native branch for runner failures; keep it separate from the native write subagent in Step 4.

## Invocation

```text
/implement-dispatch <level> (<pins>): <ask>
```

`<level>` and `(<pins>)` are optional; a bare ask is valid. The colon is used when either prefix is present.

- `<level>`: `low`, `medium`, `high`, `xhigh`, or `max`. Without one, choose `low`, `medium`, or `high` from scope. `xhigh` and `max` are explicit only.
- `(<pins>)`: provider keys, aliases, `all`, or one reviewer count `n ≥ 1`. Pass it unchanged to `resolve-flow.mjs`; it expands `all` from this skill's review configuration. Pins change reviewer breadth, not the selected level.

Use `low` for a mechanical low-risk edit, `medium` for a bounded feature or fix, and `high` for a cross-cutting change, complex refactor, or public contract. Treat provider or count pins without a level as an automatic-level run.

## Process

### 1. Scope & Setup

1. Convert the ask into checkable success criteria. Fold settled decisions from a preceding interview directly into the criteria and assumptions.
2. Classify the scope as `trivial`, `focused`, or `cross-cutting`; map it to `low`, `medium`, or `high`. An explicit level overrides the mapping. Treat this as the initial classification; an automatic level may be reclassified after plan review.
3. Resolve the execution flow:

   ```bash
   node <skills-dir>/implement-dispatch/scripts/resolve-flow.mjs --platform <key> [--orchestrator-model <model>] [--level <level>] [--pins <pins>] [--exclude <keys>]
   ```

   Use the orchestrator provider key for `--platform`, pass an explicit model only when requested, and save the JSON output as `flow`. The resolver checks `skill-hashes.json` first. On any integrity or configuration failure, relay the diagnostic and stop.

   The resolver cross-checks `plan-review.platforms` and `code-review.platforms` against `dispatch`'s effective provider set. `implementation.platforms` selects a native write subagent and may contain `copilot` even when that provider is absent from `dispatch`. Relay invalid review-platform lines verbatim; configuration ownership stays with the user.

4. Resolve plan and walkthrough paths. A named `AGENTS.md` / `CLAUDE.md` path wins; otherwise run:

   ```bash
   node <skills-dir>/dispatch/scripts/resolve-artifact-paths.mjs
   ```

**Done when:** the criteria and assumptions are written, the initial scope and level are classified, `flow` is loaded, and both artifact paths are resolved.

### 2. Author Plan

1. Write the plan at the resolved path. When `dispatch-plan-review` is installed, use its [plan template](../dispatch-plan-review/references/plan-template.md); otherwise include `## Key Decisions & Context`, `## User Review Required`, `## Open Questions & Assumptions`, `## Proposed Changes`, `## Rollback & Blast Radius`, `## Verification Plan`, and `## Out of Scope`.
2. Make the plan self-contained for external reviewers. Group proposed changes by file and tag each entry `[NEW]`, `[MODIFY]`, or `[DELETE]`.
3. Reserve approval for Step 4; it is the run's only approval gate.

**Done when:** the plan exists at the resolved path, its required sections are populated, changes are grouped and tagged, and each success criterion maps to a proposed change or verification.

### 3. Plan Review Loop

Skip this step when `dispatch-plan-review` is absent or `flow['plan-review'].maxRounds === 0`. When it is enabled but `targets` is empty, substitute one in-process read-only fallback for the first wave and record it in the plan's round log and diagnostics.

1. Start the first orchestrated wave with the plan path, `targets`, `reserves`, `consensus: true|false`, `Review Scope: Full review`, and the plan budget from the [Review contract](#review-contract).
2. Await every target and reserve outcome, including reports, native fallbacks, and terminal failures. Adjudicate each claim against the requirements, repository rules, and cited plan locus; rewrite delegate text, apply accepted changes, and append the round log under `## Review Findings & Resolutions`.
3. Run re-review waves while the [Review contract](#review-contract) keeps the loop live. Narrow `targets` by target affinity to delegates with live findings; name changed sections and pending rebuttals in `Review Scope`.
4. When a target or reserve fails with `[auth]` or `[quota]`, add its platform to the exclusion set and re-run `resolve-flow.mjs` with `--exclude <keys>` before the next wave or phase.

5. Run:

   ```bash
   node <skills-dir>/implement-dispatch/scripts/check-consensus.mjs <plan path>
   ```

   Exit `0` is the gate to approval; exit `1` sends the artifact back through the loop; exit `2` is a file or syntax error and halts the run.

6. After the plan review loop reaches consensus, re-assess its scope and level against every accepted finding and the final proposed changes. For an automatic-level run, recompute the level from the final scope; preserve an explicit level as the user's override. If the final level differs from the level used to resolve `flow`, re-run `resolve-flow.mjs` with the current orchestrator, pins, and exclusion set, replace `flow`, and use the new phase settings from this point forward. Carry the initial and final scope/level and any shift into the run diagnostics.

**Done when:** the plan's consensus check exits `0`, or the user has ruled every item at the round cap and the resulting extra verification wave is settled; the final scope and level are settled; and `flow` reflects that final level.

### 4. Implement

**Approval gate:** After Step 3's final scope/level check, or immediately after Step 2 when plan review is skipped, present the plan for approval exactly once. If it has a `## Review Findings & Resolutions` section, run `check-consensus.mjs` first. After approval, write code; halt on exit `2`.

1. For `trivial` scope or a failed implementation-subagent fallback, implement the proposed changes in the orchestrator and author the baseline walkthrough from the [walkthrough template](../dispatch-code-review/references/walkthrough-template.md) when the code-review phase is enabled (`dispatch-code-review` is installed and `flow['code-review'].maxRounds > 0`).
2. For non-trivial (`focused` or `cross-cutting`) scope, dispatch test-first to the native write subagent selected by `flow.implementation.platform` (`claude` → `general-purpose`; `agy` and `copilot` → `self`; `opencode` → `general`). Pass the plan, the resolved walkthrough path when code review is enabled, and the `model`/`effort` hints. The source key is `implementation.platforms`; it is independent of `dispatch`'s external-provider configuration. When code review is enabled, use the [walkthrough template](../dispatch-code-review/references/walkthrough-template.md); otherwise record diagnostics on the plan.
3. Use only read-only Git inspection (`git status`, `git diff`, `git log`, `git show`) while implementing; preserve the index and unrelated worktree changes so user edits and scratch artifacts survive. Hand this guard to any write subagent.
4. Read the host repository's `AGENTS.md` / `CLAUDE.md` and run its declared verification command until green. If none is declared, record that fact in the walkthrough or plan; after two identical failures, stop and report the stable failure.

**Done when:** the approved changes are complete, host verification is green, unavailable, or recorded as a stable failure, and the baseline walkthrough exists whenever the code-review phase is enabled.

### 5. Code Review

Skip Steps 5–7 when `dispatch-code-review` is absent or `flow['code-review'].maxRounds === 0`. When it is enabled but `targets` is empty, substitute one in-process read-only fallback for the first wave and record it in the walkthrough and diagnostics.

1. Verify the walkthrough exists; if it is missing, author it from the [walkthrough template](../dispatch-code-review/references/walkthrough-template.md), run the host verification command, and record the result.
2. Start the first orchestrated wave with walkthrough and plan paths, `targets`, `reserves`, `consensus: true|false`, `Review Scope: Full review`, and the code budget from the [Review contract](#review-contract). Re-resolve with the current exclusion set when plan review excluded a platform.
3. Await every target and reserve outcome, including reports, native fallbacks, and terminal failures, before adjudicating.

**Done when:** the walkthrough is attached, every launched review dispatch is settled, and round-one claims are ready for Step 6.

### 6. Apply Fixes & Settle Disputes

1. Verify each claim against the active code, requirements, and repository rules. Apply accepted fixes directly; record rejected or downgraded findings and their evidence in the walkthrough.
2. Update `## Changes Made`, `## Verification & Validation`, and `## Review Findings & Resolutions` after every accepted fix or ruling. Rewrite ruled `[Disputed]` lines as `[Resolved Dispute]` and settle pending lines per the Review contract.
3. Re-run the host verification command using Step 4's stop rule. Keep unrelated or persistent failures explicit in the walkthrough and handoff.
4. Resolve `[Disputed]` items through counter-evidence or user ruling. Under `consensus: true`, rejection or downgrade of a delegate-reported MUST-FIX or SHOULD-FIX remains `[Rejected — pending confirmation]` until the citing delegate confirms the counter-evidence. Delegate-reported `CONSIDER` findings follow `dispatch`'s `references/alignment.md` § Finality.

**Done when:** accepted fixes are applied, verification is green or its stable failure is recorded, and every review item has a logged status.

### 7. Re-Review Loop

1. While the [Review contract](#review-contract) keeps the loop live, invoke `dispatch-code-review` again with target affinity, the current exclusion set, changed lines, and pending rebuttals in `Review Scope`.
2. Apply Step 6 after each wave. At the round cap, ask the user to rule remaining disputes, write each ruling into the walkthrough, and grant the one additional verification wave defined by the Review contract.

**Done when:** `check-consensus.mjs` exits `0` on the walkthrough, or the user has ruled the remaining items and the extra verification wave is settled.

### 8. Handoff & Cleanup

Start handoff only after every target and reserve dispatch from every phase has a terminal outcome.

1. Run `check-consensus.mjs` on the walkthrough, or on the plan when code review was skipped. Exit `1` returns to Step 3 for a plan or Step 7 for a walkthrough; exit `2` halts cleanup.
2. Append `## Run Diagnostics` to the walkthrough or plan with:
   - initial and final scope classifications, evaluated level, `flow.diagnostics.effectiveLevel`, and any scope or level shift;
   - artifact slug and `slugSource` (`explicit`, `branch`, or `conversation`);
   - rounds used versus `maxRounds`;
   - active, failed, substituted, dropped, excluded, unavailable, and clamped delegates, plus exclusion reasons;
   - accepted, rejected, downgraded, disputed, and rebutted findings, and verification status.
3. On a resolved run, relocate scratch artifacts:

   ```bash
   node <skills-dir>/dispatch/scripts/relocate-scratch.mjs "<plan path>" "<walkthrough path>"
   ```

   Retain artifacts in place when the run is unresolved or halted and state why.
4. Report diagnostics and the artifact path. Leave commits, pushes, branch changes, and pull requests to the caller.

**Done when:** all review work is settled, diagnostics are appended, artifacts are relocated or their retention reason is recorded, and the handoff is delivered.

## Review contract

Apply this contract to Steps 3 and 5–7; use [`alignment.md`](../dispatch/references/alignment.md) for the full invocation and adjudication grammar.

- **Mechanical loop exit:** Continue while the prior wave changed the artifact or code, or an active `[Disputed]` / `[Rejected — pending confirmation]` line remains, and the phase is below `maxRounds`.
- **Pending confirmation:** With `consensus: true`, an orchestrator rejection or downgrade of a delegate-reported MUST-FIX or SHOULD-FIX uses `[Rejected — pending confirmation]`. Rewrite it to `[Rejected / Downgraded]` only after the citing delegate confirms the counter-evidence, or to `[Resolved Dispute]` after user ruling. Delegate `CONSIDER` findings are final at the orchestrator's ruling.
- **Ruling reset:** At the cap, a user ruling settles each escalated item and grants exactly one additional wave with a refreshed budget. A second cap ends the loop and escalates the unresolved result.
- **Target exclusion:** `[auth]` and `[quota]` remove a platform from later resolver runs; target affinity still narrows re-review to live citing delegates.
- **Budget:** Hand over `8 + 2 × <units under review>` tool turns per reviewer. A plan unit is a `## Proposed Changes` entry; a code unit is a changed file. Re-review counts only units changed since the previous wave.
