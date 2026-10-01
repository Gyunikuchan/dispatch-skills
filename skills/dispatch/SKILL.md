---
name: dispatch
description: Coordinate independent reviews and bounded implementation across native agent platforms.
disable-model-invocation: true
---

# Dispatch

## Invocation

Parse `[level] [(pins)] [verb:] argument`. Default verb: `ask`. `design`, `plan`, and `implement` require an argument. `review` accepts an empty working-tree target; `.plan.md` and `.design.md` infer their review kinds, otherwise code. A user-written level is `explicit`; otherwise classify `low`, `medium`, or `high` and mark `classified`. `xhigh` and `max` require user selection. Pins `(a,b)`, `(3)`, and `(all)` select providers, count, or all configured targets. `-m` and `-e` map to `--model` and `--effort`. Report-only review is the default; map an explicit request to apply fixes to `--fix`.

## Run loop

1. Initialize this chat with `node <skills-dir>/dispatch/scripts/dispatch.ts session init --objective "<objective>"`. Persist returned `sessionDir` and `sessionId`; use `--session-id` for a fallback identity on later initialization. Reactivate a published folder with `session reactivate --session-dir <dir>` before later work.
2. Start with `start <verb> --session-dir <dir> --orchestrator <platform> --level <level> --level-source explicit|classified [--pins "(pins)"] [--fix] -- <argument>`. Keep the returned `run` path. Start/send emit one JSON frame; doctor emits a table or `--json` diagnostics.
3. Run `send --run <dir> [--event @<event-file>]` in the background, retain its handle, and wait for completion or a blocker. Match `await` below, reply once, and repeat until `done`. Eventless send resumes automatic work.

Before the selected branch, read [ask](references/verbs/ask.md), [design](references/verbs/design.md), [plan](references/verbs/plan.md), [review](references/verbs/review.md), or [implement](references/verbs/implement.md). For adjudication and disputes read [review rules](references/review.md); for provider availability, native mapping, or sandbox failures read [providers](references/providers.md). Terms live in [glossary](references/glossary.md).

## Await author

Author at `data.path` using `data.template`; resolve every defect against the governing outcome. Reply `AUTHORED` with `path` when complete.

## Await native

Launch every listed `data.slots` native subagent with its descriptor's prompt, model, reasoning effort, and attachments. Capture at each `outputPath`; verify native model mapping per providers. Reply once with `NATIVE_RESULTS` and `slots` containing `slot`, `outputPath`, and `sourceKey` where supplied.

## Await rule

Verify each finding against code and the governing outcome. Reply `RULINGS` with an object keyed by finding id: `accept`, `reject`, `downgrade`, or `needs-user`. Include reasons for rejection and downgrade; apply the recorded-decision and dispute rules in the review reference.

## Await fix

Apply accepted clusters only within each `affectedPaths`, run their bounded verification, and reply `FIXES_APPLIED` with cluster results. Adjacent changes require the driver's opt-in decision.

## Await write

Launch the configured native writer using the complete `briefPath` whose content matches `briefSha256`. Give it the expected `envelopePath` and scoped paths; preserve caller changes. Reply `WRITE_ENVELOPE` with `envelopePath` after its complete envelope arrives, or `WRITE_FAILED` with model, kind, and reason on a failed launch.

## Await evidence

Inspect the driver's command summary and logs; do not rerun already emitted gates. Independently establish every criterion and reply `EVIDENCE` with `criteria` keyed by id, each containing `outcome` and concrete `evidence`.

## Await decide

Answer the named `data.kind` using a listed option and its branch context. Production approval requires the user's actual quote, `{by:"user",quote:"..."}`. Escalate unresolved intent, concerns, drift, and failures to the user when required; recorded decisions cannot be invented. Reply `DECISION` with `kind` and `answer`.

## Await done

Report outcome, behavior, verification, concerns, and artifact location. Completion requires every criterion. Preserve the handoff folder for later work.

## Write boundaries and recovery

The driver owns journals, prompts, briefs, reports, and resolution sections. Host author/fix writes and native writers follow the frame's permission. Provider CLIs remain read-only. Preserve unrelated dirty and ignored files.

The journal is authoritative. After interruption run `status --run <dir>` to inspect progress and live worker claims, then `send --run <dir>` to replay and reattach. `send --dry-run` validates the proposed host event without locks, journal writes, rendering, or effects. Invalid host events reprint a frame with `error`; correct that event. Exit 1 is usage, 2 is an engine fault, 3 names the lock holder. A live lock requires waiting; recovery breaks only stale dead-process locks.
