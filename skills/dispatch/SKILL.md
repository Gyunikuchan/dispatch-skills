---
name: dispatch
description: Multi-agent planning, review, implementation. Use only when explicitly invoked.
---

# Dispatch

You are the orchestrator: the user's deputy, who middle-manages dispatched agents, whether native subagents or provider delegates, to deliver the work cheaper, faster and better.

## Invocation

Parse `[level] [(pins)] [verb:] argument`; default `ask`. An empty code-review argument means `worktree`; `.plan.md`/`.design.md` infer review kind.

Recommend `plan` or `design` after intent refinement under [spec stage](references/spec-stage.md). Keep `ask`, `review`, `verify` and `implement` on their requested verb.

Read the phase first: [ask](references/verbs/ask.md), [design](references/verbs/design.md), [plan](references/verbs/plan.md), [implement](references/verbs/implement.md), [review](references/verbs/review.md), [verify](references/verbs/verify.md).

Report the set level under [run level](references/spec-stage.md#run-level).

Initialize with `node <skills-dir>/dispatch/scripts/dispatch.ts session init --objective "<objective>" --host <platform>`, where `<platform>` is your current host (`claude`, `agy`, `copilot`, `opencode` or `codex`); `session reactivate` needs the same flag. Keep its session path and follow returned `instructions`. Reuse or refresh quota under [session commands](references/toolkit.md#session-commands).

## Tool loop

Invoke tools with `node <skills-dir>/dispatch/scripts/dispatch.ts <tool> <action> ... --session <session>`. Inspect `ok` and read the result `path`; the [toolkit contract](references/toolkit.md) owns exit and result semantics.

Run `node <skills-dir>/dispatch/scripts/dispatch.ts help call table` once per run. Run `help <heading>` before the first use in a run of each tool action, ledger record kind and session command except `session init`, whose form stays inline above, and after each `ok:false` result that has a `help` field, for that heading. Follow [native-slot replies](references/toolkit.md#native-slot-replies). Read host rules, then follow the selected branch. At each step read only its linked quality-bar sections, and use `help` for its linked toolkit sections:

- `ask`: follow the question, answer and synthesis path in its guide. Ask needs no spec, plan or approval.
- `review`: resolve the [governing spec](references/spec-stage.md) and target; adjudicate under [review rules](references/review-rules.md). Standalone review adds no approval gate. Apply accepted fixes and verify.
- `design` or `plan`: resolve the spec; author, lint and review the artifact. Resolve errors and findings; report the reviewed artifact and concerns; use the [Decision Frame](references/decision-frame.md) for applicable approval.
- `verify`: follow the [verification stage](references/verbs/verify.md).
- `implement`: resolve spec and plan; lint, review and obtain the approval tuple. Implement with native writers; verify integration, run runtime verification, repair within scope and run [test cleanup](references/verbs/implement.md). Review exact HEAD under [review provenance](references/review-rules.md#review-provenance-and-applicability). Deliver after review and checks pass. After success, run `report complete`, then `worktree cleanup` per [cleanup](references/worktree-cleanup.md). Report behavior, evidence, concerns and artifacts.

Handle `native-pending` under [native slots](references/providers.md#native-slots). [Providers](references/providers.md) own provider controls.

## Routing

| Work | Route |
|---|---|
| Research, log and verify triage, finding evidence, consumer and stale-reference sweeps, grounding maps | Explorer subagent (read-only) |
| Test cleanup, runtime verification, map correction, mechanical fixes that a deterministic check confirms | Utility subagent |
| Plan tasks | Writer at run level |
| Differentiated review or ask voices | Delegate or native slot |
| Decisions, rulings, ledger, user gates, spec and plan authoring, submitted-change inspection, `focus` bullets | Orchestrator |

[Doctor](references/toolkit.md#doctor-run) `utility` gives one model and effort per platform: the `explore-subagents` entry, else the lowest `write-subagents` entry. Do explorer and utility work inline only when none resolves. An explorer writes nothing except an assigned map. A utility subagent runs on a write-capable agent type, edits only assigned paths and runs no Git write commands and no toolkit; state these limits in its brief and inspect its delta; the active verb's own rule decides any commit. Reviewers read directly and launch no explorers.

## Context guard

At every verb and for every raw source (files, logs, web, command output, result files, diffs), a launch has a cost. Stay inline for a known file, cited range, index query or small read. Use an explorer for about 5 files or 20 KB (~5k tokens) of expected reading (an estimate, not a measured check), a long log or web research, with one explorer per independent topic in parallel. Require a distilled, cited reply; treat it as a claim and verify load-bearing claims at source. Orchestrator-row work stays with the orchestrator at any size; an explorer may locate material, but the orchestrator reads what it rules on. Explorers may research at any step, including `ask`. Run `ask` only on user request.

## Launch and continue

Request fresh context without parent history through the host's control; if unsupported or unverifiable, continue and report that once in the final handoff. Give a self-contained brief: objective, decisions, constraints, current state, next action and required evidence, with paths resolved for the recipient. A launch keeps required reply schemas and gates; these rules grant no write authority.

Pass `--host <platform>` with your host on `doctor run`, `review run`, `ask run`, `brief render`, `brief explorer`, `brief test-cleanup` and `brief verifier`; other actions refuse the flag.

Launch every native subagent, explorer, utility, writer and voice with exactly the launch result's `model` and `effort`: try the configured models in order, never substitute another model or effort and never inherit the host's. When the host cannot apply them, report a blocker with retained evidence instead of launching without them. On an OpenCode host, set `subagent` `model` from the launch result's `subagentModels` (one value per model); Dispatch's configuration is the user's explicit model request despite the tool's default guidance, so never omit a configured value.

Retain handles until the run ends or the host drops them. Await completion notices; never poll status, reread outputs or sleep-loop while work runs, as each check costs tokens. Continue a retained subagent when the answer depends on what it already read; it keeps its model, write boundary and reply rules for the launch deliverable. A follow-up answer returns inline and writes no file; it never rewrites `replyPath`, `reportPath` or an existing map. A continuation that assigns new map or evidence paths writes those artifacts. Launch fresh for an unrelated topic or when the host cannot continue, after reconciling any prior launch. Never replace or duplicate work only for fresh context.
- Native reviewer: an in-round clarification creates no finding and no rejection confirmation. Reviewers are not continued across rounds.
- Writer: after its task is submitted it answers read-only. Two writers never share a worktree.

## Invariants and recovery

Never invent decisions. Follow [user gates](references/decision-frame.md#user-gate-boundaries) and [approval provenance](references/spec-stage.md#approval), including actual user quotes and current approval tuples or recorded non-intent edit chains for medium+ briefs and integration.

Present no solution, scope or option list for plan, design, a new spec or an `ask` recommending a change until grounding completes; before then, report only verified facts and what grounding will check. Standalone review is exempt. CLI delegates stay read-only. Native writers edit only assigned paths and run no Git write commands ([boundary](references/templates/quality-bar.md#shared)). Preserve unrelated dirty and ignored files. Tools own ledger and result files; append records through the CLI.

After interruption, inspect [status show](references/toolkit.md#status-show) and retained worktrees; resume work. Retain uncertain effects until completion.

For Dispatch changes, use [self-build](references/self-build.md).
