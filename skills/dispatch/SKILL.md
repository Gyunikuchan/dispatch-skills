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
- `implement`: resolve spec and plan; lint, review and obtain the approval tuple. Implement with native writers; run checks on integration, run runtime verification, repair within scope and run [test cleanup](references/verbs/implement.md). Review exact HEAD under [review provenance](references/review-rules.md#review-provenance-and-applicability). Deliver after review and checks pass. After success, run `report complete`, then `worktree cleanup` per [cleanup](references/worktree-cleanup.md). Report behavior, evidence, concerns and artifacts.

Handle `native-pending` under [native slots](references/providers.md#native-slots). [Providers](references/providers.md) own provider controls.

## Routing

| Work | Route |
|---|---|
| Research, log and verify triage, finding evidence, consumer and stale-reference sweeps, grounding maps | Explorer subagent (read-only) |
| Test cleanup, runtime verification, map correction, implementation integration mechanical fixes that a deterministic check confirms | Utility subagent |
| Plan tasks, remaining implementation integration fixes per [writer triggers](references/review-rules.md) | Writer at run level |
| Design increment | Child orchestrator where verified; else chain |
| Differentiated review or ask voices | Delegate or native slot |
| Decisions, rulings, ledger, user gates, spec and plan authoring, submitted-change inspection, `focus` bullets, remaining small integration fixes and standalone review fixes | Orchestrator |

| Role | Launched by | May launch | Model source | Writes | May be continued |
|---|---|---|---|---|---|
| Child orchestrator | Orchestrator | Writer, explorer, utility, voice | Documented inheritance | Increment session files | Increment continuation |
| Writer | Orchestrator, child orchestrator | Explorer (research), utility subagent | Doctor writer models at run level | Assigned task paths; integration worktree for review fix | Read-only; review fix inline |
| Explorer (outputs: map, research) | Orchestrator, child orchestrator, lead explorer, writer | Nested explorer under brief rule | Doctor [utility](references/toolkit.md#doctor-run) from the `utility-subagents` entry | Writes nothing except an assigned map (map); inline reply (research) | Follow-up inline at any time |
| Utility subagent in write mode (includes test cleanup and verifier) | Orchestrator, child orchestrator, writer | None | Doctor `utility` (`utility-subagents`) | edits only assigned paths and runs no Git write commands and no toolkit | Verifier yes (new cycle fresh); test cleanup no |
| Reviewer or voice | Orchestrator, child orchestrator | None (Reviewers read directly and launch no explorers) | Doctor `review run` / `ask run` | `replyPath` only; no Git writes | In-round clarification only; never across rounds; ask voices no |

## Context guard

At every verb and for every raw source (files, logs, web, command output, result files, diffs), a launch has a cost. Delegate reading by expected size, one explorer per independent topic in parallel, with a distilled, cited reply: stay inline for a known file, cited range, index query or small read; when the host has no launch tool, read inline. Use an explorer for about 5 files or 20 KB (~5k tokens) of expected reading (an estimate, not a measured check), a long log or web research; an explorer delegates only under its brief's split rule. Orchestrator-row work stays with the orchestrator at any size; an explorer may locate material, but the orchestrator reads what it rules on. Treat replies as claims and verify load-bearing claims at source. Explorers may research at any step, including `ask`.

The orchestrator may launch a research explorer at any step of any verb with a rendered `brief explorer` brief, launch several in parallel (for example logs, web research, file comparison), and ask a retained explorer a follow-up at any time, not subject to the limit, answered inline within the research reply limit (8,192 UTF-8 bytes) rewriting no map. Run `ask` only on user request.

## Launch and continue

Request fresh context without parent history through the host's control; if unsupported or unverifiable, continue and report that once in the final handoff. Give a self-contained brief: objective, decisions, constraints, current state, next action and required evidence, with paths resolved for the recipient. Keep reply schemas and gates; these rules grant no write authority.

Pass `--host <platform>` with your host on `doctor run`, `review run`, `ask run`, `brief render`, `brief explorer`, `brief test-cleanup` and `brief verifier`; other actions refuse the flag. When invoked with `(pins)`, pass `--pins "<pins>"` on `ask run` and `review run` (every round).

Except a [child orchestrator](references/providers.md#child-orchestrators) on documented inheritance or `agy` using the closest match to the configured `model`/`effort`, launch every native subagent, explorer, utility, writer and voice with exactly the launch result's `model` and `effort`: try configured models in order, never substitute or inherit otherwise. When the host cannot apply them, report a blocker with retained evidence instead of launching without them. On OpenCode, pass one `subagentModels` value as `subagent` `model`. Never omit a configured request despite tool default guidance.

Retain handles until the run ends or the host drops them. Await completion notices; never poll status, reread outputs or sleep-loop while work runs, as each check costs tokens. Continue a retained subagent when the answer depends on what it already read; it keeps its model, write boundary and reply rules for the launch deliverable. Except for an assigned child orchestrator continuing its increment or an assigned review fix, a follow-up answer returns inline and writes no file; an assigned review fix also replies inline. It never rewrites `replyPath`, `reportPath` or an existing map. A continuation that assigns new map or evidence paths writes those artifacts. Launch fresh for an unrelated topic or when the host cannot continue, after reconciling any prior launch. Never replace or duplicate work only for fresh context. Two writers never share a worktree. A utility subagent under a writer is not a second writer.

## Invariants and recovery

Never invent decisions. Follow [user gates](references/decision-frame.md#user-gate-boundaries) and [approval provenance](references/spec-stage.md#approval), including actual user quotes and current approval tuples or recorded non-intent edit chains for medium+ briefs and integration.

Present no solution, scope or option list for plan, design, a new spec or an `ask` recommending a change until grounding completes; before then, report only verified facts and what grounding will check. Standalone review is exempt. CLI delegates stay read-only. Native writers edit only assigned paths and run no Git write commands ([boundary](references/templates/quality-bar.md#shared)). Preserve unrelated dirty and ignored files. Tools own ledger and result files; append records through the CLI.

After interruption, inspect [status show](references/toolkit.md#status-show) and retained worktrees; resume work. Retain uncertain effects until completion.

For Dispatch changes, use [self-build](references/self-build.md).
