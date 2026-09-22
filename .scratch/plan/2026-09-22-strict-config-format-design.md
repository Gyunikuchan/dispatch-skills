# Strict dispatch config format

## Status

Approved specification for future implementation. This document records the agreed contract and
rationale; it does not authorize implementation.

This specification supersedes the candidate shapes described by the v0.5 streamline design's
`R1 — Unified config`. The three top-level tables and existing phase-policy shape remain unchanged.

## Intent

Make the persisted dispatch configuration express only the structures used by the active
`skills/dispatch/config.jsonc`:

- model and effort are selected by a level, never declared beside levels;
- one provider may expose multiple independently dispatched targets;
- a model array is an immediate fallback cascade within one target;
- sandbox policy belongs to the provider wrapper and applies to every target beneath it.

The change is intentionally breaking. Legacy permissive shapes are rejected rather than migrated
or accepted with warnings.

## Ubiquitous language

- **Provider**: a configured CLI family keyed by `claude`, `agy`, `copilot`, or `opencode`, including
  accepted aliases.
- **Target**: one positional entry in a read provider's `targets` array. Every target is independently
  selectable, dispatchable, and countable.
- **Model alias cascade**: the ordered string array in one level's `model`. It is exhausted
  immediately within its target before dispatch advances to another target.
- **Level map**: a non-empty object whose only keys are `low`, `medium`, `high`, `xhigh`, and `max`.
- **Level configuration**: a complete `{ model, effort }` object selected through a level map.
- **Effective sandbox**: the provider wrapper's explicit `sandbox` value, or `true` when omitted.

## Goals

1. Establish one canonical read-provider wrapper and one canonical level configuration.
2. Preserve sparse level resolution: exact, nearest lower, otherwise lowest higher.
3. Distinguish independent dispatch targets from same-target model aliases structurally.
4. Count targets consistently in selection, reserves, completion, and consensus.
5. Make sandbox policy provider-wide, secure by default, and observable when unavailable.
6. Preserve explicit one-run `--model` and `--effort` overrides.

## Non-goals

- Config migration tooling or backward-compatible parsing.
- Per-target names; positional identity is sufficient.
- Per-target or per-level sandbox overrides.
- Sandbox configuration for write subagents.
- Indexed selectors in phase `only` lists.
- Provider-specific effort enums; effort remains a nonblank provider-defined string.

## Canonical schema

The root continues to accept exactly `read-delegates`, `write-subagents`, and `phases`.
`read-delegates` remains required and non-empty. Existing provider names, aliases, duplicate-alias
normalization, phase names, phase knob types, and v0.4 rejection rules remain in force unless this
specification changes them explicitly.

### Read delegates

Every read provider uses the same wrapper, including providers with one target:

```jsonc
{
  "read-delegates": {
    "claude": {
      "sandbox": true,
      "targets": [
        {
          "low": { "model": "bedrock.claude-opus-5", "effort": "low" },
          "high": { "model": "bedrock.claude-opus-5", "effort": "medium" },
          "max": { "model": "bedrock.claude-opus-5", "effort": "high" },
        },
      ],
    },
    "copilot": {
      "targets": [
        {
          "low": { "model": "gemini-3.7-flash", "effort": "medium" },
          "xhigh": { "model": "gemini-3.8-flash", "effort": "medium" },
          "max": { "model": "gemini-3.8-flash", "effort": "high" },
        },
        {
          "low": {
            "model": ["gpt-5.6-luna", "bedrock.gpt-5.6-luna"],
            "effort": "max",
          },
          "xhigh": {
            "model": ["gpt-5.6-sol", "bedrock.gpt-5.6-sol"],
            "effort": "medium",
          },
          "max": {
            "model": ["gpt-5.6-sol", "bedrock.gpt-5.6-sol"],
            "effort": "high",
          },
        },
      ],
    },
  },
}
```

A read-provider wrapper:

- permits only `sandbox` and `targets`;
- requires `targets` to be a non-empty array;
- treats every array element as a level map;
- permits `sandbox` only for `claude`, `copilot`, and `opencode`;
- rejects `sandbox` for `agy`;
- resolves omitted `sandbox` to `true`.

A target:

- is a non-empty sparse level map;
- permits only the five level keys;
- rejects flat `model`, `effort`, and `sandbox`;
- rejects nested target or candidate arrays;
- has stable identity `<canonical-provider>[<zero-based-index>]`;
- preserves declaration order.

### Write subagents

Every write-subagent entry is directly a sparse level map:

