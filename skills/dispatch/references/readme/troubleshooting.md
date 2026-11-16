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
node scripts/dispatch.ts session reactivate --session-dir <session> --host <platform>
node scripts/dispatch.ts status show --session <session>
```

Read the returned status result, reconcile retained writers and integration state, then resume the next unfinished tool operation. If Dispatch cannot confirm whether an interrupted action completed, your host must resolve that uncertainty before retrying. Follow the recovery guidance it provides.

## Run a configuration check

From the Dispatch skill folder:

```bash
node scripts/dispatch.ts session init --objective "Check Dispatch setup" --host <platform>
node scripts/dispatch.ts doctor run --session <returned-session-path> --host <platform> --level high
```

Doctor returns a JSON summary and result path. Read the result for integrity, configuration problems, writer models at the selected level, and the `utility` entry per platform that explorer and utility subagents use. `utility` output does not vary with level. Doctor does not probe provider executables, authentication, native capacity or runtime sandbox activation; inspect provider launch failures for those limits.

## Common problems

| Problem | What to do |
|---|---|
| No delegates are available | Add at least one entry to `read-delegates`. Confirm the provider CLI is installed and authenticated, and that a model is configured for the requested level. |
| The model or number of reviewers is unexpected | Check which configuration file is active, then review the requested level, pins, and `phases` policy. Utility entries are per platform and ignore level; run Doctor to see the declared host, resolved writer models and the `utility` entry for explorer and utility subagents. |
| Missing or invalid utility subagent configuration | Add a `utility-subagents` entry for the host platform with `model` and a positive integer `context-limit` (tokens) in `config.jsonc` or `config.local.jsonc`. |
| Fewer reviewers than configured, or a host-sensitive action refuses `usage` for a missing or unknown host | Pass `--host <platform>` with your current host on `doctor run`, `review run`, `ask run` and the `brief` actions, then rerun. Doctor shows `host`. |
| Implementation cannot start | Configure `write-subagents` for the host platform. Check that the plan is settled and required design approval is complete. |
| Code review says there are no changes | Without a range, Dispatch reviews uncommitted changes only. Provide an explicit range such as `main..HEAD` to include committed branch work. |
| Review findings are reported but no files changed | Review applies accepted, fixable in-scope findings by default. No changes may mean that no fixable in-scope finding was accepted, opt-in findings were declined, or a fix failed before writing. Follow the decision and named log. Verification can fail after changes are written, so inspect the working tree. |
| A provider reports sandbox problems | An unpinned roster drops only a non-host provider whose sandbox cannot run on the host; see [sandboxing](configuration.md#sandboxing-and-provider-details). Otherwise, follow the diagnostic to identify the provider and execution mode. Setting `sandbox: false` opts that provider out of OS isolation; read-only controls may still apply, but they do not provide the same boundary. |
| A verification step fails | Open the named log and follow the decision Dispatch presents. Keep the working tree and session folder so the failed check can be repaired or resumed. |
| A run is interrupted | Continue in the same chat and follow its recovery prompt. Preserve the session folder; it contains the recorded progress and work needed to resume. |

## Understand diagnostics coverage

In `diagnostics.md`, `—` marks an unavailable value, not zero, and `~` marks a cost estimate in USD; measured token totals include billed reasoning where reported apart from output. [The toolkit reference](../toolkit.md#diagnostics-render) defines `Cost notes`, `Coverage`, and the cost columns. After fixing a missing rate, render again to reprice stored usage without a new run.

| Reason | Meaning | What to do |
|---|---|---|
| `unpriced model` | No rate matched the model id, usage held more than 32 model/effort keys (`other`), or a counter rate is missing. | Add a [`pricing` entry](configuration.md#override-rates-for-cost-estimates) with every counter rate the route reports, then render again. |
| `no usage` | A launched delegate reported no usage, or the provider reports none (such as Copilot). | Check delegate session logs if unexpected; Copilot reports no usage. |
| `tier unknown` | Usage lacked per-request data across a tier threshold; cost is shown as a range. | Read the range as bounds; session-data launches price exactly. |
| `cache TTL unknown` | A cache write lacks a 5m/1h split and the two rates differ; cost is shown as a range. | Read as bounds, or set both lifetime rates in `pricing` if your rate is flat. |

<details>
<summary>Detailed measurement, transcript caps &amp; OpenCode lifecycle notes</summary>

- **Captured attempts & nudges:** CLI attempts record execution, semantic validation, routing, duration, and reported usage. `nudge` marks a resume launch after an idle stop, empty answer, capacity failure, or missing report. Native slots show pending/completed status (including CLI fallback), while their timing and Dispatch-recorded slot usage stay unavailable. Missing measurements do not establish full conversation totals. Summed tool-call durations can overlap (including work, pauses and scheduling) and do not establish active reasoning time; host reasoning time, user wait, Dispatch-recorded writer usage, and pre-enablement work remain unavailable. Session-cumulative usage is excluded to avoid double counting.
- **OpenCode lifecycle appendix:** Lists `debug-config`, `debug-agents`, `prepare`, `response`, and `teardown` (in record order, not time) with elapsed/budget ms. `timeout` means the step hit its deadline; `unconfirmed` on debug/teardown means process-tree exit wasn't confirmed (keep the worktree, verify exit, then clean up); `failed` before `response` means the run never started. Steps never include credentials, paths, or output.
- **Host transcript collection:** Selects only the current host session via `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, or `OPENCODE_SESSION_ID` (OpenCode reads `opencode.db` read-only), including nested subagents. Host/subagent stages are timestamp-derived estimates; delegate stages are recorded. Diagnostics reads no host sources when disabled and never gates workflow outcomes.
- **Collection limits & notes:** `no adapter` (unsupported host), `no host id` / `invalid host id` / `host id file missing`, `invalid session start`, `transcript over size cap` (64 MiB decoded per file), `read budget reached` (256 MiB total decoded), `too many candidates`, `zstd unavailable` (needs `zlib.zstdDecompressSync`), `no usage records`, or `read-error:*` (`ENOENT`, `EACCES`, `EPERM`, `EBUSY`, `EMFILE`, `EUNKNOWN`). None of these change workflow results.
- **Delegate usage:** Read from each delegate's own session data (within the same 64 MiB / 256 MiB caps). `transcript unavailable` means Dispatch used reported totals or left a resumed cumulative launch unmeasured; keep default delegate session storage readable. `no usage` means the provider reports no usage (Copilot).
- **Retro notes & integrity:** While diagnostics is on, follow the returned retrospective instructions at each verb's final handoff before `report complete` or `diagnostics render` (failed retro merges do not gate the workflow; empty arrays record no friction; proposed fixes are unverified). Review `diagnostics.md` before sharing it; it is not uploaded automatically. Captures in `.state/diagnostics/` retain sanitized version/content identity and effective configuration snapshots; corrupt captures are discarded while valid ones remain, and No findings does not prove complete collection or absence of defects. Total storage loss can also prevent failure markers from being stored. Supported rejection and writer relaunch evidence can indicate rework without establishing a defective writer or its cause. Keep the session folder to inspect captures or resume.

</details>

For setup and routing, see [Configure Dispatch](configuration.md). For session files and verification, see [Workspaces and results](concepts.md).
