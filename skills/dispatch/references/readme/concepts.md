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

Each chat has one session folder under `.scratch/dispatch-skills/<folder>/` in the workspace. It holds that chat's plans, designs, handoff notes, and supporting run files. The folder remains in the workspace after handoff, and continuing in the same chat reuses it.

Keep the folder while work is active or may resume. The handoff provides its path so you can inspect the saved artifacts.

## What Dispatch verifies

Verification follows the plan you approved. Dispatch records evidence for the plan's criteria, checks submitted changes, and runs a final review before reporting completed delivery. If a required check fails or a decision is still open, the handoff names that state rather than presenting the work as complete.

Dispatch does not commit, push, or open a pull request. You decide when and how to publish the resulting changes.

## Optional session diagnostics

When enabled in configuration, Dispatch writes a `diagnostics.md` report in the session folder. It summarizes measured time and usage counters reported by supported provider CLIs. Some providers, native-agent surfaces, and resumed work do not expose usage, so totals may be partial; unavailable values are not counted as zero.

Diagnostics stay in the session folder and are not uploaded automatically. Review the report before sharing it.

See [Troubleshooting](troubleshooting.md) for interrupted runs, failed checks, and incomplete diagnostics.
