---
name: implement-dispatch
description: Run a feature or fix through a plan, approval gate, implementation, verification, and multi-agent review loop.
disable-model-invocation: true
---

# implement-dispatch

Run a feature or fix through `scope → plan → review → approval → implementation → verification → review → handoff`.
This skill owns orchestration; companion skills own runner behavior and review criteria.

| Dependency | Role | If unavailable |
|---|---|---|
| `dispatch` | Required runner, fallback, and provider integration | Stop and report the missing prerequisite |
| `dispatch-plan-review` | Optional plan template, review, and adjudication | Skip Step 3 |
| `dispatch-code-review` | Optional walkthrough template, review, and adjudication | Skip Steps 5–7 and record diagnostics on the plan |

**Shared contracts.** Before a review wave, read [`dispatch`'s alignment contract](../dispatch/references/alignment.md), especially Invocation Modes, Target → Flag Mapping, Reserve Substitution, Adjudication, Resolutions Log, and Artifact Lifecycle. That document is authoritative for delegate invocation and finding grammar.

**Review dispatch failures.** Read and apply
[`dispatch`'s native fallback contract](../dispatch/references/providers.md#native-fallback) to
every review target. Its same-platform branch is read-only and separate from the native write
subagent used in Step 4.

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
2. Classify the scope as `trivial`, `focused`, or `cross-cutting`; map it to `low`, `medium`, or `high`. An explicit level overrides the mapping.
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

**Done when:** the criteria and assumptions are written, scope and level are fixed, `flow` is loaded, and both artifact paths are resolved.

### 2. Author Plan

1. Write the plan at the resolved path. When `dispatch-plan-review` is installed, use its [plan template](../dispatch-plan-review/references/plan-template.md); otherwise use `## Key Decisions & Context`, `## Proposed Changes`, `## Rollback & Blast Radius`, `## Verification Plan`, and `## Out of Scope`.
2. Make the plan self-contained for external reviewers. Group proposed changes by file and tag each entry `[NEW]`, `[MODIFY]`, or `[DELETE]`.
3. Keep approval out of this step; Step 4 is the run's only approval gate.

**Done when:** the plan exists at the resolved path, every required section is populated, and each success criterion maps to a proposed change or verification.

### 3. Plan Review Loop

Skip this step when `dispatch-plan-review` is absent or `flow['plan-review'].maxRounds === 0`. When `maxRounds > 0` but `targets` is empty, run one in-process read-only fallback and record the substitution in the plan's round log and diagnostics.

1. Start the first wave in orchestrated mode with the plan path, `targets`, `reserves`, `consensus: true|false`, `Review Scope: Full review`, and the plan budget from the [Review contract](#review-contract).
2. Adjudicate every returned claim against the requirements, repository rules, and cited plan sections or code lines. Rewrite delegate text in your own words, apply accepted changes to the plan, and append the round log under `## Review Findings & Resolutions`.
3. Run re-review waves while the [Review contract](#review-contract) says the loop is live. Narrow `targets` by target affinity to delegates with live findings; name changed sections and pending rebuttals in `Review Scope`.
4. When a target or reserve fails with `[auth]` or `[quota]`, add its platform to the exclusion set and re-run `resolve-flow.mjs` with `--exclude <keys>` before the next wave or phase.

Run:

```bash
node <skills-dir>/implement-dispatch/scripts/check-consensus.mjs <plan path>
```

Exit `0` is the gate to approval; exit `1` sends the artifact back through the loop; exit `2` is a file or syntax error and halts the run.

**Done when:** the plan's consensus check exits `0`, or the user has ruled every item at the round cap and the resulting extra verification wave is settled.

### 4. Implement

**Approval gate:** After Step 3, or immediately after Step 2 when plan review is skipped, present the plan for approval exactly once. If it has a `## Review Findings & Resolutions` section, run `check-consensus.mjs` first. Write code only after approval; halt on exit `2`.

1. For `trivial` scope, direct execution, or a failed implementation-subagent fallback, implement the proposed changes in the orchestrator and author the baseline walkthrough when the code-review phase is enabled (`dispatch-code-review` is installed and `flow['code-review'].maxRounds > 0`).
2. For `focused` or `cross-cutting` scope, dispatch test-first to the native write subagent selected by `flow.implementation.platform`. Pass the plan and resolved walkthrough paths plus its `model` and `effort` hints. The source key is `implementation.platforms`; it is intentionally independent of `dispatch`'s external-provider configuration. Use the [walkthrough template](../dispatch-code-review/references/walkthrough-template.md).
3. Keep Git read-only throughout: use `git status`, `git diff`, `git log`, and `git show` for inspection, and leave the worktree and index intact so scratch artifacts and user changes survive. Hand this guard to any write subagent verbatim.
4. Run the host repository's declared verification command until green. If no command is declared, record that fact in the walkthrough or plan; if two consecutive runs fail identically, halt implementation and report the stable failure.

**Done when:** the approved changes are complete, host verification is green or explicitly recorded as unavailable, and the baseline walkthrough exists whenever the code-review phase is enabled.

### 5. Code Review

Skip Steps 5–7 when `dispatch-code-review` is absent or `flow['code-review'].maxRounds === 0`.

1. Verify the walkthrough exists; if it is missing, author it from the [walkthrough template](../dispatch-code-review/references/walkthrough-template.md), run the host verification command, and record the result.
2. Start the first orchestrated wave with walkthrough and plan paths, `targets`, `reserves`, `consensus: true|false`, `Review Scope: Full review`, and the code budget from the [Review contract](#review-contract). Re-resolve with the current exclusion set when plan review excluded a platform.
3. Await every target and reserve outcome, including report, fallback, or terminal failure, before adjudicating.

**Done when:** the walkthrough is attached, every launched review dispatch is settled, and round-one claims are ready for Step 6.

### 6. Apply Fixes & Settle Disputes

1. Verify each claim against the active code, requirements, and repository rules. Apply accepted fixes directly; record rejected or downgraded findings and their evidence in the walkthrough.
2. Update `## Changes Made`, `## Verification & Validation`, and `## Review Findings & Resolutions` after every accepted fix or ruling. Rewrite ruled `[Disputed]` lines as `[Resolved Dispute]` and settle pending lines per the Review contract.
3. Re-run the host verification command until green, or until two consecutive runs fail identically. Keep unrelated or persistent failures explicit in the walkthrough and handoff.
4. Resolve `[Disputed]` items through counter-evidence or user ruling. Under `consensus: true`, rejection or downgrade of a delegate-reported MUST-FIX or SHOULD-FIX remains `[Rejected — pending confirmation]` until the citing delegate confirms the counter-evidence. Delegate-reported `CONSIDER` findings follow `dispatch`'s `references/alignment.md` § Finality.

**Done when:** accepted fixes are applied, verification is green or its stable failure is recorded, and every review item has a logged status.

### 7. Re-Review Loop

1. While the [Review contract](#review-contract) keeps the loop live, invoke `dispatch-code-review` again with target affinity, the current exclusion set, changed lines, and pending rebuttals in `Review Scope`.
2. Apply Step 6 after each wave. At the round cap, ask the user to rule remaining disputes, write each ruling into the walkthrough, and grant the one additional verification wave defined by the Review contract.

**Done when:** `check-consensus.mjs` exits `0` on the walkthrough, or the user has ruled the remaining items and the extra verification wave is settled.

### 8. Handoff & Cleanup

Start handoff only after every target and reserve dispatch from every phase has a terminal outcome.

1. Run `check-consensus.mjs` on the walkthrough, or on the plan when code review was skipped. Exit `1` returns to Step 7; exit `2` halts cleanup.
2. Append `## Run Diagnostics` to the walkthrough or plan with:
   - scope classification, evaluated level, `flow.diagnostics.effectiveLevel`, and any scope shift;
   - artifact slug and `slugSource` (`explicit`, `branch`, or `conversation`);
   - rounds used versus `maxRounds`;
   - active, failed, substituted, dropped, excluded, unavailable, and clamped delegates, plus exclusion reasons;
   - accepted, rejected, downgraded, disputed, and rebutted findings, and verification status.
3. On a resolved run, relocate scratch artifacts:

   ```bash
   node <skills-dir>/dispatch/scripts/relocate-scratch.mjs "<plan path>" "<walkthrough path>"
   ```

   Retain artifacts in place when the run is unresolved or halted and state why.
4. Report diagnostics and the artifact path. Git operations, commits, pushes, branches, and pull requests remain outside this skill.

**Done when:** all review work is settled, diagnostics are appended, artifacts are relocated or their retention reason is recorded, and the handoff is delivered.

## Review contract

Apply this contract to Steps 3 and 5–7; use [`alignment.md`](../dispatch/references/alignment.md) for the full invocation and adjudication grammar.

- **Mechanical loop exit:** Continue while the prior wave changed the artifact or code, or an active `[Disputed]` / `[Rejected — pending confirmation]` line remains, and the phase is below `maxRounds`.
- **Pending confirmation:** With `consensus: true`, an orchestrator rejection or downgrade of a delegate-reported MUST-FIX or SHOULD-FIX uses `[Rejected — pending confirmation]`. Rewrite it to `[Rejected / Downgraded]` only after the citing delegate confirms the counter-evidence, or to `[Resolved Dispute]` after user ruling. Delegate `CONSIDER` findings are final at the orchestrator's ruling.
- **Ruling reset:** At the cap, a user ruling settles each escalated item and grants exactly one additional wave with a refreshed budget. A second cap ends the loop and escalates the unresolved result.
- **Target exclusion:** `[auth]` and `[quota]` remove a platform from later resolver runs; target affinity still narrows re-review to live citing delegates.
- **Budget:** Hand over `8 + 2 × <units under review>` tool turns per reviewer. A plan unit is a `## Proposed Changes` entry; a code unit is a changed file. Re-review counts only units changed since the previous wave.
