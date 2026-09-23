# dispatch

`dispatch` is the single model-visible entry for read-only delegation and the plan, design, review, and implementation driver.

## Invocation

```text
/dispatch [level] [(pins)] [verb-clause]: [argument]
```

Verbs are `ask` (default), `plan`, `design`, `review [plan|design|code] [--fix]`, and `implement [--phases from:<phase>]`. The colon is required when an argument follows. Standalone review is report-only; add `--fix` explicitly to apply accepted safe findings. `implement: <ask>` starts at planning, while artifact paths resume from their canonical state.

Examples:

```text
/dispatch (all): inspect the cache invalidation flow
/dispatch high plan: introduce tenant-scoped API keys
/dispatch review design: .scratch/plan/2026-09-22-api-keys-design.md
/dispatch review code --fix: main..HEAD
/dispatch implement: introduce tenant-scoped API keys
```

## Configuration

Copy `config.sample.jsonc` to `config.jsonc` or `config.local.jsonc`. First match wins; files are not merged.

- `read-delegates`: provider candidates and level overrides.
- `write-subagents`: native implementation models by host platform.
- `phases`: targets, rounds, consensus, and optional membership filters.

Any candidate or level override naming a `model` must also set `effort`; validation rejects a resolvable candidate left without one.

Validate with `node scripts/dispatch.mjs --validate-only` and inspect effective routing with `node scripts/dispatch.mjs --doctor --orchestrator <platform>`. v0.4 config keys are rejected with a migration diagnostic.

## Operation

The ask path launches configured read delegates directly. Driver verbs emit one compact, versioned JSON action at a time; the host returns schema-valid action results until `done`. Canonical artifacts and Git state make phases independently resumable. Read delegates cannot write. Production edits remain approval-gated and use native write subagents; standalone review fixes require explicit `--fix`.

Implementation gates run on the driver: the `verify` action's argv executes the plan's approved commands (and `[GENERATED]` generators at completion), logs each run, and extracts failure identities, so the host never parses test output. An unchanged tree reuses its baseline for a day.

Temporary files for one run live in a single session directory, `<os temp>/dispatch-skills-<user>/sessions/<id>/` (run state, write briefs, verify logs and results, prompts, slot output); sessions untouched for a day are pruned. Ledgers, baseline caches, telemetry, and locks outlive sessions under `dispatch-skills-<user>/`. Plans and walkthroughs stay in `.scratch/plan/`.

Use `node scripts/dispatch.mjs --help` for all flags and current usage. Provider-specific setup and fallback behavior are in [references/providers.md](references/providers.md).

## Troubleshooting

- **No candidates:** create the single dispatch config, then run `--doctor`.
- **v0.4 schema diagnostic:** migrate using the [release field map](https://github.com/Gyunikuchan/dispatch-skills/blob/main/docs/v0.5.0-release-notes.md#configuration-field-map).
- **Missing prerequisite:** resume from the named producing phase or restore its canonical artifact.
- **Provider failure:** preserve the reported source identity and use the emitted native-fallback action.
- **Gate failure:** open the `logPath` named in the verify results under the session directory; a failure disposition of `retry` continues the same segment with your ruling as writer context.
- **Unsettled review:** resume from its resolution log; never manufacture settlement metadata.
