# dispatch-skills

[![Version](https://img.shields.io/badge/version-v0.5.0-blue.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

One model-visible `dispatch` skill delegates bounded work and drives evidence-based plan, design, code-review, and implementation workflows. Provider CLIs stay read-only; the host verifies claims and confines production writes to approved native write subagents or explicit review fixes.

## Install

```bash
npx skills add Gyunikuchan/dispatch-skills -s '*'
```

Node.js `>=22` and at least one supported provider CLI are required. Copy `skills/dispatch/config.sample.jsonc` to `config.jsonc` or `config.local.jsonc` beside it. This one config defines `read-delegates`, `write-subagents`, and per-level `phases` policy.

## Catalog

| Skill | Purpose | Invocation |
|---|---|---|
| [`dispatch`](skills/dispatch/README.md) | Unified delegation and workflow driver | Model- and user-invoked |
| [`dispatch-plan-review`](skills/dispatch-plan-review/README.md) | Plan-review compatibility alias | User-invoked |
| [`dispatch-code-review`](skills/dispatch-code-review/README.md) | Code-review compatibility alias | User-invoked |
| [`dispatch-design-review`](skills/dispatch-design-review/README.md) | Design-review compatibility alias | User-invoked |
| [`implement-dispatch`](skills/implement-dispatch/README.md) | Implementation compatibility alias | User-invoked |

Aliases require `dispatch` in the same installation scope. They preserve familiar slash commands while adding no competing model trigger.

## Quick start

```text
/dispatch: Trace discount stacking in src/domain/pricing.ts
/dispatch high (claude,agy) plan: Add webhook idempotency
/dispatch review code: main..HEAD
/dispatch review code --fix: main..HEAD
/dispatch design: Migrate the billing state machine
/dispatch implement: Add CSV export
/dispatch implement --phases from:code-review: .scratch/plan/2026-09-22-csv.md
```

Grammar: `/dispatch [level] [(pins)] [ask|plan|design|review|implement]: <argument>`. Levels are `low`, `medium`, `high`, `xhigh`, and `max`. Review kinds are `plan`, `design`, and `code`; standalone reviews are report-only unless the user supplies `--fix`. Run `node skills/dispatch/scripts/dispatch.mjs --help` for the authoritative CLI flag surface.

## Architecture

```text
user aliases ──> dispatch ──> provider CLIs (read-only)
                       └────> native write subagent (approval-gated)
```

The driver emits one versioned JSON action at a time. It owns phase order, preparation, rounds, consensus, ledgers, checkpoints, and recovery; the host verifies findings and executes actions. See [v0.5.0 release notes](docs/v0.5.0-release-notes.md) for breaking config migration.

## License

MIT © [Gyunikuchan](https://github.com/Gyunikuchan). See [LICENSE](LICENSE).
