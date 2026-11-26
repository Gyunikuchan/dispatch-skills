# ADR 0001: Strict dispatch config format

- **Status**: Accepted
- **Date**: 2026-09-24
- **Audience**: Maintainers

## Context

Permissive configuration shapes (flat `model`/`effort` fields, bare provider arrays, and nested sandbox flags) made it ambiguous whether an array meant independent review voices or model fallbacks within one voice, and forced `effort` onto models that reject it.

## Decision

Use one strict schema validated by `doctor run` (with `--probe` for live readiness and sandbox capability), pointing invalid shapes to `config.sample.jsonc`:

- **Root tables:** `read-delegates`, `write-subagents`, `utility-subagents` (renamed from `explore-subagents`, with a required `context-limit`), `phases`, and optional `diagnostics`, `write-concurrency`, `read-commands`, and `pricing`.
- **Read delegates and models (`read-delegates`):**
  - Each provider is `{ sandbox?, targets: [...] }`. `targets` is a non-empty array of sparse level maps, one per independent voice with positional identity `<provider>[<index>]`. Provider declaration order, then target order, determines counts, `all`, reserves, completion, and review affinity ([review rules](../../skills/dispatch/references/review-rules.md#rulings-and-fix-scope)). `only` selects providers, not individual targets; structurally identical targets are rejected.
  - Sparse level maps draw keys from `low`, `medium`, `high`, `xhigh`, and `max`, resolving to the exact level, else nearest lower, else lowest higher. Each entry allows only `{ model, effort? }` and stands alone so an inherited `effort` cannot leak into a model that rejects it.
  - `model` is a nonblank string or ordered non-empty array of distinct aliases that cascade _within one voice_ across failures (including auth and quota). Optional `effort` is a nonblank provider-defined string; omitting it passes no effort flag (`null` or blank is rejected). CLI `--model`/`--effort` overrides still apply per run.
- **Sandbox and writers:**
  - `sandbox` lives on the provider wrapper, defaults to `true`, and is accepted for Claude, Copilot, OpenCode (Bubblewrap), and Codex, not `agy`. With `sandbox: true`, a provider that cannot activate its sandbox fails the slot as `sandbox-unsupported` and cascades to reserves rather than running unsandboxed ([delegate runner](../../skills/dispatch/scripts/providers/runner.ts)); running unsandboxed requires explicit `sandbox: false`.
  - `write-subagents` uses a bare level map without `targets` or `sandbox` because native writers need workspace writes and do not represent multiple review voices.
- **Review policy (`phases`):**
  - Accepts `plan-review` and `code-review` only. Design reviews keep distinct `design-review` records and identities while sharing `plan-review` target counts, rounds, and provider allowlists under [ADR 0005](0005-review-rounds-policy.md).

## Consequences

Validation, selection, retries, sandbox reporting, and `doctor` output enforce one unambiguous shape. Hosts where a provider cannot sandbox (e.g., Claude on native Windows or OpenCode without Linux Bubblewrap) require explicit `sandbox: false`.
