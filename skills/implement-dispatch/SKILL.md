---
name: implement-dispatch
description: Run a feature or fix through a plan, approval gate, implementation, verification, and multi-agent review loop.
disable-model-invocation: true
---

# implement-dispatch

Orchestrate `criteria → plan → review → approval → implementation → verification → handoff`.
`dispatch` is required; missing review companions disable only that phase. Before reviews read
[alignment.md](../dispatch/references/alignment.md); on runner failure use
[native fallback](../dispatch/references/providers.md#native-fallback).

## Invocation

```text
/implement-dispatch <level> (<pins>): <ask>
```

Explicit `low|medium|high|xhigh|max` is preserved; otherwise classify mechanical edits `low`,
bounded changes `medium`, and cross-cutting/public-contract changes `high`. `xhigh`/`max` are
explicit only. Pass pins unchanged to `resolve-flow.mjs`.

## 1. Criteria, plan, and flow

1. Convert the ask into checkable success criteria and assumptions. Ask one focused question for
   each decision-changing ambiguity.
2. Resolve paths with `dispatch/scripts/resolve-artifact-paths.mjs`; host convention wins.
   Requests/reports go in OS temp.
3. Author from the plan-review template. Group files by `[NEW]`/`[MODIFY]`/`[DELETE]`; map every
   criterion to changes or verification.
4. Run:

   ```bash
   node <skill-path>/scripts/resolve-flow.mjs --platform <key> [--orchestrator-model <model>] [--level <level>] [--pins <pins>] [--exclude <keys>] [--show-effective]
   ```

   State: `Resolved flow: level <level>; plan review <on|off> — <targets>, rounds <n>, consensus
   <on|off>; code review <on|off> — <targets>, rounds <n>, consensus <on|off>.` Use `provider
   default`, `native fallback`, or `off — companion unavailable` when applicable.

**Done when:** criteria are mapped, ambiguities settled, plan authored, and flow disclosed.

## 2. Review the plan

Skip when disabled. Send the plan-review preparation CLI an orchestrated full-review request with
flow targets/reserves, round, consensus, focus, and budget. Resolve
`decision-required` only from in-run authored artifacts; otherwise stop with its diagnostic.

Execute only manifest argv in the background, yield, and await every terminal outcome. Apply
native fallback for runner failures; configuration/integrity failures are terminal. Verify claims,
edit accepted findings into the plan, append source map/rulings, and run `check-consensus.mjs`.
While the artifact changed or findings remain live below the cap, prepare bounded full/rebuttal
waves for affected sources. At the cap, obtain user rulings and run one final verification wave.

After consensus exit `0`, checkpoint with terminal source keys and exact settled plan-section
writes. Prune finished manifest paths on every success/failure path; report cleanup errors.

Reclassify the reviewed plan. Preserve explicit level; otherwise re-resolve changed scope. State
the exact phase/target/round/consensus delta or `Resolved flow unchanged after final scope check.`

**Done when:** plan consensus/checkpoint settle and flow matches scope.

## 3. Approval and implementation

Present the final plan exactly once; approval is required before writes. If it has a resolution log,
only consensus exit `0` permits approval.

Implement test-first using `flow.implementation.platform`: `claude` -> `general-purpose`, `agy` or
`copilot` -> `self`, `opencode` -> `general`. Trivial or failed delegated work stays with the
orchestrator. Preserve the index/unrelated changes and inspect Git read-only.

Run the host verify command until green. After two identical failures, stop and record the stable
failure. Ensure the baseline walkthrough exists when code review is enabled.

**Done when:** approved scope is implemented, verification is green/unavailable/stably recorded,
and the walkthrough describes the active diff.

## 4. Review and settle code

Skip when disabled. Prepare `code-review:R1` with walkthrough, bounded plan evidence, flow
targets/reserves, consensus, and budget. Resolve only in-run deterministic
`decision-required` states; otherwise stop before dispatch.

Launch/yield/wait as for plan review. Verify claims against code; apply accepted fixes, log rulings,
update the walkthrough, and reverify green before consensus or a next wave. Loop bounded
full/rebuttal waves while code changed or findings stay live. Preserve affinity/candidate IDs;
auth/quota exclusion re-resolves without renumbering. At the cap, obtain rulings and run one final
verification wave.

After every expected source is terminal and consensus exits `0`, checkpoint exact settled code
paths and walkthrough sections. Cleanup is finally-style; an unsettled/stable-failure run retains
the prior checkpoint.

**Done when:** accepted fixes are applied, verification is green or stably recorded, every finding
has a logged status, and settled freshness is checkpointed.

## 5. Handoff

1. Run final consensus on the walkthrough, or plan when code review was skipped. Exit `1` returns
   to its review loop; exit `2` halts.
2. List accepted `adjacent` findings from plan and code rounds, if any, and ask the user which to
   address. Treat the chosen ones as a follow-up ask: implement test-first, verify, move them into
   the walkthrough's `## Changes Made`, then run § 4 as a fresh orchestrated code-review invocation
   scoped to those fixes with its own round cap, through its consensus and checkpoint; offer its own `adjacent` findings the same way, then repeat step 1. Unchosen
   ones stay where review recorded them: the walkthrough's `## Follow-ups` (code) or the plan's
   `## Out of Scope` (plan). With code review disabled, list the findings as deferred and skip the
   follow-up cycle. Leave code and artifacts untouched after the final checkpoint.
3. Warn before relocation: `The resolved plan and walkthrough are moving to OS temp and may be
   deleted by the OS.` Relocate existing `.scratch/` artifacts with
   `dispatch/scripts/relocate-scratch.mjs`; report each exact destination. Retain unresolved/native
   artifacts and state why.
4. Report one diagnostics line (level, rounds, finding totals, verification), destinations, and a
   suggested commit message. Git/PR publication remains caller-owned.

**Done when:** all review work is terminal and settled, every accepted `adjacent` finding was
offered, cleanup/relocation is explicit, and the handoff identifies every retained or moved
artifact.

## Review loop

- Continue after changed code/artifacts or live `[Disputed]` /
  `[Rejected — pending confirmation]` items while below `maxRounds`.
- `check-consensus.mjs`: exit `0` settles, `1` loops, `2` halts.
- Budget: `8 + 2 × units`; plan units are proposed-change entries, code units are changed files.
- Rebuttals use `build-rebuttal-packets.mjs` and only the finding's effective sources/replacements.
