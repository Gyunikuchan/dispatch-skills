---
name: implement-dispatch
description: Run a feature or fix through a plan, approval gate, implementation, verification, and multi-agent review loop.
disable-model-invocation: true
---

# implement-dispatch

Orchestrate `criteria → plan → review → approval → implementation → verification → handoff`.
`dispatch` is required; missing review companions disable that phase. Before reviews read
[review.md](../dispatch/references/review.md); on runner failure use [native fallback](../dispatch/references/providers.md#native-fallback).

## Invocation

```text
/implement-dispatch <level> (<pins>): <ask>
/implement-dispatch <plan-path>
/implement-dispatch <design-path>
```

Explicit `low|medium|high|xhigh|max` is preserved; otherwise classify mechanical edits `low`,
bounded changes `medium`, and cross-cutting/public-contract changes `high`. `xhigh`/`max` are
explicit only. Pass pins unchanged to `resolve-flow.mjs`.
Plan-path resumes only a canonical scratch plan. Design-path resumes a phased technical design under its durable ledger identity. Follow the
[ledger contract](../dispatch/references/verbs/implement.md#durable-execution-ledger) before dispatch;
for RED-quality and failure disposition, follow its [branch contract](../dispatch/references/verbs/implement.md#red-quality-and-failure-disposition).

## 1. Criteria, plan, and flow

1. Convert the ask into checkable success criteria and assumptions. Ask one focused question for
   each decision-changing ambiguity.
2. Resolve paths with `dispatch/scripts/resolve-artifact-paths.mjs`; host convention wins.
   Requests/reports go in OS temp. Establish an explicit slug matching the canonical plan filename
   when branch/conversation identity differs.
3. Author from the plan-review template. Group files by `[NEW]`/`[MODIFY]`/`[DELETE]`; write
   stable `[SC#]` criteria with indented `Changes:`, `Verify:`, exactly one `Evidence: red|verify|review`, and concrete `Test rationale:` mappings. `review` also names artifact, scenario, and observable pass condition.
4. Run:

   ```bash
   node <skills-dir>/dispatch/scripts/resolve-flow.mjs --platform <key> [--orchestrator-model <model>] [--level <level>] [--implementation-fields <model[,effort]>] [--pins <pins>] [--exclude <keys>] [--show-effective]
   ```

   State: `Resolved flow: level <level>; plan review <on|off> — <targets>, rounds <n>, consensus
   <on|off>; code review <on|off> — <targets>, rounds <n>, consensus <on|off>.` Use `provider
   default`, `native fallback`, or `off — companion unavailable` when applicable.

**Done when:** criteria map to a settled plan and disclosed flow.

## 2. Review the plan

Skip when disabled. Prepare an orchestrated full review with flow targets/reserves, round, consensus,
and budget.
Resolve `decision-required` only for in-run artifacts. Execute only manifest argv; await terminal
outcomes, use runner fallback, verify claims, apply findings, log rulings, and check consensus.
On `plan-lint`, repair every defect and
re-prepare without a user ask; this consumes neither a review round nor budget.
Re-review changed sections or live findings below the cap; at the cap obtain rulings and run one
final verification wave.

After consensus exit `0`, checkpoint from `checkpoint-preview`. Always prune manifest paths (invocation state after checkpoint/abort); report errors.

If decision-changing items exist, render the keyed opt-in sections before approval:
`### Recommended Follow-ups (Default: Included)` with `[R#] [x]` for unapplied accepted `SHOULD`/`CONSIDER` findings (carrying `application:` records), and `### Out-of-Scope / Adjacent Items (Default: Excluded)` with `[O#] [ ]` for verified adjacent/deferred items (or `none` when empty).
Parse user response with `node <skills-dir>/dispatch/scripts/fix-clustering.mjs --parse-opt-in`; on ambiguous or empty input, re-prompt before applying defaults.
Apply user response, materialize included recommendations into proposed changes, criteria, and verification mappings, and rerun plan-lint, flow resolution, and any required plan review before approval.

Reclassify the plan. Preserve explicit level; otherwise re-resolve scope. State the exact phase/target/round/consensus delta or `Resolved flow unchanged after final scope check.`

**Done when:** plan consensus/checkpoint settle, opt-ins materialize, and flow matches scope.

## 3. Baseline, approval, and implementation

Create the walkthrough before baseline verification using the shared
[minimum contract](../dispatch/references/review.md#minimum-walkthrough-contract), whether code review is enabled,
disabled, or unavailable. Follow the [verification evidence contract](../dispatch/references/verbs/implement.md#verification-evidence-contract)
for command/path extraction, baseline records, path classification, side-effect reconciliation,
red-baseline rulings, result identity, freshness, and the tests-only stage.

Run the baseline and reconcile its evidence before presenting approval. A red or unavailable
baseline is never green; record the user's proceed-or-fix ruling. Side-effect reconciliation
preserves caller-owned changes and production writes remain approval-gated.

Present the settled plan exactly once after baseline reconciliation; approval is required before
production writes. If it has a resolution log, only consensus exit `0` permits approval.
After approval, initialize and append the durable events in the
[ledger contract](../dispatch/references/verbs/implement.md#durable-execution-ledger). On resume, reconcile its fold before dispatch.

Implement approved plan scope through a native subagent of `flow.implementation.platform`,
never inline: `claude` -> `general-purpose`, `opencode` -> `general`, `copilot` -> `general-purpose`
(`task` tool with `model` and `reasoning_effort`); `agy` defines no named agent types, so launch
its default subagent. A resolved model array is a **launch cascade**: on a launch rejection
(model unavailability, authentication, quota) retry the next model with the same effort; a started
subagent ends the cascade. Record each entry as
`model <index>/<count> <name>; effort <value>; <launch-rejected: reason|started>`. Derive
`--implementation-fields` from the native launch tool's schema (default: model only), pass
resolved fields explicitly, and disclose ignored fields; missing models stop preflight. Preserve
the index/unrelated changes and inspect Git read-only. Trivial work alone may start on the host
platform.

Follow the [implementation delegate contract](../dispatch/references/verbs/implement.md#implementation-delegate-contract):
parse one typed envelope and obey its transition. Native launches are non-resumable unless the
provider contract proves continuation. Delegates get at most three attempts (replacement, then one
distinct native tier); host-platform launches get two. Never cross providers or transfer failed
delegated work to the host platform. Only `red` criteria require `RED_READY` and host-observed RED; no-red plans skip tests-only delegation, and mixed plans expose only red criteria and mapped paths.


Use independence clusters with deterministic `C-<sha256[:12]>` IDs for multi-finding fixes; split recovery sets `parentTaskId`, and no descendant attempt number exceeds three.

Run `node <skills-dir>/dispatch/scripts/implementation-outcome.mjs --parse <file|->`, then the same command
with `--transition <json-file|->`. A nonzero parse is a consumed malformed outcome; a nonzero
transition is orchestrator input error to fix without consuming an attempt.

After any scope growth, classify the new paths and re-run flow resolution: preserve explicit
levels and never downgrade an automatically resolved level. A final completion claim requires
fresh host output after the last mapped mutation and accepted fix. Record terminal failure with
envelope, verification, root-cause, and escalation evidence.

**Done when:** the governing outcome is implemented, every criterion maps delivered observable behavior to its owning production path and fresh class-appropriate evidence, final verification is passing or accepted `known red — unchanged`, and limitations/deviations are recorded. Green commands alone never complete work.

## 4. Review and settle code

Skip when disabled. Prepare `code-review:R1` with walkthrough, bounded plan evidence, resolved flow,
and budget; only in-run deterministic decisions may proceed. Launch as for plan review. Verify
claims, apply accepted fixes directly as orchestrator (inline without dispatching implementation
native subagents), log rulings, update the walkthrough, and reverify before consensus or another
bounded wave. Preserve source affinity; auth/quota exclusion re-resolves without renumbering. At
the cap, obtain rulings and run one final verification wave.

After every expected source is terminal and consensus exits `0`, checkpoint from
`checkpoint-preview`. Cleanup is finally-style; an unsettled/stable-failure run retains
the prior checkpoint.

**Done when:** accepted fixes are applied, verification is green or stably recorded, every finding
has a logged status, and settled freshness is checkpointed.

## 5. Handoff

1. Run final consensus on the walkthrough, or plan when code review was skipped. Exit `1` returns
   to its review loop; exit `2` halts.
2. Render both keyed opt-in sections: unapplied accepted `SHOULD`/`CONSIDER` findings as
   `[R#] [x]`, and accepted `adjacent` findings from plan and code rounds as
   `[O#] [ ] <summary> — <reason>`; state `none` without asking when both are empty, else ask which to address. Selected items trigger the
   one-way scope rule: re-resolve flow and implement them test-first as an adjacent-fix cluster with
   a fresh budget, verify, move them to `## Changes Made`, then run § 4 as a fresh scoped invocation
   through consensus/checkpoint and repeat step 1. Keep unchosen items in `## Follow-ups` (code) or
   `## Out of Scope` (plan). Without code review, defer them. Leave code and artifacts untouched
   after the final checkpoint.
3. Warn before relocation: `The resolved plan and walkthrough are moving to OS temp and may be
   deleted by the OS.` Relocate existing `.scratch/` artifacts with
   `dispatch/scripts/relocate-scratch.mjs`; report each exact destination. Retain unresolved/native
   artifacts and state why. Never relocate the ledger.
4. Report on the host's handoff structure when workspace rules define one; otherwise use plain
   sections. Add only what this flow contributes: diagnostics (level, rounds, finding totals,
   verification), destinations, canonical resume command, ledger path, and one `Rulings made` list.
   Satisfy host-required sections with run evidence and never duplicate a section the host already
   defines; include a suggested commit message unless the host prescribes its own. Git/PR
   publication remains caller-owned.

**Done when:** all review work is terminal and settled, every accepted `adjacent` finding was
offered, cleanup/relocation is explicit, and the handoff identifies every retained or moved
artifact.

## Review loop

- Continue after changed code/artifacts or live `[Disputed]` /
  `[Rejected — pending confirmation]` items while below `maxRounds`.
- `check-consensus.mjs`: exit `0` settles, `1` loops, `2` halts.
- Budget: `8 + 2 × units`; plan units are proposed-change entries, code units are changed files.
- Rebuttals use `build-rebuttal-packets.mjs` and only the finding's effective sources/replacements.

## Technical designs

When explicit direction or qualifying architectural evidence calls for phased work, author and
settle a technical design through `dispatch-design-review`, record approval and the next ready
increment in the v2 design ledger, then stop at the durable `design-approved-stop` boundary.
Ordinary plans retain the v1 flow.

`/implement-dispatch <design-path>` folds every valid ledger segment bound to the design's
normalized path and root slug, proves completed increments with ledger and Git evidence, and
derives exactly one `Next Action`: implement a named ready increment, resume an interrupted one,
resolve a named reconciliation or amendment, run final integration, or complete. Dispatch only
work the design graph, ledger fold, artifact checkpoints, and Git evidence prove ready; drift
enters reconciliation.

One increment per invocation: each runs this flow's §§ 1–5 (baseline before the first
dispatch, tests-only stage and host-observed RED for new behavior), updates `## Execution Status`,
closes with `run-complete`, and stops. Design-changing discoveries take the amendment path; the
last increment is followed by a separate final integration gate recorded in the
`integration-walkthrough`. Never relocate the ledger. Follow the
[technical-design contract](../dispatch/references/verbs/design.md) for increment binding, the adjacent-fix
exception, amendment transactions, and final integration.
