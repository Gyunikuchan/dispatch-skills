---
name: dispatch
description: Multi-agent planning, review, implementation. Use only when explicitly invoked.
---

# Dispatch

## Invocation

Parse `[level] [(pins)] [verb:] argument`; default to `ask`. `design`/`plan`/`implement` need arguments; empty `review` targets the working tree. `.plan.md` and `.design.md` infer review kind; other targets use code. Classify omitted levels at invocation; implementation receives one more assessment before its first write, with no later reclassification. Keep levels unless assessed higher; ask users to adopt or retain. See [level criteria](references/readme/configuration.md#understand-levels-and-pins). Require user-selected `xhigh`/`max`. Pins `(a,b)`, `(3)`, `(all)` select providers/count/all. `-m`/`-e` map to `--model`/`--effort`.

Use `design` for increments, `plan` for one unit, `implement` for delivery; clarify mismatches.

## Run loop

1. Initialize: `node <skills-dir>/dispatch/scripts/dispatch.ts session init --objective "<objective>"`. Retain `sessionDir`/`sessionId`; fallback: `--session-id`. Reuse: `session reactivate --session-dir <dir>`.
2. Start: `start <verb> --session-dir <dir> --orchestrator <platform> --level <level> --level-source explicit|classified [--pins "(pins)"] -- <argument>`. Retain `run`.
3. Run `send --run <dir> [--event @<reply-path>]`, `start`, subagents, and long checks as background tasks; act on completion notices. Correct rejected payloads; supply evidence/quotes. Send one frame `events` object per `await` until `done`; eventless send resumes automation. [Change handling](references/change-handling.md) governs advisory observations and optional dispositions.

When any step creates a worktree, follow [worktree cleanup](references/worktree-cleanup.md).

Read [verbs](references/verbs/), [rules](references/review-rules.md), [providers](references/providers.md).

## Quality inputs

Read applicable host rules first for authoring, writer delegation, and each finding ruling; authors obey `data.read`. Before review/writer work, orchestrator directly reads [quality bar](references/templates/quality-bar.md) sections selected by `qualitySections` in `scripts/domain/prompt.ts` (review kind or writer; no prose map).

## Governing spec

Author/approve/revise/redirect specs via [spec operation](references/spec-stage.md). `SPEC_REVISED` follows [revision admission](references/spec-stage.md#revision-protocol). While active, other planning skills, including brainstorming, write spec/design output to the resolved canonical spec; new specs use `<session>/<slug>.spec.md`. Follow merge/deletion gates; edit no managed skill.

## Await author

Before design/plan drafting, read the whole spec and every `data.read` path/section. Author `data.path` with `data.template`; resolve defects. Reply `AUTHORED` with `path`. Accept `SPEC_REVISED`; spec authoring uses the authored reply.

## Await native

`REVIEW_USE` selects [review applicability](references/review-rules.md#review-provenance-and-applicability). Launch each `data.slots` subagent with prompt, model, effort, and attachments. Reply `NATIVE_RESULTS` with attested slot fields ([fields](references/providers.md)).

## Await rule

`REVIEW_USE` selects applicability. Read `data.findingsPath` or inline findings; verify intent first under [review rules](references/review-rules.md#intent-and-findings). Send `RULINGS` before scoped edits. User gates: changed intent, new external dependency/runtime prerequisite, discarded work. Accept `SPEC_REVISED`.

## Await fix

`REVIEW_USE` selects applicability. Apply accepted clusters within `affectedPaths` via frame `writer`, verify; reply `FIXES_APPLIED`. Adjacent changes require opt-in.

## Await write

Launch native writers per `launch` slot with model, verified brief, envelope, worktree. Send one `WRITE_RECEIPT` per writer, echoing identity: `status:launched` carries attempt, signature, host-assigned handle, attested `model`/`effort`; `submitted` carries `briefHash`; `failed`/`cancelled`. Taskless hotfix receipts omit identity fields. Relay live writers' out-of-scope `REQUEST`s while running. `AMEND`/`REPLACE_PLAN` reconcile the plan; notify affected writers and relay each notice and regenerated brief. See [implement](references/verbs/implement.md).

## Await evidence

Inspect summaries/logs; never rerun gates. Send `EVIDENCE` with id-keyed criterion evidence and `outcome:"pass"`. Accept `SPEC_REVISED`.

## Await decide

Answer `data.kind` from listed options. Never invent decisions. For spec quote/hash answers, follow [spec approval](references/spec-stage.md#approval). Accept `SPEC_REVISED`. Production approval/manual completion require `{by:"user",quote:"..."}`. Ask users to adopt/retain higher explicit-level `gateScope` recommendations. Route rule conflicts/requests to `by:"orchestrator"`; [implement](references/verbs/implement.md) owns answers and `AMEND`. `REPLACE_PLAN` chooses replacement; `REVIEW_USE` sets applicability; follow [collision handling](references/change-handling.md). `run-stop` ends it. Send rule concerns/RED exceptions to `by:"orchestrator"` with evidence; follow failure decisions. Reply `DECISION` with `kind`/`answer`.

## Await retro

Follow `data.diagnostics.instruction`; reply `RETRO`.

## Await done

Clean up [worktrees](references/worktree-cleanup.md). Report outcome, behavior, verification, concerns, rulings, and artifacts. If `data.diagnostics` exists, add one line with its `path` and the report's first top finding. Complete only when every criterion passes and owned worktrees are cleaned; preserve the handoff folder.

## Write boundaries and recovery

Driver owns journals/generated artifacts; follow frame write permissions. Provider CLIs stay read-only; unrelated dirty or ignored files stay intact.

Session-root files: `manifest.json`, deliverable specs/designs/plans/walkthroughs/reports, optional `diagnostics.md`. Agent-created helpers/logs/intermediates/backups: `.state/runs/NNN-<kind>/scratch/`; pre-run/shared: `.state/scratch/`. Preserve supplied paths; classify backups.

After stop, failure, or interruption, follow [worktree cleanup](references/worktree-cleanup.md). Journal is authoritative; inspect `status --run <dir>` and follow [checkpoint/rebind recovery](references/change-handling.md#checkpoints-and-runtime-continuation) before resuming uncertain effects. `send --dry-run --event` validates (exit 1: invalid). Exit codes: 1 usage, 2 engine fault, 3 lock holder. Wait on live locks; break only dead-process locks.
