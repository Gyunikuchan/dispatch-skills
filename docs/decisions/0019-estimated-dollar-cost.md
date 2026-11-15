# ADR 0019: Estimated dollar cost in diagnostics

- **Status**: Accepted
- **Date**: 2026-11-15
- **Audience**: Maintainers

## Context

Maintainers tune routing (cheaper explorer, utility and writer models) for token efficiency, but `diagnostics.md` reported token counts only, which hide a 5× to 50× spread in model rates. Rates also depend on prompt size for a growing number of models, so a per-invocation sum cannot price them. Usage capture was split in two families: host and host-subagent usage read per-request rows from transcripts, while delegate usage was summed per invocation from CLI stdout, with three copies of counter summation. Nested subagents, cache-write lifetimes and reasoning billing differed by platform, and ids with provider prefixes or version suffixes did not map to one model.

## Decision

### Unified usage layer with banded storage

One per-platform usage layer parses stdout and session data into per-request usage for host, delegate and nested-subagent capture (DEC-8, DEC-6, DEC-4). Requests never persist. Capture folds each request into counters per `model#effort`, split into prompt-size bands at the known tier thresholds, with at most 32 keys and an unpriced `other` key beyond them (DEC-10). Delegates read their own session data per launch and use stdout totals as a labelled fallback (DEC-2).

Rationale: one code path per platform removes duplicate summation and fix sites; bands give exact tier pricing at bounded size; storing counters instead of cost keeps stored facts repriceable after a rate refresh. Rejected: per-request rows (row cap, folding and resume reconciliation without a reader), capture-time pricing (stale cost after a rate refresh) and two parallel families.

### Shipped rate table with a config override

A hash-tracked JSON table holds USD rates per million tokens, ordered prompt-size tiers, a reasoning rule, sources and an as-of date. A config `pricing` table adds or replaces entries, including `provider/*` entries. Pricing is a pure module that runs at render (DEC-1).

Rationale: rendering needs no network and no tokens; the override covers local and partner-priced models. Override problems warn in `doctor` and never block a launch, because a typo in a rate must not stop a writer. Only models with a confirmed official rate ship; others render unpriced until confirmed or overridden. Rejected: render-time fetch (runtime dependency, unconfirmed tier data) and config-only rates (user burden).

### Banded tier pricing with a range fallback

A band prices at the tier it lies in, and the tier prices the whole request. A band that a threshold splits, an aggregate above the lowest threshold, or an unsplit cache write on a model whose lifetime rates differ renders a low-to-high range with a named reason (DEC-2). Reasoning adds output-rate cost only where the source reports it apart from output.

Rationale: exact where capture knows the request size, bounded and labelled where it does not. Rejected: base-tier lower bound and worst case (biased) and range-only (avoidably imprecise).

### Model id matching

An id lowercases, uses a `provider/*` entry when one exists for its prefix, then strips the provider prefix and version suffixes and takes the longest table key that it ends with at a boundary (DEC-3).

Rationale: covers Bedrock, Vertex and OpenCode ids and dotted names such as `gpt-6.1-terra` without an alias list. Rejected: first-dot split (breaks dotted versions) and exact match with manual aliases (misses prefixes, user burden).

### Coverage-note policy for unpriced and approximate usage

The report names each reason a cost is incomplete or a range, instead of hiding it in a total: `unpriced model`, `no token breakdown`, `no usage`, `tier unknown`, `cache TTL unknown` and `transcript unavailable`. Unpriced usage adds no cost and is counted in the Summary. Native estimated rows stay unpriced because host-subagent rows already measure the same work (DEC-7); Copilot reports no usage and stays a note (DEC-4). Cost appears in the Summary, Overview phases, platform and stage tables, not in the Appendix, so totals survive report compaction, and folding keeps the largest rows (DEC-5).

Rationale: every imprecision stays visible, so cost compares routing choices honestly. Rejected: blended rates for native estimates (double count, arbitrary rate) and cost per invocation in the Appendix (no reader).

## Consequences

Maintainers compare routing cost per run, phase, platform, stage, model and effort, and see how current the rates are. The table needs a refresh when official rates change; the refresh procedure lives in the [toolkit reference](../../skills/dispatch/references/toolkit.md#diagnostics-render). Resume state saved before banded storage takes one restart, and a resumed launch whose session data is unreadable after a session-data launch is unmeasured and labelled instead of reconciled.
