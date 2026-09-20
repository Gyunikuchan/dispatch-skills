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
/implement-dispatch <plan-path>
```

Explicit `low|medium|high|xhigh|max` is preserved; otherwise classify mechanical edits `low`,
bounded changes `medium`, and cross-cutting/public-contract changes `high`. `xhigh`/`max` are
explicit only. Pass pins unchanged to `resolve-flow.mjs`.
The level-less plan-path form resumes only a canonical scratch plan. Follow the
[ledger contract](references/ledger-contract.md) before any dispatch.

## 1. Criteria, plan, and flow

1. Convert the ask into checkable success criteria and assumptions. Ask one focused question for
   each decision-changing ambiguity.
2. Resolve paths with `dispatch/scripts/resolve-artifact-paths.mjs`; host convention wins.
   Requests/reports go in OS temp. Establish an explicit slug matching the canonical plan filename
   when branch/conversation identity differs.
3. Author from the plan-review template. Group files by `[NEW]`/`[MODIFY]`/`[DELETE]`; map every
   criterion to changes or verification.
4. Run:

   ```bash
   node <skill-path>/scripts/resolve-flow.mjs --platform <key> [--orchestrator-model <model>] [--level <level>] [--implementation-fields <model[,effort]>] [--pins <pins>] [--exclude <keys>] [--show-effective]
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
Re-review changed sections or live findings below the cap; at the cap obtain rulings and run one
final verification wave.

After consensus exit `0`, checkpoint from `checkpoint-preview`. Always prune manifest paths (invocation state after checkpoint/abort); report errors.

Reclassify the reviewed plan. Preserve explicit level; otherwise re-resolve changed scope. State
the exact phase/target/round/consensus delta or `Resolved flow unchanged after final scope check.`

**Done when:** plan consensus/checkpoint settle and flow matches scope.

## 3. Baseline, approval, and implementation

Create the walkthrough before baseline verification using the shared
[minimum contract](../dispatch/references/walkthrough-contract.md), whether code review is enabled
or unavailable. Follow the [verification evidence contract](references/verification-contract.md)
for command/path extraction, baseline records, path classification, side-effect reconciliation,
red-baseline rulings, result identity, freshness, and the tests-only stage.

Run the baseline and reconcile its evidence before presenting approval. A red or unavailable
baseline is never green; record the user's proceed-or-fix ruling. Side-effect reconciliation
preserves caller-owned changes and production writes remain approval-gated.

Present the settled plan exactly once after baseline reconciliation; approval is required before
production writes. If it has a resolution log, only consensus exit `0` permits approval.
After approval, initialize and append the durable events in the
[ledger contract](references/ledger-contract.md). On resume, reconcile its fold before dispatch.

Implement through a native subagent of `flow.implementation.platform`, never inline: `claude` ->
`general-purpose`, `opencode` -> `general`; `agy` and `copilot` define no named agent types, so
launch their default subagent. Derive `--implementation-fields` from that native launch tool's
schema; default to model only. Pass resolved fields explicitly and disclose ignored fields; missing
delegated Claude/OpenCode models stop preflight, while host-platform settings are compatibility
metadata. Preserve the index/unrelated changes and inspect Git read-only. Trivial work alone may
start on the host platform.

Follow the [implementation delegate contract](references/implementation-delegate-contract.md):
parse one typed envelope and obey its transition. Native launches are non-resumable unless the
provider contract proves continuation. Delegates get at most three attempts (replacement, then one
distinct native tier); host-platform launches get two. Never cross providers or transfer failed
delegated work to the host platform. New/corrected behavior requires `RED_READY` and host-observed RED.

Run `node <skill-path>/scripts/implementation-outcome.mjs --parse <file|->`, then the same command
with `--transition <json-file|->`. A nonzero parse is a consumed malformed outcome; a nonzero
transition is orchestrator input error to fix without consuming an attempt.

After any scope growth, classify the new paths and re-run flow resolution: preserve explicit
levels and never downgrade an automatically resolved level. A final completion claim requires
fresh host output after the last mapped mutation and accepted fix. Record terminal failure with
envelope, verification, root-cause, and escalation evidence.

**Done when:** approved scope is implemented, RED evidence or its allowed exception is recorded,
verification is passing, unavailable, or `known red — unchanged`, and the walkthrough describes
the active diff with fresh evidence.

## 4. Review and settle code

Skip when disabled. Prepare `code-review:R1` with walkthrough, bounded plan evidence, resolved flow,
and budget; only in-run deterministic decisions may proceed. Launch as for plan review. Verify
claims, apply fixes, log rulings, update the walkthrough, and reverify before consensus or another
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
2. List accepted `adjacent` findings from plan and code rounds, if any, and ask the user which to
   address. Implement chosen items test-first, verify, move them to `## Changes Made`, then run § 4
   as a fresh scoped invocation through consensus/checkpoint and repeat step 1. Keep unchosen items
   in `## Follow-ups` (code) or `## Out of Scope` (plan). Without code review, defer them. Leave
   code and artifacts untouched after the final checkpoint.
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
