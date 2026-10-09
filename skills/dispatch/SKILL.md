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
2. Start with `start <verb> --session-dir <dir> --orchestrator <platform> --level <level> --level-source explicit|classified [--pins "(pins)"] [--fix] -- <argument>`. Retain `run`. Start/send emit JSON.
3. Run `send --run <dir> [--event @<reply-path>]`, `start`, subagents, and long checks as separate background tasks; act on completion notices; rewrite rejected payloads in place. Follow frames with observed evidence and user quotes. Reply once per `await` until `done`; eventless send resumes automation.

Read the [verb guide](references/verbs/), [review rules](references/review-rules.md), and [providers](references/providers.md).

## Await author

Author at `data.path` with `data.template`; resolve defects against the governing outcome. Reply `AUTHORED` with `path`.

## Await native

Launch each `data.slots` subagent with its prompt, model, effort, and attachments. Capture `outputPath`; reply once with `NATIVE_RESULTS` and attested slot fields ([fields](references/providers.md)).

## Await rule

Verify findings against code and outcome. Reply `RULINGS` with finding-id `ruling` and scoped `fix`; explain rejection/downgrade and follow [review rules](references/review-rules.md).

## Await fix

Apply accepted clusters within `affectedPaths`, run bounded verification, and reply `FIXES_APPLIED`. Adjacent changes require opt-in.

## Await write

Launch native writers for each `launch` slot using its model, verified brief, envelope path, and worktree. In frame `events`, for task-scoped slots reply `WRITE_LAUNCHED` with each task's attempt, signature, host-assigned handle, and attested `model`/`effort`; task-scoped terminal receipts echo all three in `WRITE_ENVELOPE`, `WRITE_FAILED`, or `WRITE_CANCELLED`. Taskless hotfix receipts omit these identity fields. Before out-of-brief edits, writers request orchestrator adjudication. If agreed, journal and inform the user before resuming under the settled level; ask the user only when the orchestrator disagrees. During scope draining, report each original attempt's envelope, failure, or confirmed cancellation; launch no replacement yet.

## Await evidence

Inspect summaries/logs; do not rerun emitted gates. Verify criteria; reply `EVIDENCE` with id-keyed `outcome:"pass"` and concrete evidence.

## Await decide

Answer `data.kind` with a listed option. Production approval and manual completion require `{by:"user",quote:"..."}`. Assess the `gateScope`; for a higher explicit-level recommendation, ask the user to adopt or retain. The orchestrator approves or disagrees with scope proposals; disagreement goes to the user. Resolve drift under [change handling](references/change-handling.md); escalate changed intent. A `run-stop` choice ends the run. Rule verified concerns and RED exceptions as `by:"orchestrator"` with evidence; follow the recorded failure decision. Never invent decisions. Reply `DECISION` with `kind` and `answer`.

## Await retro

Follow `data.diagnostics.instruction`; reply `RETRO`.

## Await done

Report outcome, behavior, verification, concerns, rulings, and artifact links. If `data.diagnostics` exists, add one line with its `path` and the report's first top finding. Complete only when every criterion passes; preserve the handoff folder.

## Write boundaries and recovery

The driver owns journals and generated artifacts; writers follow frame permissions, provider CLIs stay read-only, and unrelated dirty or ignored files stay intact.

Session-root files: `manifest.json`, deliverable specs/designs/plans/walkthroughs/reports, optional `diagnostics.md`. Agent-created helpers/logs/intermediates/backups go in `.state/runs/NNN-<kind>/scratch/`; pre-run/shared work in `.state/scratch/`. Classify backups by purpose. Preserve supplied driver/scoped production paths.

The journal is authoritative. After interruption, inspect `status --run <dir>`, then `send --run <dir>` to replay/reattach. Validate events with `send --dry-run`. Exit codes: 1 usage, 2 engine fault, 3 lock holder. Wait on live locks; break only dead-process locks.
