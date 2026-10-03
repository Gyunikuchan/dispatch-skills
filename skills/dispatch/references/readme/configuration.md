# Configuration

Copy `config.sample.jsonc` at the skill root to `config.local.jsonc` or `config.jsonc`. The first existing candidate loads wholly, without merging; sample config is a validation reference. `read-delegates` defines provider target level maps, `write-subagents` defines native writers, and `phases` defines target breadth and round caps.

Sparse levels use the nearest defined lower level, then the lowest higher level. Pins override breadth; model/effort overrides collapse each provider to its first target. Use `doctor --json` to inspect effective membership, order, resolution, writers, config errors, and predicted sandbox support. See [providers](../providers.md) for explicit sandbox opt-outs and native mapping.


## Current controls

```jsonc
{
  "read-delegates": {
    "claude": { "sandbox": false, "targets": [{ "low": { "model": "sonnet" }, "high": { "model": ["opus", "sonnet"] } }] },
    "codex": { "nativeSubagentsOnly": true, "targets": [{ "low": { "model": "configured-native-model" } }] }
  },
  "write-subagents": { "claude": { "low": { "model": "sonnet" } } },
  "phases": { "plan-review": { "rounds": { "low": 1 }, "targets": { "low": 1 } }, "code-review": { "rounds": { "low": 2 }, "targets": { "low": 1 } } }
}
```

Each target is one voice; its model array is a failure cascade for that voice. `nativeSubagentsOnly` requires a matching orchestrator platform. Writers resolve from the orchestrator's `write-subagents` level map. A configured phase with zero rounds or targets is disabled; missing phase policy defaults to one reviewer and one round. Pins override breadth, and model/effort overrides select the first target per provider. Doctor reports configured, filtered and resolved membership without launching delegates.

`"write-concurrency": 2` sets the maximum active task writers. It must be a positive safe integer; omission defaults to one. Configure it within the host's actual native capacity: the cap is an admission ceiling, not a capacity probe. Every task uses the same isolated execution and acceptance path at one or higher values. See [task execution](concepts.md); writer selection remains the orchestrator's `write-subagents` mapping.

OpenCode preserves `OPENCODE_CONFIG` and `OPENCODE_CONFIG_DIR` selectors and obtains merged native config sources and effective agents with bounded introspection. It selects a verified default-deny read-only agent; unavailable permissions fail as `read-only-agent-unavailable`. Unverifiable remote/managed sources fail as `effective-config-unverified`. Inline config is not propagated implicitly. Local selected-model endpoints receive a bounded model preflight, shared GPU lease and proxy trap; remote endpoints skip local preparation. Native Antigravity modes select their authenticated profile through `JETSKI_APP_DATA_DIR`.

## Operational boundaries

Use Node.js `^22.18 || >=23.6` for native TypeScript. Invoke `scripts/dispatch.ts` with a verb and use its current frame envelopes.

Each chat has a session folder under `.scratch/dispatch-skills/`; journals live in `.state/runs/<run>/events.jsonl`. Sessions remain in the workspace under `.scratch/dispatch-skills/` for the user to clean up. Journals require protocol revision 3. Other revisions fail `unsupported-journal-protocol`; preserve their artifacts and start a new run.

Older implementation journals without task records and plans without task ownership require explicit reauthor/restart; they are not silently migrated. Preserve their artifacts before restarting.

Sandbox failure is strict. An explicit `sandbox:false` opts out of OS isolation while native read-only tool controls remain. Ambient credential stripping and sensitive attachment checks do not isolate native authenticated profiles or enforce file-read permissions by themselves.
# Optional diagnostics and live model refresh

Set `"diagnostics": true` in the effective config to collect bounded session diagnostics. Omitted/false is disabled. The first existing config file wins as a whole; local files are never merged with the sample. Changes take effect at the next mutating `send`; existing workers retain their launch setting. Turning diagnostics off preserves collected records and the report, removes future diagnostic instructions, and suppresses the handoff link. Re-enabling records the intervening gap.

Model/effort edits require `send --run <dir> --refresh-config`. This records future defaults independently of diagnostics; already-issued waves and native/writer descriptors retain their bindings. Explicit start model/effort overrides still win. Provider topology, level keys, phase policies and sandbox changes require a new run.

Use `--refresh-config --dry-run` for read-only validation. Combining refresh with `--event` is rejected, including with `--dry-run`. No-op refresh records no update; terminal runs reject refresh. `status` and dry-run never refresh diagnostic reports.
