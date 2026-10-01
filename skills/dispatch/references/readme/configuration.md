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

OpenCode preserves `OPENCODE_CONFIG` and `OPENCODE_CONFIG_DIR` selectors and obtains merged native config sources and effective agents with bounded introspection. It selects a verified default-deny read-only agent; unavailable permissions fail as `read-only-agent-unavailable`. Unverifiable remote/managed sources fail as `effective-config-unverified`. Inline config is not propagated implicitly. Local selected-model endpoints receive a bounded model preflight, shared GPU lease and proxy trap; remote endpoints skip local preparation. Native Antigravity modes select their authenticated profile through `JETSKI_APP_DATA_DIR`.

## Migration

Use Node.js `^22.18 || >=23.6` for native TypeScript. Invoke `scripts/dispatch.ts` with a verb and use its current frame envelopes. Consensus voting, direct runner entrypoints and phase jumping have been removed; claims are verified by the host, and implementation owns its review sequence. Design approval precedes a separate implement invocation.

Each chat has a session folder under `.scratch/dispatch-skills/`; journals live in `.state/runs/<run>/events.jsonl`. Handoff moves the entire folder to OS temp and reports its path; reactivate it before later work. Wave journals require protocol revision 2. Historical journals without that revision fail `unsupported-journal-protocol`; preserve their artifacts and start a new run rather than replaying incompatible events.

Sandbox failure is strict. An explicit `sandbox:false` opts out of OS isolation while native read-only tool controls remain. Ambient credential stripping and sensitive attachment checks do not isolate native authenticated profiles or enforce file-read permissions by themselves.
