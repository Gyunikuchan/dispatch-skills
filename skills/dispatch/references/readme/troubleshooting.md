# Troubleshooting

Start with the diagnostic or decision Dispatch provides. Keep the session folder until the work is complete; it contains the artifacts and logs needed to understand or resume a run.

Dispatch notices changes to tracked files and non-ignored untracked files. These notices help your host agent decide what to recheck; they do not discard completed work. Required checks still run. Ignored untracked files are outside automatic change detection.

Preserve the whole session folder when moving or recovering a run. Missing or corrupt recovery files can prevent continuation. If delivery conflicts with newer changes in your checkout, ask your host agent to resolve the conflict before retrying.

## Resolve spec and intent changes

If no spec exists, your host authors one in the session folder from the discussion; standalone review also uses the diff and labels inferred requirements. If several session specs exist, identify the intended one and supply its path with `--spec`; the host must not guess. A supplied path must agree with the artifact's governing references. A resolved supplied spec keeps its path, including across sessions; merge redirected planning output into that canonical owner instead of making a new copy. Restore a missing governing file or correct those references through reauthoring.

When intent changes, the host preserves pending action results, completed work and review history before continuing. An interrupted action with uncertain completion must be reconciled before retry. Live writers finish or use an already-authorized stop path; changing the spec does not authorize stopping them.

The host reads and checks the changed spec and records its new content hash. At `medium` and above, any required authoring approval must cover the new contents; approval of an earlier version is insufficient. Standalone code review rechecks against the new spec without adding an authoring approval gate.

| Work in progress | Next action after an intent change |
| --- | --- |
| Delivery governed by a design | Suspend increment work. Revise and approve the design before dependent increment plans are authored, reviewed or delivered. Before initial design approval, return to design authoring. |
| Standalone planning | Return to plan authoring against the changed spec. |
| Standalone review or implementation of an increment plan | Stop the current run. Have the governing design revised and approved through its separate revision flow, then reauthor the increment plan. This review or implementation owner does not edit the design in place. |
| Standalone review of a plan or design | Stop and re-plan or revise the design before a new review. |
| Standalone implementation of a plan | Stop for re-planning. If this run authored the plan and tasks have not started, it can return to plan authoring. After tasks start, retain the work and stop. |

Keep the session folder throughout recovery. A new approval or revised plan does not erase accepted work or earlier review evidence. See [document layers](concepts.md#spec-design-and-plan) for each document's purpose.

## Continue after a local driver fix

Ask your host agent to inspect the saved run before resuming it. A compatible driver fix can preserve completed work. For manual recovery, run from the skill folder:

```text
node scripts/dispatch.ts session reactivate --session-dir <session>
node scripts/dispatch.ts status show --session <session>
```

Read the returned status result, reconcile retained writers and integration state, then resume the next unfinished tool operation. The toolkit has no `rebind` or `send` command. If Dispatch cannot confirm whether an interrupted action completed, your host must resolve that uncertainty before retrying. Follow the recovery guidance it provides.

Before upgrading, finish and deliver live old-protocol runs with the version that started them. If that is impossible, preserve their whole folders and ask your host to use the saved work in a new run. The toolkit cannot replay v0.7.x journals or frames; there is no automatic migration.

## Run a configuration check

From the Dispatch skill folder:

```bash
node scripts/dispatch.ts session init --objective "Check Dispatch setup"
node scripts/dispatch.ts doctor run --session <returned-session-path> --level high
```

Doctor returns a JSON summary and result path. Read the result for integrity, configuration problems and configured writer models. It does not probe provider executables, authentication, native capacity or sandbox support; inspect provider launch failures for those limits.

## Common problems

| Problem | What to do |
|---|---|
| No delegates are available | Add at least one entry to `read-delegates`. Confirm the provider CLI is installed and authenticated, and that a model is configured for the requested level. |
| The model or number of reviewers is unexpected | Check which configuration file is active, then review the requested level, pins, and `phases` policy. Run Doctor to see resolved targets. |
| Implementation cannot start | Configure `write-subagents` for the host platform. Check that the plan is settled and required design approval is complete. |
| Code review says there are no changes | Without a range, Dispatch reviews uncommitted changes only. Provide an explicit range such as `main..HEAD` to include committed branch work. |
| Review findings are reported but no files changed | Review applies accepted, fixable in-scope findings by default. No changes may mean that no fixable in-scope finding was accepted, opt-in findings were declined, or a fix failed before writing. Follow the decision and named log. Verification can fail after changes are written, so inspect the working tree. |
| A provider reports sandbox problems | Follow the diagnostic to identify the provider and execution mode. Setting `sandbox: false` opts that provider out of OS isolation; read-only controls may still apply, but they do not provide the same boundary. |
| A verification step fails | Open the named log and follow the decision Dispatch presents. Keep the working tree and session folder so the failed check can be repaired or resumed. |
| A run is interrupted | Continue in the same chat and follow its recovery prompt. Preserve the session folder; it contains the recorded progress and work needed to resume. |

## Understand diagnostics coverage

In `diagnostics.md`, `—` marks an unavailable value, not zero. Captured CLI attempts include execution and semantic validation outcomes, routing, duration and reported usage. Native slots show pending or completed status, including fallback; their timing and usage remain unavailable. Missing measurements do not establish full conversation totals.

When captured facts include estimates, `~` marks those figures. Measured totals exclude `~` figures. Summed tool-call durations can overlap; intervals can include work, pauses and scheduling and do not establish active reasoning time. Host reasoning, user wait, writer usage and work before enablement remain unavailable. Session-cumulative usage is excluded to avoid double counting.

While diagnostics is on, follow the returned retrospective instructions before report completion. A valid empty array records no observed friction; missing, unreadable, malformed and invalid input remain distinct collection states. Proposed fixes are unverified. Review `diagnostics.md` before sharing it; it is not uploaded automatically.

Captures in `.state/diagnostics/` retain sanitized implementation version/content identity and effective configuration snapshots from collection time. Distinct snapshots remain separate; historical unknown identity stays unknown. Reports retain valid captures when others are discarded as corrupt or unreadable, and show partial or interrupted collection. No findings does not prove complete collection or absence of defects. Total storage loss can also prevent its failure marker from being stored and is unobservable.

Supported rejection and writer relaunch evidence can indicate rework; it does not establish a defective writer or its cause. Diagnostic capture and report failures leave workflow results unchanged. Keep the session folder to inspect retained captures and resume; missing measurements cannot be reconstructed from the report.

For setup and routing, see [Configure Dispatch](configuration.md). For session files and verification, see [Workspaces and results](concepts.md).
