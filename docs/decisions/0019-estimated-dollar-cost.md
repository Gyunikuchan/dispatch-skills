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

A hash-tracked JSON table holds USD rates per million tokens, ordered prompt-size tiers, dated rate `periods`, sources and an as-of date (no per-entry `reasoning` key). A config `pricing` table adds or replaces entries with the same schema, including exact `route/model` and `route/*` entries. Pricing is a pure module that runs at render using the run's UTC start date (earliest positive capture start, else session `createdAt` date, else base rates) so historical sessions keep the rates in effect when they ran (DEC-1). Aggregator-routed models (`opencode-go`) use the OpenRouter list price of their undated model id so routing choices compare on one unsubsidized market basis.

Rationale: rendering needs no network and no tokens; dated periods avoid repricing historical runs on a rate refresh; the override covers local and partner-priced models. Override problems warn in `doctor` and never block a launch, because a typo in a rate must not stop a writer. Only models with a confirmed official rate ship; others render unpriced until confirmed or overridden. Rejected: render-time fetch (runtime dependency, unconfirmed tier data), config-only rates (user burden), and subsidized plan-limit rates (not comparable across providers).

### Banded tier pricing with a range fallback

A band prices at the tier it lies in, and the tier prices the whole request. A band that a threshold splits, an aggregate above the lowest threshold, or an unsplit cache write on a model whose lifetime rates differ renders a low-to-high range with a named reason (DEC-2). Reasoning adds output-rate cost and counts toward billed-token totals only where the source reports it apart from output (OpenCode and Antigravity).

Rationale: exact where capture knows the request size, bounded and labelled where it does not; billed-token totals match billing. Rejected: base-tier lower bound and worst case (biased) and range-only (avoidably imprecise).

### Model id matching

Match a qualified id case-insensitively against the exact `route/model`, then `route/*`. If neither applies, strip the route and version suffixes and match the longest generic key at a boundary. Bare model ids use generic matching. Use the observed provider and model when the usage source supplies both, and label configured model fallbacks separately. Each priced unit retains the shipped or override origin, match kind, UTC effective day or base-rate fallback, and the selected tariff period.

Rationale. A route can have a model-specific tariff while a wildcard still covers local routes. Generic normalization handles Bedrock and Vertex prefixes and dotted model names. Bounded provenance explains estimates without exposing local override keys or rates.

### Coverage-note policy for unpriced and approximate usage

The session report and matched comparison share the coverage calculation. The role summary shows observed billed tokens and the priced subtotal with collection gaps. Unpriced units are counted separately from gaps without a usage row. Usage source and coverage describe the evidence, while cost notes describe missing or approximate pricing. Native slots have no separate estimate path because host-subagent rows already measure native work (DEC-7); Copilot reports no usage and stays a note (DEC-4). Cost appears in the Summary, `Cost drivers` (up to five stage/platform/role/model/effort groups ranked by cost share, surviving compaction like the Summary), Overview phases, platform, stage, and `Review yield by kind, provider and model` tables, not in the Appendix, so totals survive report compaction, and folding keeps the largest rows (DEC-5).

Rationale: every imprecision stays visible, so cost compares routing choices honestly. Rejected: blended rates for native estimates (double count, arbitrary rate) and cost per invocation in the Appendix (no reader).

## Consequences

Maintainers compare routing cost per run, phase, platform, stage, model and effort, and see how current the rates are. The table needs a refresh when official rates change; the refresh procedure lives in the [toolkit reference](../../skills/dispatch/references/toolkit.md#diagnostics-render). A resumed launch without usable session data can contribute validated launch-scoped stdout counters. Cumulative stdout after an earlier session-only read leaves the launch unmeasured.
