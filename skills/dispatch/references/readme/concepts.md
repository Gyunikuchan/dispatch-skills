# Workspaces and results

Dispatch keeps independent review and implementation inside your current agent workflow. Your host agent remains responsible for checking evidence, making rulings, and reporting the result.

## Spec, design and plan

Dispatch organizes work across four canonical document layers. The **spec (mission brief)** records why the work matters and what it must achieve: the problem, requirements with acceptance conditions, constraints, alternatives and user decisions. A **design (strategy)** chooses the strategy: architecture, boundaries, risks and ordered increments. A **plan (tactics)** gives the tactics: tasks, file ownership, prerequisites, requirement-linked criteria and verification commands. Later layers cite upstream requirements and decisions instead of repeating them. A **walkthrough (debrief)** records delivered behavior, file changes, verification evidence, deviations, follow-ups, and review resolutions.

For plan and design work, the [spec authoring](../spec-authoring.md) checks your request on problem, approach, scope and cost/risk after grounding. It lays out two or three approach options with a recommendation, where one option is the simplest worth considering and each option states its trade-off, limitation and risk, asks only decisions that change scope, behavior or risk, and takes the short path (no questions) when nothing is open; for the other lenses it proposes an alternative only when it is materially better, otherwise it states in one line why the premise holds. After you confirm the spec, Dispatch grounds the confirmed scope again before authoring a standalone plan or design.

For example, a webhook spec can require safe retries without duplicate charges. The design chooses the idempotency boundary and rollout order. A plan names the storage and handler changes and checks that prove retries are safe. A standalone plan pins the spec's exact contents; an increment plan names its design increment, and that design pins the spec.

Every work verb except `ask` uses one canonical governing spec. Dispatch reuses the supplied artifact's governing spec or the session spec; when none exists, your host writes one from the discussion in the session folder. A resolved supplied spec keeps its path and references, including when it belongs to another session; Dispatch does not move it to normalize placement. Standalone review also uses the diff and labels inferred requirements. If another planning skill runs during Dispatch, its spec/design output and discussion go into that resolved canonical spec. Content in a stray spec is merged before removal; deleting a tracked stray needs your approval.

You confirm the spec's exact contents before design or plan authoring at every level. At `medium` and above, you also approve the resulting design or plan before implementation; at `low`, Dispatch proceeds after spec confirmation and links the artifacts at handoff. Spec confirmation is separate from design and plan approval. Standalone code review needs a spec but adds no spec approval just to review it. There is no separate delegated spec review: design and plan reviewers check governing intent as part of their review.

Authors, writers and every reviewer read the whole spec. Authors also read the same quality criteria as their reviewers. A writer reads the plan's shared context and its assigned task details. This keeps the outcome available while task ownership remains bounded.

