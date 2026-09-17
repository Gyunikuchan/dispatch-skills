---
name: implement-dispatch
description: Run a feature or fix through a plan, approval gate, implementation, verification, and multi-agent review loop.
disable-model-invocation: true
---

# implement-dispatch

Orchestrate `setup → plan → scope → plan review → rescope → approval → implementation → verification → code review → handoff`.
Companion skills own runner behavior, review criteria, and templates.

| Dependency | Role | If unavailable |
|---|---|---|
| `dispatch` | Required runner, fallback, and provider integration | Stop and report the missing prerequisite |
| `dispatch-plan-review` | Optional plan template, review, and adjudication | Skip Step 4's review waves |
| `dispatch-code-review` | Optional walkthrough template, review, and adjudication | Skip Steps 7–9 and record diagnostics on the plan |

**Review wave.** Before the first plan or code review wave, read [`dispatch`'s alignment contract](../dispatch/references/alignment.md). It owns orchestrated handover, reserve substitution, adjudication, finding grammar, and artifact lifecycle.

**Review failure.** Apply [`dispatch`'s native fallback contract](../dispatch/references/providers.md#native-fallback): configuration and integrity errors are terminal; runner failures use its read-only fallback, never Step 6's write subagent.

## Invocation

```text
/implement-dispatch <level> (<pins>): <ask>
```

`<level>` and `(<pins>)` are optional; use the colon when either is present.

- `<level>`: `low`, `medium`, `high`, `xhigh`, or `max`. Without one, choose `low`, `medium`, or `high` from scope. `xhigh` and `max` are explicit only.
- `(<pins>)`: use `dispatch`'s named-platform, count, or `all` grammar. Pass it unchanged to `resolve-flow.mjs`; named platforms all run when configured, while a count or `all` selects from configured order with the orchestrator platform and exact orchestrator model shifted back. Pins change reviewer breadth, not the selected level.

Map a mechanical low-risk edit to `low`, a bounded feature or fix to `medium`, and a cross-cutting change, complex refactor, or public contract to `high`. Pins without a level preserve automatic selection.

## Process

### 1. Setup

1. Convert the ask into checkable success criteria. Fold settled decisions from a preceding interview directly into the criteria and assumptions.
2. Resolve plan and walkthrough paths. A named `AGENTS.md` / `CLAUDE.md` path wins; otherwise run:

   ```bash
   node <skills-dir>/dispatch/scripts/resolve-artifact-paths.mjs
   ```
3. Initialize the content-free run record:

   ```bash
   node <skills-dir>/implement-dispatch/scripts/run-record.mjs init
   ```

   Keep its absolute `runDir` outside the worktree. Allocate one new `<runDir>/<slot>.json`
   metrics path for each review target or reserve dispatch; native in-process fallbacks are
   substitution diagnostics, not dispatch slots.

**Done when:** the criteria and assumptions are written, both artifact paths are resolved, and the
run directory is initialized.

### 2. Author Plan

1. Draft the plan at the resolved path. Use the [plan template](../dispatch-plan-review/references/plan-template.md) when `dispatch-plan-review` is installed; otherwise include `## Key Decisions & Context`, `## User Review Required`, `## Open Questions & Assumptions`, `## Proposed Changes`, `## Rollback & Blast Radius`, `## Verification Plan`, and `## Out of Scope`.
2. **Clarification loop:** inspect the draft for every ambiguity with multiple viable answers that would change scope, behavior, design, verification, rollback, or boundaries. Ask one focused `ask_user` question at a time. After each answer, update the affected decision, assumption, proposed change, verification step, or boundary; remove the answered question; then inspect the revised draft again.
3. Make the result self-contained for external reviewers. Group changes by file, tag each `[NEW]`, `[MODIFY]`, or `[DELETE]`, and map every success criterion to a proposed change or verification step.

**Done when:** the populated plan exists, no decision-changing clarification is unanswered, every answer is incorporated, and every success criterion has a change or verification mapping.

### 3. Initial Scope & Flow

1. Classify the draft as `trivial`, `focused`, or `cross-cutting`, mapping to `low`, `medium`, or `high`. Preserve an explicit level; otherwise this is the initial automatic level.
2. Resolve the execution flow:

   ```bash
   node <skills-dir>/implement-dispatch/scripts/resolve-flow.mjs --platform <key> [--orchestrator-model <model>] [--level <level>] [--pins <pins>] [--exclude <keys>]
   ```

   Use the orchestrator provider key for `--platform`, pass `--orchestrator-model` only when explicitly requested, and save the JSON output as `flow`. Treat resolver integrity and configuration diagnostics as terminal and relay them verbatim.
3. State the resolved flow immediately without asking for confirmation:
   `Resolved flow: level <level>; plan review <on|off> — <platform/model or native fallback>,
   rounds <n>, consensus <on|off>; code review <on|off> — <platform/model or native fallback>,
   rounds <n>, consensus <on|off>.` Name omitted models as `provider default` and missing optional
   review skills as `off — companion unavailable`.

**Done when:** the initial scope and level are classified from the draft, `flow` is loaded, and the
resolved flow is disclosed.

### 4. Plan Review Loop

Skip this step when `dispatch-plan-review` is absent or `flow['plan-review'].maxRounds === 0`. If enabled with empty `targets`, run one in-process read-only fallback for the first wave and record the substitution.

1. Start the first orchestrated wave with `roundId=plan-review:R1`, `Review Mode: full`, the plan
   path, `targets`/`reserves` (including `candidateId`), `consensus: true|false`,
   `Review Scope: Full review`, one unique metrics path per dispatch, and the plan budget.
2. Await every outcome. Adjudicate claims, apply accepted changes, then append the enriched finding
   entries and structured source map under `## Review Findings & Resolutions`.
3. While the [Review contract](#review-contract) keeps the loop live, generate a bounded view and
   re-review only with delegates that have live findings:

   ```bash
   node <skills-dir>/implement-dispatch/scripts/build-review-view.mjs \
     --artifact "<plan path>" --next-round <n> --temp-out
   ```

   Run `check-consensus.mjs --json`, collect explicit verdict/counter-evidence/excerpts for its
   unsettled keys, and build source-grouped packets:

   ```bash
   node <skills-dir>/implement-dispatch/scripts/build-rebuttal-packets.mjs \
     --artifact "<plan path>" --context "<context.json|->" --temp-out
   ```

   Invoke `dispatch-plan-review` with `Review Mode: rebuttal`, separate canonical/view paths, and
   each source's packet. Remove the view, packet, prompt, and report temp directories after the
   wave settles.
4. After all launched outcomes are adjudicated, run:

   ```bash
   node <skills-dir>/implement-dispatch/scripts/check-consensus.mjs <plan path>
   ```

   Exit `0` advances; exit `1` returns to the loop; exit `2` halts.

**Done when:** review is skipped, `check-consensus.mjs` exits `0`, or every item is user-ruled at the round cap and the resulting extra verification wave is settled.

### 5. Final Scope & Flow

1. Reclassify the final plan after review, including every accepted finding. Recompute an automatic level; preserve an explicit level.
2. If the level changed, re-run `resolve-flow.mjs` with the orchestrator, pins, and exclusions, then replace `flow`. Relay terminal diagnostics verbatim. Record the initial and final scope/level for handoff.
3. Before approval, state the exact phase/target/round/consensus delta when final re-scope changed
   `flow`; otherwise state `Resolved flow unchanged after final scope check.`

**Done when:** the final scope and level are settled and `flow` reflects that final level.

### 6. Implement

**Approval gate:** Present the final plan exactly once. If it contains `## Review Findings & Resolutions`, run `check-consensus.mjs` first; only exit `0` permits approval. Write code only after approval.

1. For `trivial` scope, or when the implementation subagent fails, implement in the orchestrator. When code review is enabled, author the baseline walkthrough from its [template](../dispatch-code-review/references/walkthrough-template.md).
2. For `focused` or `cross-cutting` scope, dispatch test-first to the native write subagent selected by `flow.implementation.platform` (`claude` → `general-purpose`; `agy` and `copilot` → `self`; `opencode` → `general`). Pass the plan, `model`/`effort` hints, and the walkthrough path and template when code review is enabled. Otherwise, record diagnostics on the plan.
3. Use only read-only Git inspection (`git status`, `git diff`, `git log`, `git show`) while implementing; preserve the index and unrelated worktree changes so user edits and scratch artifacts survive. Hand this guard to any write subagent.
4. Run the host repository's declared verification command until green. If none exists, record that fact; after two identical failures, stop and record the stable failure.

**Done when:** the approved changes are complete, host verification is green, unavailable, or recorded as a stable failure, and the baseline walkthrough exists whenever the code-review phase is enabled.

### 7. Code Review

Skip Steps 7–9 when `dispatch-code-review` is absent or `flow['code-review'].maxRounds === 0`. If enabled with empty `targets`, run one in-process read-only fallback for the first wave and record the substitution.

1. Ensure the walkthrough exists; if missing, author it from the [walkthrough template](../dispatch-code-review/references/walkthrough-template.md), run host verification, and record the result.
2. If the plan contains review rounds, generate a bounded plan projection with
   `build-review-view.mjs`; never attach its canonical source-map session handles. Start the first
   orchestrated wave with `roundId=code-review:R1`, `Review Mode: full`, walkthrough/bounded-plan
   paths, `targets`/`reserves` including `candidateId`, `consensus: true|false`,
   `Review Scope: Full review`, one unique metrics path per dispatch, and the code budget.
3. Await every target and reserve outcome before adjudicating.

**Done when:** the walkthrough is attached, every launched review dispatch is settled, and round-one claims are ready for Step 8.

### 8. Apply Fixes & Settle Disputes

1. Verify each claim against the active code, requirements, and repository rules. Apply accepted fixes directly; record rejected or downgraded findings and their evidence in the walkthrough.
2. Update `## Changes Made`, `## Verification & Validation`, and `## Review Findings & Resolutions` after each fix or ruling. Rewrite ruled `[Disputed]` lines as `[Resolved Dispute]`.
3. Re-run the host verification command using Step 6's stop rule. Keep unrelated or persistent failures explicit in the walkthrough and handoff.
4. Resolve `[Disputed]` and `[Rejected — pending confirmation]` items through the [Review contract](#review-contract).

**Done when:** accepted fixes are applied, verification is green or its stable failure is recorded, and every review item has a logged status.

### 9. Re-Review Loop

1. While the loop is live, build a bounded walkthrough view, run `check-consensus.mjs --json`, and
   create source-grouped packets with `build-rebuttal-packets.mjs`. Invoke `dispatch-code-review`
   with `Review Mode: rebuttal`, canonical/view/packet paths, and the packet's effective source.
   When plan evidence is required, generate and attach a separate bounded plan view; never attach a
   canonical artifact containing source-map session handles. Remove all returned temp paths after
   the wave settles.
2. Apply Step 8 after each wave, then run `check-consensus.mjs` on the walkthrough. Exit `0` settles the loop; exit `1` continues it; exit `2` halts.
3. At the cap, obtain user rulings and run the contract's one additional verification wave.

**Done when:** `check-consensus.mjs` exits `0` on the walkthrough, or the user has ruled the remaining items and the extra verification wave is settled.

### 10. Handoff & Cleanup

Begin only after every plan and code review dispatch has a terminal outcome.

1. Run `check-consensus.mjs` on the walkthrough, or on the plan when code review was skipped. Exit `1` returns a walkthrough to Step 9 or a plan to Step 4 when plan review is enabled, without repeating Step 5 or the approval gate; otherwise halt and report the unsettled artifact. Exit `2` halts cleanup.
2. Append `## Run Diagnostics` to the walkthrough or plan with:
   - initial and final scope classifications, evaluated level, `flow.diagnostics.effectiveLevel`, and any scope or level shift;
   - artifact slug and `slugSource` (`explicit`, `branch`, or `conversation`);
   - rounds used versus `maxRounds`;
   - active, failed, substituted, dropped, excluded, unavailable, and clamped delegates, plus
     candidate/source keys, `substitutesFor`, and exclusion reasons;
   - accepted, rejected, downgraded, disputed, and rebutted findings, and verification status.
3. Finalize the content-free record with the number of `dispatch` slots actually launched and a
   JSON summary carrying levels, waves, finding totals, and substitutions:

   ```bash
   node <skills-dir>/implement-dispatch/scripts/run-record.mjs finalize \
     --run-dir "<runDir>" --expected-slots <count> --summary -
   ```

   `expectedSlots` is the number of `dispatch` slots actually launched, including slots that
   failed after accepting their metrics destination; native in-process fallbacks are not slots.
   On a count mismatch, keep the artifacts unresolved, inspect the named run directory for the
   missing slot, and rerun that review slot with a fresh metrics path before finalizing again.
4. On a resolved run, warn before relocation:
   `The resolved plan and walkthrough are moving to OS temp and may be deleted by the OS.`
   Pass only existing `.scratch/` artifacts to the relocator; retain and report native artifact
   paths unchanged.

   ```bash
   node <skills-dir>/dispatch/scripts/relocate-scratch.mjs "<plan path>" "<walkthrough path>"
   ```

   Retain unresolved artifacts in place and state why.
5. Report diagnostics, durable run-record path, and artifact path. Leave commits, pushes, branch changes, and pull requests to the caller.

**Done when:** all review work is settled, diagnostics are appended, the ephemerality warning
precedes relocation, every moved destination or retained native path is reported, and the handoff
is delivered.

## Review contract

Apply this contract to Steps 4 and 7–9; use [`alignment.md`](../dispatch/references/alignment.md) for the full invocation and adjudication grammar.

- **Mechanical loop exit:** Continue while the prior wave changed the artifact or code, or an active `[Disputed]` / `[Rejected — pending confirmation]` line remains, and the phase is below `maxRounds`.
- **Pending confirmation:** With `consensus: true`, rejection/downgrade of `MUST` or `SHOULD` uses
  `[Rejected — pending confirmation]`. It closes only after every reachable citing source returns
  `CONFIRM`; `REBUT` keeps it live and `INTENT-DISPUTE` changes it to `[Disputed]`. `CONSIDER`
  follows `dispatch`'s `references/alignment.md` § Finality.
- **Ruling reset:** At the cap, a user ruling settles each escalated item and grants exactly one additional wave with a refreshed budget. A second cap ends the loop and escalates the unresolved result.
- **Target exclusion:** On `[auth]` or `[quota]`, exclude the platform and re-resolve without
  renumbering surviving `candidateId` values. Resume each citing source when supported; otherwise
  freshly dispatch its effective candidate. If unavailable, use a recorded replacement reviewer
  with `substitutesFor` before escalating.
- **Budget:** Hand over `8 + 2 × <units under review>` tool turns per reviewer. A plan unit is a `## Proposed Changes` entry; a code unit is a changed file. Re-review counts only units changed since the previous wave.
