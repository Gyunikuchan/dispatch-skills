# Workspaces and results

Dispatch keeps independent review and implementation inside your current agent workflow. Your host agent remains responsible for checking evidence, making rulings, and reporting the result.

## Spec, design and plan

Dispatch separates intent, strategy, tactics, and delivery across four canonical documents so later layers cite upstream decisions instead of repeating them:

| Document | Purpose |
|---|---|
| **Spec** (mission brief) | Why the work matters: problem, requirements, acceptance conditions, constraints, alternatives, and your decisions. |
| **Design** (strategy) | Architecture, component boundaries, risks, and ordered delivery increments. |
| **Plan** (tactics) | Concrete tasks, file ownership, prerequisites, `[SC<n>]` criteria, and `Check:` commands. |
| **Walkthrough** (debrief) | Delivered behavior, file changes, verification evidence, deviations, follow-ups, and review resolutions. |

- **Clarifying intent:** For `plan` and `design`, [spec authoring](../spec-authoring.md) grounds your request on problem, approach, scope, and cost/risk. It lays out 2–3 approach options with a recommendation (including the simplest worth considering, each with its trade-off, limitation and risk), asks only decisions that change scope, behavior, or risk, and skips questions when nothing is open (for the other lenses it proposes an alternative only when materially better, otherwise stating in one line why the premise holds). After you confirm the spec, Dispatch grounds the confirmed scope before writing a standalone plan or design.
- **One canonical spec:** Every work verb except `ask` uses one governing spec (reusing a supplied artifact's spec or authoring one in the session folder; standalone review also uses the diff and labels inferred requirements). A resolved supplied spec keeps its path, including across sessions, and any stray planning output is merged into it.
- **Confirmation and approval gates:** You confirm the spec's exact contents before design or plan authoring at every level. At `medium` and above, you also approve the resulting design or plan before implementation; at `low`, Dispatch proceeds after spec confirmation and links the artifacts at handoff. Standalone code review adds no spec approval gate; design and plan reviewers check governing intent as part of their review.
- **Shared visibility:** Authors, writers, and reviewers all read the whole spec (and authors read the same quality bar as reviewers). Writers read the plan's shared context and their assigned task details.
- **If intent changes mid-run:** Your host records the decision in the spec and checks its new contents. Required approvals must cover the new version; completed work and logs stay intact. See [recovery guidance](troubleshooting.md#resolve-spec-and-intent-changes).

## Who does what

- **Your host agent (orchestrator & deputy):** Dispatches work, checks every claim against the code, repository rules, and your goal, and accepts, rejects, or narrows findings with reasons. Decisions, rulings, user gates, and spec/plan authoring stay with it.
- **Read delegates:** Inspect the repository read-only for `ask` and multi-provider reviews. CLI delegates use provider sandboxes/read-only controls; a voice on your host platform runs as a native subagent (prompt-restricted to its reply file, with any other checkout edit flagged by the round's change comparison). Reviewers read code directly and launch no explorers.
- **Explorer subagents:** Native workers on the utility tier (`utility-subagents`) used for grounding maps, research, log/verification triage, finding evidence, and reference sweeps (one per independent topic in parallel). Map explorers write only an assigned map file and run `lint run` on its assigned map only; research explorers return concise cited replies. They work solo unless expected reading exceeds 75% of the configured `context-limit`, splitting independent sub-topics to nested explorers.
- **Utility subagents:** Native workers on the utility tier (`utility-subagents`) for low-risk routine tasks such as [test cleanup](../templates/test-cleanup-brief.md), large map corrections, and mechanical fixes confirmed by deterministic checks. They edit only assigned paths, run no Git write commands and no toolkit except `lint run` on an assigned map, and your host agent or writer checks their edits.
- **Native writers:** Host-platform writers that make production changes from a settled plan or approved design. A writer can launch an explorer for heavy reading outside its task paths or a utility subagent for simple tedious edits.

Explorer and utility subagents share the host platform's required `utility-subagents` entry ([routing](../../SKILL.md#routing)), and the host can continue a subagent with follow-up questions while its context is warm.

## What happens during implementation

1. **Plan & tasks:** After spec settlement and scope grounding, the plan defines tasks with owned paths, prerequisites, criteria, and checks. Ready tasks run in isolated worktrees (concurrently up to `write-concurrency`, default `1`).
2. **Integrate & check:** After each task finishes, your host agent inspects the delta and evidence (recording setup-only RED failures as concerns), integrates accepted work, and runs task checks.
3. **Verify, clean up & review:** Dispatch runs all-criteria checks, runtime verification, test cleanup, and final checks + code review before handoff.
4. **Recover safely:** Interruptions resume from retained handles without relaunching duplicate writers, and already-delivered sources return the recorded outcome.

## Session folder

Each chat stores its primary session under `.scratch/dispatch-skills/<folder>/`:

- **Top level:** `manifest.json` and human deliverables (specs, designs, plans, walkthroughs, reports, and optional `diagnostics.md`).
- **`.state/`:** Tool internals (prompts, logs, ledger) and `.state/scratch/` for helper scripts, intermediate data, and backups.
- **Continuity:** Continuing in the same chat reuses the session folder; design runs link separate increment sessions from the primary design session.

## What Dispatch verifies

Dispatch records evidence for every plan criterion, verifies runtime behavior, cleans up redundant tests, and runs final checks and code review before reporting completion. Open decisions or failed checks are surfaced explicitly rather than marked complete.

Internal task and integration commits stay in Dispatch's worktrees; final delivery restores the verified source into your checkout as **unstaged changes** (no commit, staging, push, or PR by default; see [design delivery](implement.md#design-delivery) for increment commits). Review with `git diff`, or restore any file from `refs/dispatch/<id>/delivered-source` with `git restore --source=refs/dispatch/<id>/delivered-source -- <path>`.

## Optional session diagnostics

When `diagnostics` is `true`, Dispatch writes a cumulative `diagnostics.md` retrospective at each verb's final handoff (or `report complete`) with per-platform/stage time, tokens, review outcomes, and estimated `~$` costs (using `references/pricing.json` and any [`pricing` overrides](configuration.md#override-rates-for-cost-estimates)). Your host agent merges terse retro notes itself and may use a research explorer when investigating logs or chat. The report stays in the session folder and is never uploaded automatically.

<details>
<summary>How token &amp; cost measurement works</summary>

- **Delegate usage:** Captured CLI attempts retain reported provider usage; Dispatch reads each Claude, Codex, OpenCode, and Antigravity delegate's own session data (including nested subagents), falling back to reported totals if incomplete.
- **Host usage:** Claude Code, Codex, and OpenCode host transcripts measure host and native subagent tokens at any nesting depth for the current host thread only (OpenCode reads `opencode.db`). Other host threads are excluded.
- **Unavailable metrics:** Native timing and usage recorded per Dispatch slot, and unsupported measurements, render as `—`. See [Troubleshooting](troubleshooting.md#understand-diagnostics-coverage) for measurement limits and [the toolkit reference](../toolkit.md#diagnostics-render) for cost columns.

</details>

See [Troubleshooting](troubleshooting.md) for interrupted runs, failed checks, and diagnostics coverage.
