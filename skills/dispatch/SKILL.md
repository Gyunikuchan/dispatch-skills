---
name: dispatch
description: Multi-agent planning, review, and implementation. Use only when explicitly invoked.
---

# Dispatch

## Invocation

Parse `[level] [(pins)] [verb:] argument`. Default verb: `ask`. `design`, `plan`, `implement` require an argument. `review` accepts an empty working-tree target; `.plan.md` and `.design.md` infer their review kinds, otherwise code. Classify omitted levels at invocation; implementation receives one more assessment before its first write, with no later reclassification. Retain an explicit level unless that assessment recommends higher; then ask the user to adopt or retain. See [level criteria](references/readme/configuration.md#understand-levels-and-pins). `xhigh` and `max` require user selection. Pins `(a,b)`, `(3)`, `(all)` select providers, count, or all configured targets. `-m`/`-e` map to `--model`/`--effort`. Map explicit fix requests to `--fix`; review is otherwise report-only.

Use `design` for multiple increments, `plan` for one coherent unit, `implement` for delivery. For mismatches, recommend and await user choice.

## Run loop

1. Initialize: `node <skills-dir>/dispatch/scripts/dispatch.ts session init --objective "<objective>"`. Persist `sessionDir`/`sessionId`; fallback identity: `--session-id`. Reuse: `session reactivate --session-dir <dir>`.
2. Start: `start <verb> --session-dir <dir> --orchestrator <platform> --level <level> --level-source explicit|classified [--pins "(pins)"] [--fix] -- <argument>`. Retain `run`. Start/send emit JSON.
3. Run `send --run <dir> [--event @<reply-path>]`, `start`, subagents, and long checks as separate background tasks; act on completion notices; rewrite rejected payloads in place. Follow frames with observed evidence and user quotes. Send one frame `events` object per `await` until `done`; eventless send resumes automation.

Read [verbs](references/verbs/), [review rules](references/review-rules.md), [providers](references/providers.md).

## Await author

Author `data.path` with `data.template`; resolve defects against governing outcome. Reply `AUTHORED` with `path`.

## Await native

Launch each `data.slots` subagent with its prompt, model, effort, and attachments. Capture `outputPath`; reply `NATIVE_RESULTS` with attested slot fields ([fields](references/providers.md)).

## Await rule

Read `data.findingsPath` when present; inline `data.findings` otherwise. Verify findings; send `RULINGS` before editing with scoped `fix`. Intent: `needs-user`, `accept`/`reject` with user `quote` or `by:orchestrator` and settled decision `reason`. User gate: changed intent, new external dependency or runtime prerequisite, discarded work. Follow [review rules](references/review-rules.md) for complete scope, rejection/downgrade, parked-receipt recovery.

## Await fix

Apply accepted clusters within `affectedPaths` via frame `writer`, verify, and reply `FIXES_APPLIED`. Adjacent changes require opt-in.

## Await write

Launch native writers per `launch` slot with its model, verified brief, envelope path, and worktree. Reply in frame `events` with `WRITE_RECEIPT` per writer: `status` `launched` (attempt, signature, host-assigned handle, attested `model`/`effort`), then `submitted` (`briefHash`), `failed`, or `cancelled`, echoing task identity. Taskless hotfix receipts omit identity fields. Relay a live writer's out-of-scope need as `REQUEST`; it keeps running. `AMEND` the plan; notify each affected running writer; relay each notice and regenerated brief. See [implement](references/verbs/implement.md).

## Await evidence

Inspect summaries/logs; do not rerun emitted gates. Reply `EVIDENCE` with id-keyed `outcome:"pass"` and criterion evidence.

## Await decide

Answer `data.kind` with a listed option. Production approval and manual completion require `{by:"user",quote:"..."}`. Assess the `gateScope`; for a higher explicit-level recommendation, ask the user to adopt or retain. Rule integration conflicts and writer requests as `by:"orchestrator"`; see [implement](references/verbs/implement.md) for answers and `AMEND`. Resolve drift under [change handling](references/change-handling.md); escalate changed intent. A `run-stop` choice ends the run. Rule verified concerns and RED exceptions as `by:"orchestrator"` with evidence; follow the recorded failure decision. Never invent decisions. Reply `DECISION` with `kind` and `answer`.

## Await retro

Follow `data.diagnostics.instruction`; reply `RETRO`.

## Await done

Report outcome, behavior, verification, concerns, rulings, artifact links. If `data.diagnostics` exists, add one line with its `path` and the report's first top finding. Complete only when every criterion passes; preserve the handoff folder.

## Write boundaries and recovery

The driver owns journals and generated artifacts; writers follow frame permissions, provider CLIs stay read-only, and unrelated dirty or ignored files stay intact.

Session-root files: `manifest.json`, deliverable specs/designs/plans/walkthroughs/reports, optional `diagnostics.md`. Agent-created helpers/logs/intermediates/backups go in `.state/runs/NNN-<kind>/scratch/`; pre-run/shared work in `.state/scratch/`. Classify backups by purpose. Preserve supplied driver/scoped production paths.

The journal is authoritative. After interruption, inspect `status --run <dir>`, then `send --run <dir>` to replay/reattach. `send --dry-run --event` validates (exit 1: invalid). Exit codes: 1 usage, 2 engine fault, 3 lock holder. Wait on live locks; break only dead-process locks.
