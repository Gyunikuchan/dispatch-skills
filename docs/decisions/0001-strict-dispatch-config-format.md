# ADR 0001: Strict dispatch config format

- **Status**: Accepted; implemented in v0.5.0
- **Date**: 2026-09-24
- **Original specification**: `.scratch/plan/2026-09-22-strict-config-format-design.md`
  (supersedes the streamline design's `R1 — Unified config` candidate shapes; this scratch
  artifact may have been relocated to OS temp)

## Context

The previous config allowed flat `model`/`effort` fields, bare read-provider candidates, and
sandbox flags at different depths. An array could mean either independent review voices or model
fallbacks within one voice, making selection and consensus counts shape-dependent. It also required
`effort`, although some models reject an effort option.

## Decision and reasons

Adopt one strict, intentionally breaking contract with three root tables: `read-delegates`,
`write-subagents`, and `phases`. Other shapes fail exhaustive schema validation with a pointer to
`config.sample.jsonc`; there is no automatic migration or special migration diagnostic. The active
config used only a small subset of the permissive shapes, so compatibility would preserve ambiguity
without serving current use.

### Read delegates and models

- Each provider is `{ sandbox?, targets: [...] }`. The non-empty `targets` array contains level
  maps, one per independent voice. Voices have positional identity `<provider>[<index>]`; provider
  declaration order, then target order, determines counts, `all`, reserves, completion, and
  consensus. `only` selects providers, not individual targets. Names would add schema without
  changing selection; structurally identical targets are rejected.
- Level maps are non-empty and sparse, with keys drawn from `low`, `medium`, `high`, `xhigh`, and
  `max`. Resolution uses the exact level, otherwise the nearest lower, otherwise the lowest higher.
  Each selected entry allows only `{ model, effort? }` and stands alone: inheriting a field could
  reintroduce an effort option to a model that rejects it. Sparse maps mark only transition points.
- `model` is a nonblank string or an ordered, non-empty array of distinct nonblank aliases. An array
  is a cascade *within one voice*, not extra votes: try aliases in order on every failure,
  including authentication failures (aliases may use different endpoints or credentials). Duplicate
  aliases and structurally identical targets would repeat indistinguishable calls; target comparison
  ignores object-key order but respects alias order.
- Optional `effort` is a nonblank, provider-defined string. Omission passes no effort flag and uses
  the CLI/model default; `null` or blank is rejected so omission has one unambiguous form. CLI
  `--model`/`--effort` overrides still work, even for a level without configured effort: strict
  persisted config should not remove one-run control.

### Sandbox and writers

`sandbox` lives on the provider wrapper, defaults to `true`, and can be set to `false`; it is
accepted for Claude, Copilot, and OpenCode, but not `agy`. If isolation is unavailable, the run
continues unsandboxed with both stderr and structured downgrade warnings. This favors availability
while making the security downgrade visible. OpenCode's Bubblewrap follows the effective sandbox
value.

Write subagents instead use a bare level map—no `targets` or `sandbox`—because native implementation
subagents need workspace writes and do not have independent review voices.

### Review policy

`phases` accepts `plan-review` and `code-review` only. Technical design reviews use the same
`plan-review` target count, rounds, consensus, and provider allowlist, but retain distinct
`design-review` flow and candidate identities. Both artifacts need the same configurable review
policy without collapsing their review records.

## Consequences

- Existing configs require manual conversion: wrap read providers, place sandbox on the wrapper,
  convert candidates to level maps, move flat model/effort fields into levels, and keep model alias
  arrays inside a level.
- `phases.design-review` is rejected; move its settings to `phases.plan-review`. The shared policy
  then also applies to plan reviews, including any provider filter.
- Runners omit the effort flag when the selected level omits `effort`. Validation, selection,
  retries, consensus, sandbox reporting, doctor output, docs, and tests reflect the strict shape.
- Out of scope: per-target names, indexed `only` selectors, per-target/per-level sandbox,
  provider-specific effort enums, and automatic detection of which models accept effort.
