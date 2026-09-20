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
3. Author from the plan-review template. Group files by `[NEW]`/`[MODIFY]`/`[DELETE]`; write
   stable `[SC#]` criteria with indented `Changes:` and/or `Verify:` mappings.
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
Prepare plans authored in-run with `artifactOwned: true`. On `plan-lint`, repair every defect and
re-prepare without a user ask; this consumes neither a review round nor budget.
Re-review changed sections or live findings below the cap; at the cap obtain rulings and run one
final verification wave.

After consensus exit `0`, checkpoint from `checkpoint-preview`. Always prune manifest paths (invocation state after checkpoint/abort); report errors.

If decision-changing items exist, render the keyed opt-in sections before approval:
`### Recommended Follow-ups (Default: Included)` with `[R#] [x]` for unapplied accepted `SHOULD`/`CONSIDER` findings (carrying `application:` records), and `### Out-of-Scope / Adjacent Items (Default: Excluded)` with `[O#] [ ]` for verified adjacent/deferred items (or `none` when empty).
Parse user response with `node <skills-dir>/dispatch/scripts/fix-clustering.mjs --parse-opt-in`; on ambiguous or empty input, re-prompt before applying defaults.
Apply user response, materialize included recommendations into proposed changes, criteria, and verification mappings, and rerun plan-lint, flow resolution, and any required plan review before approval.

Reclassify the reviewed plan. Preserve explicit level; otherwise re-resolve changed scope. State
the exact phase/target/round/consensus delta or `Resolved flow unchanged after final scope check.`

**Done when:** plan consensus/checkpoint settle, opt-ins materialize, and flow matches scope.

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

Implement approved plan scope through a native subagent of `flow.implementation.platform`,
never inline: `claude` -> `general-purpose`, `opencode` -> `general`, `copilot` -> `general-purpose`
(`task` tool with `model` and `reasoning_effort`); `agy` defines no named agent types, so launch
its default subagent. All platforms follow configured `model` and `effort` supported by their
native launcher. When the resolved `model` is an array of model names, try the first model, falling
back to subsequent models in the list on quota or availability failure. Derive
`--implementation-fields` from that native launch tool's schema; default to model only. Pass
resolved fields explicitly and disclose ignored fields; missing models stop preflight. Preserve the
index/unrelated changes and inspect Git read-only. Trivial work alone may start on the host
platform.

Follow the [implementation delegate contract](references/implementation-delegate-contract.md):
parse one typed envelope and obey its transition. Native launches are non-resumable unless the
provider contract proves continuation. Delegates get at most three attempts (replacement, then one
distinct native tier); host-platform launches get two. Never cross providers or transfer failed
delegated work to the host platform. New/corrected behavior requires `RED_READY` and host-observed RED.

For multi-finding follow-ups or accepted fix groups, form independence clusters with
`node <skills-dir>/dispatch/scripts/fix-clustering.mjs --cluster` (pairwise disjoint paths, same-file
separate, union verification). Each cluster executes as a v1 ledger task (`task-start` with
deterministic cluster ID `C-<sha256[:12]>`, member path union, and attempt budget).
If a cluster fails, split recovery via `--split` retains completed clusters, sets `parentTaskId` on
descendants, and shares the remaining budget; total attempts across parent and descendants cannot
exceed three.

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
2. List accepted `adjacent` findings from plan and code rounds, if any, rendered as keyed opt-ins
   (`[O#] [ ] <summary> — <reason>`) and ask the user which to address. Selected items trigger the
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

When explicit direction or qualifying architectural evidence calls for phased work, author and settle a technical design through `dispatch-design-review`. Record approval and the next ready increment in the v2 design ledger, then stop at the durable `design-approved-stop` boundary. Increment execution, amendments, and integration remain unavailable until a later capability is delivered. Ordinary plans retain the v1 flow.
