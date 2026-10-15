---
name: dispatch
description: Multi-agent planning, review, implementation. Use only when explicitly invoked.
---

# Dispatch

## Invocation

Parse `[level] [(pins)] [verb:] argument` (default `ask`). `design`, `plan`, and `implement` need an argument; empty `review` targets the working tree. `.plan.md` and `.design.md` infer review kind; other targets use code. Classify omitted levels at invocation; implementation receives one more assessment before its first write, with no later reclassification. Keep levels unless assessed higher; ask the user to adopt or retain. See [level criteria](references/readme/configuration.md#understand-levels-and-pins). Require user selection for `xhigh` and `max`. Pins `(a,b)`, `(3)`, `(all)` select providers, count, or all configured targets. `-m`/`-e` map to `--model`/`--effort`.

Use `design` for increments, `plan` for one unit, `implement` for delivery; await user choice on mismatches.

## Run loop

1. Initialize: `node <skills-dir>/dispatch/scripts/dispatch.ts session init --objective "<objective>"`. Retain `sessionDir`/`sessionId`; fallback: `--session-id`. Reuse: `session reactivate --session-dir <dir>`.
2. Start: `start <verb> --session-dir <dir> --orchestrator <platform> --level <level> --level-source explicit|classified [--pins "(pins)"] -- <argument>`. Retain `run`.
3. Run `send --run <dir> [--event @<reply-path>]`, `start`, subagents, and long checks as background tasks; act on completion notices; rewrite rejected payloads in place. Follow frames with evidence and user quotes. Send one frame `events` object per `await` until `done`; eventless send resumes automation. [Change handling](references/change-handling.md) governs advisory observations and optional dispositions.

When any step creates a worktree, follow [worktree cleanup](references/worktree-cleanup.md).

Read [verbs](references/verbs/), [review rules](references/review-rules.md), [providers](references/providers.md).

## Await author

Author `data.path` with `data.template`; resolve defects against governing outcome. Reply `AUTHORED` with `path`.

## Await native

`REVIEW_USE` selects [review applicability](references/review-rules.md#review-provenance-and-applicability). Launch each `data.slots` subagent with its prompt, model, effort, and attachments. Reply `NATIVE_RESULTS` with attested slot fields ([fields](references/providers.md)).

## Await rule

`REVIEW_USE` selects applicability. Read `data.findingsPath` or inline findings; verify and send `RULINGS` before scoped edits. Intent: `needs-user`, `accept`/`reject` with user `quote` or `by:orchestrator` and settled decision `reason`. User gates: changed intent, new external dependency or runtime prerequisite, discarded work. Follow [review rules](references/review-rules.md) for fix scope and rulings.

## Await fix

`REVIEW_USE` selects applicability. Apply accepted clusters within `affectedPaths` via frame `writer`, verify; reply `FIXES_APPLIED`. Adjacent changes require opt-in.

## Await write

Launch native writers per `launch` slot with its model, verified brief, envelope path, and worktree. Reply in frame `events` with `WRITE_RECEIPT` per writer: `status` `launched` (attempt, signature, host-assigned handle, attested `model`/`effort`), then `submitted` (`briefHash`), `failed`, or `cancelled`, echoing task identity. Taskless hotfix receipts omit identity fields. Relay a live writer's out-of-scope need as `REQUEST`; it keeps running. `AMEND` or `REPLACE_PLAN` reconciles the plan; notify each affected running writer; relay each notice and regenerated brief. See [implement](references/verbs/implement.md).

## Await evidence

Inspect summaries/logs; do not rerun emitted gates. Send `EVIDENCE` with id-keyed `outcome:"pass"` and criterion evidence.

## Await decide

Answer `data.kind` with a listed option. Never invent decisions. Production approval and manual completion require `{by:"user",quote:"..."}`. Assess the `gateScope`; for a higher explicit-level recommendation, ask the user to adopt or retain. Rule integration conflicts and writer requests as `by:"orchestrator"`; see [implement](references/verbs/implement.md) for answers and `AMEND`. Use `REPLACE_PLAN` for replacement or `REVIEW_USE` for applicability; [change handling](references/change-handling.md) governs collisions. A `run-stop` choice ends the run. Rule verified concerns and RED exceptions as `by:"orchestrator"` with evidence; follow recorded failure decisions. Reply `DECISION` with `kind` and `answer`.

## Await retro

Follow `data.diagnostics.instruction`; reply `RETRO`.

## Await done

[Clean worktrees](references/worktree-cleanup.md). Report outcome, behavior, verification, concerns, rulings, artifact links. If `data.diagnostics` exists, add one line with its `path` and the report's first top finding. Complete only when every criterion passes and owned worktrees are cleaned; preserve the handoff folder.

## Write boundaries and recovery

The driver owns journals and generated artifacts; writers follow frame permissions, provider CLIs stay read-only, and unrelated dirty or ignored files stay intact.

Session-root files: `manifest.json`, deliverable specs/designs/plans/walkthroughs/reports, optional `diagnostics.md`. Agent-created helpers/logs/intermediates/backups go in `.state/runs/NNN-<kind>/scratch/`; pre-run/shared work in `.state/scratch/`. Preserve supplied paths; classify backups by purpose.

After stop, failure, or interruption, follow [worktree cleanup](references/worktree-cleanup.md). The journal is authoritative. Inspect `status --run <dir>`; follow [checkpoint/rebind recovery](references/change-handling.md#checkpoints-and-runtime-continuation) before resuming uncertain effects. `send --dry-run --event` validates (exit 1: invalid). Exit codes: 1 usage, 2 engine fault, 3 lock holder. Wait on live locks; break only dead-process locks.
