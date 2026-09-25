# Configure dispatch

Start with one available read delegate. Add review breadth and a native write subagent when you need them.

## Get started

From `skills/dispatch/`, copy the sample, replace its example models with ones available to you,
and check the result:

```bash
cp config.sample.jsonc config.jsonc
node scripts/dispatch.mjs --validate-only
node scripts/dispatch.mjs --doctor --level high
```

The sample describes the schema; it is **not** a runtime default. Dispatch needs an active
`config.jsonc` or `config.local.jsonc`. If both exist, `config.local.jsonc` wins outright—the two
files are alternatives, not merged layers.

| Table | What it controls | Required? |
|---|---|---|
| `read-delegates` | Models for questions and reviews | Yes |
| `write-subagents` | Host-native writer for implementation | For implementation |
| `phases` | Review target counts, rounds, consensus, and provider filters | No |

## Read delegates

Each provider's `targets` array lists independent analysis or review voices. Two targets under
one provider count as two voices.

```jsonc
{
  "read-delegates": {
    "claude": {
      "sandbox": true,
      "targets": [
        {
          "low": { "model": "claude-sonnet", "effort": "low" },
          "high": { "model": "claude-opus", "effort": "medium" }
        }
      ]
    }
  }
}
```

Use model identifiers accepted by the installed provider CLI. For fallback *within* a single
voice, set `model` to an ordered array such as `["preferred-model", "fallback-alias"]`.
Dispatch tries the next alias when one fails; aliases are not additional review voices.

## Levels and model selection

Configure only the levels where settings change: `low`, `medium`, `high`, `xhigh`, or `max`.
Dispatch uses an exact match, otherwise the nearest configured lower level, otherwise the lowest
higher level. For a map with just `medium` and `max`, requests from `low` through `xhigh` use
`medium`; only `max` uses `max`. The selected entry stands alone—fields do not inherit between
levels. If a model rejects effort options, omit `effort` to use the provider default.

Automatic classification chooses `low`, `medium`, or `high`; users must request `xhigh` or `max`
explicitly. Levels are routing choices, not universal model-quality labels: the active config
determines the actual models, breadth, rounds, and consensus.

## Pins and target breadth

Pins change target selection for one invocation:

| Pin | Selects | Example |
|---|---|---|
| Provider names | All configured targets under those providers | `/dispatch (claude,agy): compare both retry implementations` |
| Count | That many targets in dispatch order | `/dispatch high (3) review code: main..HEAD` |
| `(all)` | Every eligible configured target | `/dispatch max (all) design: migrate the authorization model` |

A count is of independent targets, not providers.

## Write subagents

Implementation needs a write subagent for the orchestrating host. Add one level map per host
you implement from:

```jsonc
{
  "write-subagents": {
    "copilot": {
      "low": { "model": "writer-model", "effort": "medium" },
      "high": { "model": "stronger-writer", "effort": "high" }
    }
  }
}
```

Read delegates remain read-only; production edits require approval and use the host's native
subagent. A missing writer entry blocks implementation, not questions or reviews.

## Review phase policy

`phases` accepts two policy keys: `plan-review` and `code-review`. Technical design reviews keep
their own `design-review` flow identity but use **all** `plan-review` settings. Changing its target
count, rounds, consensus, or `only` list changes both plan and design reviews.

```jsonc
{
  "phases": {
    "plan-review": {
      "targets": { "low": 0, "medium": 1 },
      "rounds": { "low": 0, "medium": 2 },
      "consensus": { "low": false, "medium": true },
      "only": ["claude", "copilot"]
    }
  }
}
```

`targets` selects a number of eligible review voices or `"all"`; `rounds` caps review/rebuttal
waves; `consensus` controls multi-voice settlement; and optional `only` limits providers for the
phase. An absent `plan-review` policy leaves plan and design review unconfigured in the resolved
flow; standalone reviews default to one target, one round, and host-final rulings. `rounds: 0`
disables a phase at that level; unpinned `targets: 0` also disables it.

If you have a `phases.design-review` entry, move its settings to `phases.plan-review` and reconcile
any differences with existing plan settings. The old key is rejected; simply adding both keys does
not work. Start with one or two read delegates for routine reviews and increase breadth where
review failures warrant the latency.

## Sandboxing

For Claude, Copilot, OpenCode, and Codex, provider-wide `sandbox` defaults to `true`; use `false` only
when necessary for compatibility. If isolation is unavailable, dispatch proceeds with any
remaining provider read-only controls, prints a warning, and sets `sandboxDowngraded` in
structured output.
Antigravity has no OS sandbox; plan mode provides its write boundary.

Read-only controls and credential stripping are defense in depth, **not** a complete secret
boundary. Keep sensitive files out of delegated scope and heed downgrade warnings. See the
[provider reference](../providers.md) for installation, sandbox mechanics, probes, and failures.

## Validate and diagnose

From `skills/dispatch/`, run `node scripts/dispatch.mjs --validate-only` to check the schema,
or `node scripts/dispatch.mjs --doctor --level high` for resolved models, phases, writers, and
provider health. For target order as JSON, use `--list-targets --level high`; for all flags, use
`--help`.

| Symptom | Check |
|---|---|
| No candidates | Is `read-delegates` populated in the active config? |
| Unexpected model | Check level resolution and CLI overrides with `--doctor` |
| Implementation cannot start | Is `write-subagents.<host>` configured? |
| Wrong review breadth | Check the applicable `phases` policy and invocation pins |
| Provider cannot launch | Consult the [provider reference](../providers.md) |
