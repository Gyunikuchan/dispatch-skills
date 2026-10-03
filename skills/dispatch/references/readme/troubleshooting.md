# Troubleshooting

Start with the diagnostic or decision Dispatch provides. Keep the session folder until the work is complete; it contains the artifacts and logs needed to understand or resume a run.

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
| A provider reports sandbox problems | Follow the provider diagnostic and consult the [provider reference](../providers.md). Setting `sandbox: false` is an explicit opt-out from OS isolation for that provider. |
| A verification step fails | Open the named log and follow the decision Dispatch presents. Keep the working tree and session folder so the failed check can be repaired or resumed. |
| A run is interrupted | Continue in the same chat and follow its recovery prompt. Preserve the session folder; it contains the recorded progress and work needed to resume. |

## Understand diagnostics coverage

Session diagnostics are optional and only include usage counters exposed by supported provider CLIs. A partial report or missing usage value means that measurement was unavailable, not that usage was zero. Timing can also include gaps that Dispatch could not attribute to a specific operation.

Collection problems do not replace workflow results or verification. Review `diagnostics.md` before sharing it; it is not uploaded automatically.

For setup and routing, see [Configure Dispatch](configuration.md). For session files and verification, see [Workspaces and results](concepts.md).