```jsonc
{
  "write-subagents": {
    "claude": {
      "low": { "model": "bedrock.claude-sonnet-5", "effort": "medium" },
      "max": { "model": "bedrock.claude-opus-5", "effort": "low" },
    },
    "copilot": {
      "low": {
        "model": ["gpt-5.6-luna", "bedrock.gpt-5.6-luna"],
        "effort": "max",
      },
      "max": {
        "model": ["gpt-5.6-sol", "bedrock.gpt-5.6-sol"],
        "effort": "low",
      },
    },
  },
}
```

A write-subagent entry:

- permits only the five level keys;
- has no `targets` wrapper because a host selects one native write subagent;
- rejects flat `model`, `effort`, and `sandbox`;
- rejects candidate arrays at the entry or level-map boundary.

### Level configuration

Every configured level requires exactly:

```jsonc
{
  "model": "model-id", // or a non-empty string array
  "effort": "provider-defined-effort"
}
```

Rules:

- both keys are required;
- no other keys are accepted;
- `model` is either one valid nonblank model string or a non-empty array of valid nonblank model
  strings;
- singleton model arrays are valid;
- duplicate strings within one model array are rejected;
- model-array order is significant;
- `effort` is a nonblank string validated by the existing provider-agnostic effort validator.

## Resolution semantics

### Sparse levels

A target or write subagent may configure any non-empty subset of the five levels. Resolution keeps
the existing algorithm:

1. exact requested level;
2. nearest configured lower level;
3. lowest configured higher level.

The selected level configuration is complete and used without field inheritance. Flat baseline
fields no longer exist.

Example: `{ low: A, xhigh: B, max: C }` resolves `medium` and `high` to `A`.

### Model alias cascade

For `model: [A, B, C]`, dispatch tries `A`, then `B`, then `C` immediately within the same target.
Every failure class advances the alias cascade, including authentication failures, because aliases
may select different underlying API keys or endpoints. Only after all aliases fail may dispatch
advance to the next selected or reserve target.

A string model behaves as a one-element cascade.

### CLI overrides

Explicit runtime `--model` and `--effort` flags remain valid and continue to override the resolved
level configuration for that invocation. The level-only restriction applies to persisted config,
not operator escape hatches.

## Target identity, selection, and consensus

Flatten read providers in provider declaration order, then target array order. For example:

```text
claude[0], copilot[0], copilot[1], opencode[0]
```

This flattened sequence governs:

- numeric phase `targets` selection;
- `targets: "all"`;
- candidate indexes;
- launch slots;
- reserve and retry ordering;
- target completion;
- consensus voice counting;
- doctor and structured diagnostics.

A numeric phase target count selects that many target elements, not that many providers.
`"all"` selects every target element. Two targets under one provider are two independent review
voices and count independently toward consensus. Output retains canonical provider metadata so
shared-provider targets remain visible.

A phase `only: [<provider>]` includes every target beneath the named provider. Indexed selectors
such as `copilot[1]` are outside the grammar.

### Duplicate targets

Two targets under one provider must not declare structurally identical complete level maps.
Validation canonicalizes object key order before comparison and preserves array order. Therefore:

- the same declarations in a different object-key order are duplicates;
- `[A, B]` and `[B, A]` are distinct because fallback order changes;
- targets that overlap at one resolved level but differ elsewhere are distinct.

This rejects accidental duplicate calls while preserving targets that intentionally diverge by
level or alias order.

## Sandbox policy

Sandbox is provider-wide. Its effective value applies identically to every target, selected level,
and model alias beneath that provider.

| Provider | `sandbox` accepted | Mechanism |
|---|---:|---|
| `claude` | yes | Provider CLI sandbox support |
| `copilot` | yes | Provider CLI sandbox support |
| `opencode` | yes | Linux Bubblewrap wrapper |
| `agy` | no | None configured |

Behavior:

- omitted resolves to `true`;
- `false` explicitly opts out and skips requesting/applying isolation;
- `true` requests isolation;
- when the installed CLI, OS, or Bubblewrap availability cannot supply isolation, dispatch runs
  unsandboxed and emits a security downgrade warning;
- the warning always appears on stderr and in structured result/doctor diagnostics;
- explicit and defaulted `true` degrade identically.

For OpenCode, the existing automatic Linux Bubblewrap detection becomes conditional on effective
sandbox. `sandbox: false` bypasses Bubblewrap even when installed. Effective `true` uses Bubblewrap
when available and warns before direct execution otherwise.

## Validation and diagnostics

Validation remains exhaustive: return every detected problem in one pass. Generic schema errors are
preferred over shape-specific migration guidance. Errors continue to identify the failing path,
valid keys or expected type, and `config.sample.jsonc` as the canonical comparison point.

Reject at minimum:

