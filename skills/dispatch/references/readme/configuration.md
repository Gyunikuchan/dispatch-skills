# Configure Dispatch

Dispatch reads its configuration from the folder containing the skill. The sample explains the available settings but is not a default configuration.

## Set up a configuration

Copy `config.sample.jsonc` to `config.local.jsonc` or `config.jsonc`, then remove providers you do not use and replace the example model names with identifiers accepted by their CLIs.

If both files exist, `config.local.jsonc` is used on its own; settings are not merged. Keep machine-specific settings in the local file.

| Setting | Needed for | What it controls |
|---|---|---|
| `diagnostics` | Optional | Session timing and supported provider-usage summaries |
| `write-concurrency` | Optional | Maximum number of task writers active at once; defaults to `1` |
| `read-delegates` | Questions and reviews | Provider targets and their model choices |
| `write-subagents` | Implementation | Native writer models available to each host platform |
| `phases` | Optional | Review target counts, rounds, consensus, and provider filters |

The `write-concurrency` value must be a positive safe integer; omission defaults to one.

For example, a host agent running on Codex can use one configured read target and a native writer:

```jsonc
{
  "read-delegates": {
    "codex": {
      "targets": [
        { "low": { "model": "your-read-model" } }
      ]
    }
  },
  "write-subagents": {
    "codex": {
      "low": { "model": "your-writer-model" }
    }
  }
}
```

Replace the provider and model names with choices available in your environment. You can configure several providers or targets, but start small and add more when you need additional perspectives.

## Understand levels and pins

Levels are routing presets: `low`, `medium`, `high`, `xhigh`, and `max`. The level determines which configured model choices and review policy apply. If a target has no exact match, Dispatch uses its nearest configured lower level; when none exists, it uses the lowest configured higher level. Missing fields are not copied between level entries.

When no level is supplied, the host agent chooses `low`, `medium`, or `high` according to the assurance the change needs. Use `low` for localized, routine, reversible work with low failure cost; `medium` for bounded work with meaningful uncertainty or impact; and `high` for broad, externally visible, security or data-integrity work, hard-to-reverse changes, or other high-cost failures. The choice weighs impact, reversibility, uncertainty, and failure cost rather than task size alone. A level selects your configured routing preset; it does not guarantee a fixed number of models or review rounds.

Pins affect one invocation:

| Pin | Effect |
|---|---|
| `(claude,agy)` | Use eligible targets from those providers |
| `(3)` | Select three eligible targets |
| `(all)` | Select every eligible configured target |

Each entry in a provider's `targets` list is a separate voice. A model array inside one target is a fallback list for that voice, not extra reviewers.

## Set review breadth

The optional `phases` setting controls how many independent targets review a change and how many review rounds they can take. The `plan-review` policy is used for both design and plan reviews; `code-review` controls code reviews. Without a policy, standalone reviews use one target and one round.

Start with the sample's defaults. Increase breadth or rounds when the work needs more scrutiny, and keep review settings proportional to the change.

## Check your setup

From the Dispatch skill folder, run:

```bash
node scripts/dispatch.ts doctor --level high
```

Use `--json` for structured output. Doctor reports configuration problems, resolved targets and order, writer availability, and predicted sandbox support without launching delegates.

If an implementation cannot start, check that `write-subagents` includes the host platform. A read delegate is not a substitute for a native writer.

## Sandboxing and provider details

Dispatch requests OS sandboxing by default where a provider and execution mode support it. Sandbox behavior varies by provider. If Doctor or a run reports `sandbox-unsupported`, use the diagnostic to identify the affected provider and mode. Setting `sandbox:false` opts that provider out of OS isolation; provider-specific read-only controls may still apply, but they do not provide the same boundary.

For Node.js requirements and supported provider CLIs, see the [repository README](../../../../README.md).

## Optional settings

- Set `"write-concurrency"` above `1` only when your host platform can support that many native writers. It is an admission limit, not a capacity check.
- Set `"diagnostics": true` to create a shareable `diagnostics.md` with timing and supported usage summaries. It is not uploaded automatically; review it before sharing. Coverage is partial when a provider or execution surface does not report usage.

## Older sessions and provider-specific settings

Chat artifacts remain in the workspace under `.scratch/dispatch-skills/`. If an older run reports `unsupported-journal-protocol`, preserve its folder and start a new run. Older implementation journals without task records and plans without task ownership require explicit reauthor/restart; automatic migration is not available.

<details>
<summary>Advanced provider settings</summary>

- `nativeSubagentsOnly: true` skips a provider CLI and uses that platform's native subagents when it matches your host platform. On other platforms, those targets are skipped.
- OpenCode reads its selected native configuration, including `OPENCODE_CONFIG_DIR`; Dispatch does not copy inline settings into another provider's configuration.
- Doctor reports resolved provider targets, writer availability, and predicted sandbox support without launching delegates.

</details>
