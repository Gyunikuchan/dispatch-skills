# Troubleshooting

Start with the diagnostic or decision Dispatch provides. Keep the session folder until the work is complete; it contains the artifacts and logs needed to understand or resume a run.

Dispatch observes tracked files and non-ignored untracked files. Tracked files remain observed even when an ignore pattern matches. Ignored dependency and secret changes are outside automatic drift detection; required checks still run. Review [change handling](../change-handling.md) for notice resolution and evidence refresh.

Recovery manifests and content blobs are immutable files linked by the journal. Preserve the entire run when moving or recovering it. Missing/corrupt references are errors. Protocol 7 requires a new run for older live journals; their files remain preserved. A delivery/restore collision requires rebuilding or rebinding the candidate before retry, followed by live destination preflight.

## Run a configuration check

From the Dispatch skill folder:

```bash
node scripts/dispatch.ts doctor --level high
node scripts/dispatch.ts doctor --json
```

Doctor checks Node, configuration, available executables, resolved targets and writers, and predicted sandbox support. Use the reported file or provider name to narrow the fix.

## Common problems

| Problem | What to do |
|---|---|
| No delegates are available | Add at least one entry to `read-delegates`. Confirm the provider CLI is installed and authenticated, and that a model is configured for the requested level. |
| The model or number of reviewers is unexpected | Check which configuration file is active, then review the requested level, pins, and `phases` policy. Run Doctor to see resolved targets. |
| Implementation cannot start | Configure `write-subagents` for the host platform. Check that required design or plan steps are complete and that you have approved the plan. |
| Code review says there are no changes | Without a range, Dispatch reviews uncommitted changes only. Provide an explicit range such as `main..HEAD` to include committed branch work. |
| Review findings are reported but no files changed | That is the default. Request `--fix` when you want accepted, safe findings applied, verified, and reviewed again. |
| A provider reports sandbox problems | Follow the diagnostic to identify the provider and execution mode. Setting `sandbox: false` opts that provider out of OS isolation; read-only controls may still apply, but they do not provide the same boundary. |
| A verification step fails | Open the named log and follow the decision Dispatch presents. Keep the working tree and session folder so the failed check can be repaired or resumed. |
| A run is interrupted | Continue in the same chat and follow its recovery prompt. Preserve the session folder; it contains the recorded progress and work needed to resume. |

## Understand diagnostics coverage

Token counts are measured only when a provider CLI reports them. In `diagnostics.md`, `—` marks an unavailable value, not zero. `~` marks a token figure that is attested or estimated rather than measured: counts your host agent reported for native subagents and writers, and Dispatch's estimate of host-agent tokens. Measured totals exclude `~` figures. The Coverage column shows how many launched CLI invocations reported usage, for example `3/4`.

While diagnostics is on, Dispatch rewrites the report whenever a run in the session finishes or faults; until then, a run in progress has no report. If the handoff does not mention the report, it had no findings.

Collection problems print a warning and never change workflow results or verification. Proposed fixes in the report are unverified. Review `diagnostics.md` before sharing it; it is not uploaded automatically.

For setup and routing, see [Configure Dispatch](configuration.md). For session files and verification, see [Workspaces and results](concepts.md).
