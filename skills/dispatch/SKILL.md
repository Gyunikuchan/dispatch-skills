---
name: dispatch
description: Multi-agent planning, review, and implementation. Use only when explicitly invoked.
---

# Dispatch

## Invocation

Parse `[level] [(pins)] [verb:] argument`. Default verb: `ask`. `design`, `plan`, and `implement` require an argument. `review` accepts an empty working-tree target; `.plan.md` and `.design.md` infer their review kinds, otherwise code. Classify omitted levels at invocation; implementation receives one more assessment before its first write, with no later reclassification. Retain an explicit level unless that assessment recommends higher; then recommend the change and wait for the user to adopt or retain. See [level criteria](references/readme/configuration.md#understand-levels-and-pins). `xhigh` and `max` require user selection. Pins `(a,b)`, `(3)`, and `(all)` select providers, count, or all configured targets. `-m` and `-e` map to `--model` and `--effort`. Report-only review is default; map an explicit request to apply fixes to `--fix`.

Use `design` for multiple increments, `plan` for one coherent unit, and `implement` for delivery. If mismatched, recommend a fit and wait for user choice; never switch silently.

## Run loop

1. Initialize with `node <skills-dir>/dispatch/scripts/dispatch.ts session init --objective "<objective>"`. Persist `sessionDir` and `sessionId`; use `--session-id` as a fallback identity. Retain the folder with `session reactivate --session-dir <dir>`.
2. Start with `start <verb> --session-dir <dir> --orchestrator <platform> --level <level> --level-source explicit|classified [--pins "(pins)"] [--fix] -- <argument>`. Keep the returned `run` path. Start/send emit JSON; doctor emits a table or `--json` diagnostics.
3. Run `send --run <dir> [--event @<reply-path>]` in the background; keep its handle until done or blocked; rewrite rejected payloads in place. Follow frames with observed evidence and user quotes. Reply once per `await` until `done`; eventless send resumes automation.

Read the selected [verb guide](references/verbs/). Use [review rules](references/review-rules.md), [providers](references/providers.md), and the [glossary](references/glossary.md) as needed.

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

Inspect command summaries and logs; do not rerun emitted gates. Verify each criterion and reply `EVIDENCE` with id-keyed `outcome:"pass"` results and concrete evidence.

## Await decide

Answer `data.kind` with a listed option. Production approval and manual completion require `{by:"user",quote:"..."}`. Assess the exact `gateScope`; for a higher explicit-level recommendation, ask the user to adopt or retain. The orchestrator approves or disagrees with scope proposals; disagreement goes to the user. A `run-stop` choice ends the run. Rule verified concerns and RED exceptions as `by:"orchestrator"` with evidence; escalate intent changes, drift, and failures. Never invent decisions. Reply `DECISION` with `kind` and `answer`.

## Await done

Report outcome, behavior, verification, concerns, rulings, and artifact links. Complete only when every criterion passes; preserve the handoff folder.

## Write boundaries and recovery

The driver owns journals and generated artifacts; writers follow frame permissions, provider CLIs stay read-only, and unrelated dirty or ignored files stay intact.

The journal is authoritative. After interruption, inspect `status --run <dir>`, then run `send --run <dir>` to replay and reattach. `send --dry-run` validates events; correct rejected events. Exit 1 is usage, 2 an engine fault, 3 a lock holder. Wait on live locks; break only dead-process locks.
