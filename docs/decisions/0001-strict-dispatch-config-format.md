# ADR 0001: Strict dispatch config format

- **Status**: Accepted; implemented in v0.5.0
- **Date**: 2026-09-24
- **Specification**: `.scratch/plan/2026-09-22-strict-config-format-design.md` (supersedes the
  streamline design's `R1 — Unified config` candidate shapes)

## Context

`skills/dispatch/config.jsonc` accepted several permissive shapes: flat `model`/`effort` beside
level maps, bare candidate objects or arrays under a read provider, and sandbox flags at mixed
depths. The same array syntax could mean either independent dispatch targets or same-target model
fallbacks, and target counting in selection and consensus depended on which shape was used. The
active config uses only a small subset of these forms. Some models also reject effort options
entirely, so a mandatory effort cannot express them.

## Decision

Adopt one strict, intentionally breaking config contract. The root keeps exactly `read-delegates`,
`write-subagents`, and `phases`; phase policy is unchanged.

```jsonc
{
  "read-delegates": {
    "copilot": {
      "sandbox": true, // optional; claude/copilot/opencode only; defaults to true
      "targets": [
        { "low": { "model": "gemini-3.7-flash", "effort": "medium" } },
        {
          "low": { "model": ["gpt-5.6-luna", "bedrock.gpt-5.6-luna"], "effort": "max" },
          "max": { "model": "no-effort-model" }, // effort omitted
        },
      ],
    },
  },
  "write-subagents": {
    "claude": { "low": { "model": "bedrock.claude-sonnet-5", "effort": "medium" } },
  },
}
```

1. **Read-provider wrapper**: every read provider is `{ sandbox?, targets: [...] }`; `targets` is
   non-empty and each element is a level map. `sandbox` is rejected for `agy`.
2. **Level maps**: only keys `low`, `medium`, `high`, `xhigh`, `max`; non-empty; sparse. Resolution
   is exact, then nearest lower, then lowest higher, with no field inheritance between levels.
3. **Level configuration**: `{ model, effort? }` and nothing else. `model` is a nonblank string or a
   non-empty, duplicate-free, ordered string array. `effort`, when present, is a nonblank
   provider-defined string; when omitted, no effort flag is passed and the CLI/model default applies.
4. **Model arrays are alias cascades**: aliases are tried in order within one target, on every
   failure class, before dispatch advances to another target.
5. **Targets are independent voices**: identity is `<provider>[<index>]`; providers flatten in
   declaration order, then target order, for counts, `all`, reserves, completion, and consensus.
   `only` stays provider-scoped. Structurally identical targets under one provider are rejected.
6. **Sandbox is provider-wide**, defaults to `true`, and `false` opts out. When isolation is
   unavailable, dispatch runs unsandboxed and always emits a stderr and structured downgrade warning.
   OpenCode's Bubblewrap use follows the effective sandbox value.
7. **Write subagents** are a bare level map: no `targets`, no `sandbox`.
8. **CLI `--model`/`--effort` overrides** keep working, including `--effort` on a level that omits
   effort.
9. **No migration path**: other shapes fail validation with generic, exhaustive schema errors that
   point to `config.sample.jsonc`.

## Rationale

| Decision | Rationale |
|---|---|
| Reject other shapes outright. | The goal is a tight contract, not support for forms the active config does not use. |
| One wrapper for every read provider. | Gives sandbox a single home and removes array-versus-object semantic branches. |
| Name the array `targets`; positional identity. | Elements are independent dispatch units; config order already provides stable identity, so names would be unused schema. |
| Optional `effort`. | Some models reject effort options; requiring it would make them unconfigurable, and a placeholder value would be sent to the CLI. |
| Reject `null`/blank effort instead of treating it as omission. | One way to say "no effort" keeps the schema unambiguous and catches half-edited config. |
| No field inheritance across levels. | Inheritance obscures the resolved pair and could re-add effort to a model that rejects it. |
| Keep sparse level fallback. | The active config defines only transition points, not all five levels. |
| Keep string and array model forms. | Both are in use; arrays encode immediate alias fallback explicitly. |
| Advance aliases on every failure, including auth. | Aliases may route through different API keys or endpoints. |
| Reject duplicate aliases and duplicate targets. | They add indistinguishable calls; target comparison ignores object-key order but keeps model-array order, since only fallback order has semantics. |
| Count every target independently. | Multiple targets under one provider were intended as separate review voices. |
| Sandbox defaults to true and degrades with a warning. | Isolation is the secure default; availability was chosen over fail-closed, provided the downgrade is always visible and machine-readable. |
| No sandbox for write subagents. | Native implementation subagents need workspace writes and have no target cascade. |
| Retain CLI overrides. | Persisted-schema strictness should not remove one-run operator control. |
| Generic schema errors. | A migration-specific diagnostic surface was not wanted for an intentionally breaking contract. |

## Consequences

- Existing user configs must be migrated by hand: wrap read providers, move sandbox to the wrapper,
  convert candidates to level maps, move flat model/effort into levels, and keep model arrays inside
  levels.
- Validation, target flattening, selection, retry, consensus, runner alias fallback, sandbox
  reporting, doctor output, docs, and tests change together in one release.
- Runners must omit the effort flag when a resolved level has no `effort`.
- Out of scope: per-target names, indexed `only` selectors, per-target/per-level sandbox,
  provider-specific effort enums, and automatic detection of which models accept effort.
