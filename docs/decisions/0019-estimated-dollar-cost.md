# ADR 0019: Estimated dollar cost in diagnostics

- **Status**: Accepted
- **Date**: 2026-11-15
- **Updated**: 2026-11-23
- **Audience**: Maintainers

## Context

Maintainers tune routing (cheaper explorer, utility, and writer models) for efficiency, but raw token counts hide a 5× to 50× spread in model rates and prompt-size pricing tiers. Previously, host transcript rows and delegate CLI stdout sums used separate counter logic, and provider prefixes or version suffixes prevented consistent model matching.

## Decision

### Unified usage layer with banded storage

One per-platform usage layer parses session transcripts and CLI stdout into per-request usage across host, delegate, and nested subagents without persisting raw requests. Capture folds each request into counters per `model#effort`, split into prompt-size bands at known tier thresholds (up to 32 keys plus an unpriced `other` bucket), with CLI stdout totals as a labeled fallback. Storing token counters by band rather than capture-time dollar amounts keeps historical runs repriceable when rate tables are updated.

### Shipped rate table with config override

A hash-tracked JSON rate table stores USD rates per million tokens, prompt-size tiers, dated `periods`, and sources. An optional config `pricing` table adds or overrides entries (including `route/model` and `route/*` wildcards); override issues warn in `doctor` without blocking launches. Pricing runs purely at render time using the run's UTC start date so historical sessions retain the rates in effect when they ran. Aggregator routes (`opencode-go`) use unsubsidized OpenRouter list prices for comparable cross-provider routing evaluation.

### Banded tier pricing and model ID matching

- **Tier pricing with range fallback:** A band within one tier prices the whole request at that tier; a band straddling a threshold, an unsplit aggregate above the lowest threshold, or an unsplit cache write with differing lifetime rates renders a `low–high` range with a named reason. Reasoning tokens add output-rate cost and count toward billed tokens only where reported separately from output (OpenCode and Antigravity).
- **Model ID resolution:** Qualified IDs match case-insensitively against exact `route/model`, then `route/*`, then longest generic model prefix after stripping route/version suffixes (covering Bedrock, Vertex, and dated aliases). Each priced unit records its rate origin, match kind, and tariff period without exposing local override secrets.

### Coverage notes and compaction-safe placement

Session and comparison reports share coverage calculations, separating unpriced models from missing-telemetry gaps. Native slots rely on host-subagent transcript rows rather than a synthetic estimate (avoiding double counting), and Copilot stays a documented telemetry gap. Cost totals appear in Summary, `Cost drivers` (top 5 groups by cost share), Overview phases, platform, stage, and `Review yield` tables rather than the Appendix so cost visibility survives report compaction.

## Consequences

Maintainers can compare estimated dollar cost across phases, platforms, roles, models, and efforts while seeing every pricing approximation or telemetry gap. The shipped rate table requires periodic refresh per the [toolkit reference](../../skills/dispatch/references/toolkit.md#diagnostics-render).