- bare candidate objects or arrays directly under a read provider;
- unknown wrapper keys;
- empty `targets` arrays;
- non-level keys in targets or write-subagent entries;
- incomplete level configurations;
- candidate arrays in a level map;
- misplaced or wrongly typed sandbox fields;
- sandbox on unsupported providers;
- invalid, empty, or duplicate model aliases;
- structurally duplicate target maps;
- existing unknown providers, duplicate aliases, unknown phases, invalid phase knobs, and v0.4
  shapes.

## Compatibility and migration

This is a breaking config contract. No compatibility parser or migration warning period is added.
The sample config demonstrates the only accepted shape.

Mechanical migration:

1. Wrap every read provider in `{ sandbox?, targets: [...] }`.
2. Move provider sandbox to that wrapper.
3. Convert each former candidate into a sparse level map.
4. Move every flat model/effort pair into an appropriate level object.
5. Convert each write-subagent entry to a sparse level map.
6. Keep model arrays inside level configurations; do not convert them into targets.

## Implementation surface

Future implementation must update atomically:

- `skills/dispatch/config.jsonc`;
- `skills/dispatch/config.sample.jsonc`;
- `skills/dispatch/scripts/config.mjs` validation and resolution;
- target flattening, selection, candidate-index, retry, reserve, and consensus paths;
- provider runners' model-alias fallback behavior;
- OpenCode's Bubblewrap control and all providers' sandbox downgrade reporting;
- doctor and structured diagnostics;
- `skills/dispatch/README.md` and directly related operational references;
- unit and integration tests for every rule and behavior in this specification;
- generated skill hashes after content stabilizes.

Preserve unrelated provider runner behavior and phase-policy semantics.

## Acceptance criteria

Implementation is complete only when all are true:

1. The shipped config and sample validate under the new schema and contain no model/effort outside
   level objects.
2. Every read provider uses the wrapper, and sandbox resolves once per provider.
3. Sparse resolution returns a complete selected level configuration without field inheritance.
4. Model arrays exhaust aliases on every failure before advancing targets.
5. Numeric counts and `all` operate on flattened targets; same-provider targets count independently
   toward consensus.
6. Provider-only phase filters include all targets beneath allowed providers.
7. Duplicate aliases and structurally duplicate targets are rejected with deterministic paths.
8. OpenCode obeys sandbox false, uses Bubblewrap for true when available, and degrades visibly when
   unavailable.
9. Claude and Copilot expose the same warning contract when sandbox support is unavailable.
10. CLI model/effort overrides retain their existing behavior.
11. Targeted tests plus `npm test` pass; `npm run hashes` is run when tests report hash drift.

## Decisions and rationale

| Decision | Rationale |
|---|---|
| Break incompatible shapes immediately. | The objective is a tight contract, not continued support for forms the active config does not use. |
| Require one wrapper for every read provider. | A uniform shape gives sandbox one unambiguous home and removes array/object semantic branches. |
| Name the array `targets`. | Its elements are independent dispatch units, not provider identities or model fallbacks. |
| Use positional target identity. | Config order already supplies stable operational identity; required names would add unused schema. |
| Require complete model and effort at every configured level. | Partial inheritance would accept more than the active configuration and obscure the resolved pair. |
| Preserve sparse level fallback. | The active config deliberately defines only transition points rather than all five levels. |
| Keep string and array model forms, including singleton arrays. | Current configuration uses both; arrays explicitly encode immediate alias fallback. |
| Advance aliases on every failure. | Alias entries may route through different API keys or endpoints, so even authentication failure may be alias-specific. |
| Reject duplicate aliases. | Repeating an identical model adds no fallback value. |
| Count every target independently. | Platform arrays were explicitly intended to provide separate dispatch targets and review voices. |
| Keep `only` provider-scoped. | Selecting all targets beneath a provider preserves the existing simple filter grammar. |
| Reject structurally identical targets. | Duplicate targets add indistinguishable calls; structural comparison avoids rejecting legitimate level overlap. |
| Ignore object-key order but preserve model-array order in duplicate checks. | Object order has no semantics; fallback order does. |
| Default sandbox to true while permitting false. | Isolation is the secure default, with an explicit operational escape hatch. |
| Support config-driven OpenCode sandbox. | The runner already owns a Bubblewrap mechanism; exposing it makes platform policy consistent. |
| Warn and run when sandbox is unavailable. | Availability was chosen over fail-closed behavior, provided the security downgrade is always visible and machine-readable. |
| Keep sandbox out of write subagents. | Native implementation subagents require workspace writes and have no separate target cascade. |
| Retain CLI overrides. | Persisted schema strictness should not remove explicit one-run operator control. |
| Use generic schema errors. | A migration-specific diagnostic surface was not desired for an intentionally breaking contract. |
