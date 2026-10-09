# Workspaces and results

Dispatch keeps independent review and implementation inside your current agent workflow. Your host agent remains responsible for checking evidence, making rulings, and reporting the result.

## Who does what

- **Read delegates** inspect the repository and return analysis or review findings. They use provider-specific read-only controls.
- **Your host agent** compares those claims with the code, repository instructions, and your goal. It accepts, rejects, or narrows findings with reasons.
- **A native writer** makes production changes only after you approve the plan. The writer is configured for the platform running your host agent.

This keeps independent review useful while leaving decisions and production changes under your control.

## What happens during implementation

1. The plan lists the outcomes, files, prerequisites, and verification steps for the change.
2. After approval, Dispatch works through tasks whose prerequisites are ready. Independent tasks can run at the same time when `write-concurrency` is configured above one.
3. Your host agent checks the submitted changes, integrates accepted work, and runs the approved verification and review steps.
4. Dispatch reports the outcome and links the artifacts and logs you may need for follow-up.

The default concurrency is one. Increasing it lets independent tasks overlap, but should match the capacity of your host platform.

When a plan has several tasks, each task owns its file changes and names its prerequisites. A task starts when its accepted prerequisites are ready. Generated outputs should identify the task that creates them and the inputs that task needs. These details help the host agent decide what can proceed independently.

After a task finishes, the host agent checks its submitted changes before integrating them. It rejects setup-only test failures as proof of a behavior change, and can integrate a checked result from an older baseline while preserving unrelated work. If a run is interrupted, recovery uses retained handles rather than launching duplicate writers. It recognizes already-delivered changes and transfers only what remains.

## Session folder

Each chat has one session folder under `.scratch/dispatch-skills/<folder>/` in the workspace. Its top level holds only `manifest.json` and human deliverables: specs, designs, plans, walkthroughs, reports, and optional `diagnostics.md`. Run internals such as prompts, logs, and journals live under `.state/`. The folder remains in the workspace after handoff, and continuing in the same chat reuses it.

Agents put run-specific helper scripts, manually captured logs, intermediate data, and backups in `.state/runs/NNN-<kind>/scratch/`. Pre-run and shared working files go in `.state/scratch/`. Purpose determines placement: a backup named `before-rewrite.plan.md` goes in scratch, while the plan being delivered stays at the root. Native writers use a subdirectory of run scratch named from their supplied envelope's parent directory to separate concurrent actions. Driver-owned outputs retain their supplied paths, and production files stay in their scoped repository paths.

Keep the folder while work is active or may resume. The handoff provides its path so you can inspect the saved artifacts.

## What Dispatch verifies

Verification follows the plan you approved. Dispatch records evidence for the plan's criteria, checks submitted changes, and runs a final review before reporting completed delivery. If a required check fails or a decision is still open, the handoff names that state rather than presenting the work as complete.

Dispatch does not commit, push, or open a pull request. You decide when and how to publish the resulting changes.

## Optional session diagnostics

Diagnostics produce a retrospective you can pass to the Dispatch maintainers to make Dispatch faster, cheaper, and more reliable. When `diagnostics` is on, each run ends with one extra retro turn: your host agent notes up to three places where Dispatch's instructions, driver, or routing caused friction. Dispatch then writes `diagnostics.md` in the session folder from the recorded history of every run in the session. The report has four sections:

- **Summary:** Dispatch version and build, host platform and OS, run count, total wall time, measured tokens, and the top findings.
- **Overview:** one row per run phase with its outcome; wall, driver, host, and user-wait time (for example `1h 4m 12s`); invocation count; input, cache-read, cache-write, and output tokens; and usage coverage.
- **Findings:** issues in severity order, from correctness through token economy, speed, review convergence, instruction clarity, and information access. Each names the Dispatch file involved, the evidence, the impact, and an unverified proposed fix. Findings come from fixed checks on the recorded measurements and from the host agent's retro notes.
- **Appendix:** a collapsed table of every provider invocation, plus the Dispatch configuration values each run used.

Findings cover only Dispatch's own behavior. Failing tests, slow builds, and defects in your code are out of scope. The final handoff mentions the report, with its top finding, only when the report has findings.

The report holds Dispatch-owned data only: verbs, levels, providers, models, effort, timings, token counts, error classes, and Dispatch file references. It leaves out your source code, the objective, repository paths outside the session, and identities. It stays in the session folder and is not uploaded automatically; review it before sharing.

When `diagnostics` is off, runs have no retro turn and no report is written. Dispatch still records per-invocation timing and token counts in each run's journal, so you can turn diagnostics on later and the next report will include the earlier runs in that session.

See [Troubleshooting](troubleshooting.md) for interrupted runs, failed checks, and incomplete diagnostics.