If intent changes, the host records your decision in the spec and checks its new contents. At an applicable authoring gate, approval must cover those new contents; older approval does not carry over. Completed work, logs and review history remain available. Follow [recovery guidance](troubleshooting.md#resolve-spec-and-intent-changes) to identify which design or plan must change before work resumes.

## Who does what

- **Your host agent** is the orchestrator and your deputy. It dispatches work to the agents below, compares their claims with the code, repository instructions, and your goal, and accepts, rejects, or narrows findings with reasons. Decisions, rulings, user gates, and spec and plan authoring stay with it.
- **Read delegates** inspect the repository and return analysis or review findings only for asks you request and for multi-provider reviews. CLI delegates use provider-specific read-only controls. A voice on your host platform runs as a native subagent instead, so you can watch it in the host UI: the first call returns its descriptor before any CLI launch, the next call runs the CLI wave alongside it, and a later call consumes its reply. A native reviewer is write-capable but writes only its reply file by prompt rule; the round's change comparison lists any other checkout edit for your host agent to inspect. Reviewers read the code themselves and launch no explorers.
- **Explorer subagents** are native workers on the utility tier. Dispatch defines two explorer kinds: map explorers (writing an assigned map file, including nested partial maps) and research explorers (returning an inline cited reply within the size limit). Explorers write only an assigned map file and run `lint run` on its assigned map only. Explorers work solo by default, nesting only when expected reading exceeds a split threshold of 75% of the platform's configured token limit and an independent sub-topic qualifies; they then hand those sub-topics to nested explorers and consolidate the result. Coherent single-topic work stays solo past the limit, and the reply reports the overrun. The host agent can launch them at any step for grounding maps, research, log and verification triage, finding evidence, and reference sweeps, one per independent topic in parallel.
- **Utility subagents** are the low-cost native tier configured under `utility-subagents`. In write mode, they handle low-risk routine tasks, such as [test cleanup](../templates/test-cleanup-brief.md), large map corrections over the context-guard threshold, and mechanical fixes that a deterministic check confirms. A task writer can also launch utility subagents for tedious, simple edits within its assigned paths. They edit only assigned paths, run no Git write commands and no toolkit except `lint run` on an assigned map, and the host agent or writer inspects their changes.
- **A native writer** makes production changes from a settled plan or approved design. The writer is configured for the platform running your host agent. A writer can launch an explorer subagent for heavy reading outside its task paths, or a utility subagent for tedious, simple edits.

Explorer and utility subagents use the host platform's required `utility-subagents` entry with its token limit ([routing](../../SKILL.md#routing)). The host agent can continue a subagent with a follow-up question when the answer depends on what that subagent already read.

This keeps independent review useful while leaving decisions and production changes under your control.

## What happens during implementation

1. Dispatch settles the spec, grounds the confirmed scope, then the plan lists outcomes, files, prerequisites, requirement-linked criteria and verification steps.
2. After approval, Dispatch works through tasks whose prerequisites are ready. Independent tasks can run at the same time when `write-concurrency` is configured above one.
3. Your host agent checks the submitted changes, integrates accepted work, and runs the approved verification and review steps.
4. Dispatch reports the outcome and links the artifacts and logs you may need for follow-up.

The default concurrency is one. Increasing it lets independent tasks overlap, but should match the capacity of your host platform.

When a plan has several tasks, each task owns its file changes and names its prerequisites. A task starts when its accepted prerequisites are ready. Generated outputs should identify the task that creates them and the inputs that task needs. These details help the host agent decide what can proceed independently.

After a task finishes, the host agent checks its submitted changes before integrating them. It records setup-only RED failures as concerns, and can integrate a checked result from an older baseline while preserving unrelated work. Rechecking completed work does not repeat its implementation. If a run is interrupted, recovery uses retained handles rather than launching duplicate writers. It recognizes an already-delivered source and returns the same completed outcome. Further source changes require a new run.

## Session folder

Each chat has a primary session folder under `.scratch/dispatch-skills/<folder>/` in the workspace. Its top level holds only `manifest.json` and human deliverables: specs, designs, plans, walkthroughs, reports, and optional `diagnostics.md`. Tool internals such as prompts, logs, and the ledger live under `.state/`. The folder remains in the workspace after handoff, and continuing in the same chat reuses it. A design run links separate increment sessions from its primary design session. Follow those links to find the plan, walkthrough and evidence for each increment.

Agents put helper scripts, manually captured logs, intermediate data, and backups in `.state/scratch/`. Purpose determines placement: a backup named `before-rewrite.plan.md` goes in scratch, while the plan being delivered stays at the root. Writers use the paths supplied in their briefs. Tool-owned outputs retain their supplied paths, and production files stay in their scoped repository paths.

Keep the folder while work is active or may resume. The handoff provides its path so you can inspect the saved artifacts.

## What Dispatch verifies

Verification follows the plan you approved. Dispatch records evidence for the plan's criteria, checks submitted changes, and runs a final review before reporting completed delivery. If a required check fails or a decision is still open, the handoff names that state rather than presenting the work as complete.

Dispatch keeps internal task and integration commits, then delivers the verified result into your caller working tree as unstaged changes. By default it makes no commit and stages nothing; new files show as untracked in `git status`. Review the result with `git diff`, then stage and commit it yourself unless you opted in to design increment commits. Dispatch keeps the verified source at `refs/dispatch/<id>/delivered-source`; restore a file from it with `git restore --source=refs/dispatch/<id>/delivered-source -- <path>`. Dispatch does not push or open a pull request.

## Optional session diagnostics

When `diagnostics` is on, `report complete` or `diagnostics render` at a verb's final handoff writes `diagnostics.md` from session captures, the ledger, current review results and host retro notes; it is one cumulative report per session. Captured CLI attempts retain reported provider usage. Claude Code, Codex, and OpenCode host transcripts can also measure host and native subagent tokens for the current host thread during the session; Codex includes direct subagents only, and OpenCode reads host and nested subagent tokens from the local `opencode.db` for the current host session. Other host threads are excluded; see [Troubleshooting](troubleshooting.md) for measurement limits. Native timing and usage recorded per Dispatch slot, and unsupported measurements, remain unavailable as `—`. The report groups tokens by platform and stage, with time-derived host and subagent stages, and shows review rounds, outcomes, findings and collection limits.

The host agent merges its own terse notes on Dispatch instruction, driver or routing friction in the [retro format](../diagnostics.md); investigating logs or chat follows the context guard and may use a research explorer. Without observations, nothing is added. Findings cover Dispatch's own behavior. Proposed fixes are unverified.

The report stays in the session folder and is not uploaded automatically. Review it before sharing. When `diagnostics` is off, no report is written.

See [Troubleshooting](troubleshooting.md) for interrupted runs, failed checks, and diagnostics coverage.

See [design delivery](implement.md#design-delivery) for increment commits and the all-increments opt-in.
