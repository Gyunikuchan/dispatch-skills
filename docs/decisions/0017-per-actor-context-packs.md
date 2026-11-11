# ADR 0017: Per-actor context packs with byte budgets

- **Status**: Accepted
- **Date**: 2026-11-08
- **Updated**: 2026-11-12
- **Audience**: Maintainers

## Context

Plan review took 69-100% of provider CLI tokens in the three runs that measured one (25.7M, 26.2M and 34.0M tokens). Cache reads are 86-91% of tokens, so cost follows turns times prefix size. Plans are 3-4x their spec. `Proposed Changes` is 29-59% of the file. `Review Findings & Resolutions` is 15-26% (10-13 KB), and reviewers re-read it while also receiving `### Settled in earlier rounds`. Plan review did not converge in two runs (20/20/13/14 and 24/12/11/10 findings). 19-27% of findings were duplicates.

The same rules lived in several files: `qualityCriteria` tailored actor text with exact-string `replace` calls that silently no-op on wording drift, `explorer-brief.md` and `test-cleanup-brief.md` had no renderer so placeholders had no fill check, and the map byte budget was stated in four places.

## Decision

Each normative rule has one canonical home and declares its audience with an `<!-- for: ... -->` tag on its own line in `quality-bar.md` (consumers `code`, `plan`, `design`, `writer`, `cleanup`, `explorer`, plus `all` for every render consumer and `author` for file readers only, which no renderer selects). `qualitySections` gains `cleanup: ['shared','testing']` and `explorer: ['shared']`; untagged bullets reach every consumer except `explorer`. Tag counts are fail-closed per `REQUIRED_TAGGED` (code 5, writer 6, plan 5, design 4, cleanup 6, explorer 3): an unknown consumer, unknown tag, empty selection or count mismatch throws instead of emitting unmodified text.

The toolkit renders explorer and test-cleanup briefs from their templates (`brief explorer`, `brief test-cleanup`), writing under `.state/briefs/` with fill checks that refuse missing values without writing. Rendered briefs contain no relative links.

Plan and design reviewers read governed text from `.state/reviews/<review>/round-<n>.input.md`, which holds the artifact without its `Review Findings & Resolutions` section; `### Settled in earlier rounds` stays the only source of prior rulings. Hashes, review identity and the findings refresh are unchanged.

The orchestrator loads only the current step's references: each verb guide carries a `| Step | Reads |` table with one relative link per step. Budgets enforced by `tests/integration/structural-targets.test.ts`:

| Pack | Budget (bytes) | Actual at authoring |
| --- | --- | --- |
| Every verb step (linked sections + `SKILL.md` + guide) | at most 37067 | at most 21555 |
| Plan authoring steps | at most 36914 | at most 21226 |
| Code reviewer prompt | 14648 | 14565 |
| Plan reviewer prompt | 16653 | 16565 |
| Design reviewer prompt | 12439 | 12351 |
| Writer brief pack | 10784 | 10784 |
| Explorer pack | 12638 | 8268 |
| Test-cleanup pack | 9523 | 9129 |
| Driver TS LOC | 15526 | 15514 (passes) |
| `SKILL.md` | 8900 | 8895 |
| Increment orchestrator brief | 4096 | 1674 |
| Ledger kinds | 14 | 14 |

Structural ceilings are a hint, not a gate needing user authorization: cut or consolidate first; a genuine new behaviour or rule may raise a ceiling with the reason recorded beside it and reported in the handoff; duplicates never justify a raise. Dead exports are removed only on index or reference evidence, and duplicate helpers merge to one owner with error handling and validation kept; files split by responsibility, never by length.

Step budgets sit 30% below the 52735 (plan authoring) and 52953 (implement launch through review) baselines. The SC5 explorer component estimates (brief 5418, map template 1824, shared 5396) predate the T1 audience tags and the T6 map-budget sentence, which added bytes to those components inside the pack total; the test enforces the pack totals plus the component budgets that still hold (explorer brief 5418, test-cleanup brief 1870, test-cleanup quality 7653), against actuals (explorer brief 5331, test-cleanup brief 1730).

Rule preservation follows the plan's preservation table: spec authoring moves to `spec-authoring.md`, failed-slot and repository-change rules to `review-coverage.md`, lint-code field notes to `plan-field-notes.md`, with duplicates merged into `explorer-brief.md`, `DEFAULT_MAP_BUDGET`, `test-cleanup-brief.md`, the quality bar, `SKILL.md` routing, `fanout.ts` and `review-coverage.md`. The suffix-less `repository-*` keys are removed under the `AGENTS.md` legacy rule.

## Baselines for the REQ-8 pilot

| Signal | Baseline runs |
| --- | --- |
| Delegate tokens (provider CLI) | 25.7M, 26.2M, 34.0M; review share 69-100%; cache reads 86-91% |
| Review rounds to settle | 20/20/13/14 and 24/12/11/10 (two runs did not converge) |
| Duplicate-finding rate | 19-27% |
| Findings-history weight | 15-26% of the plan file (10-13 KB), re-read alongside `### Settled in earlier rounds` |

## Pilot follow-up

- **Owner**: orchestrator of the first Dispatch plan run after merge.
- **Trigger**: that run's `diagnostics render`.
- **Note**: `.scratch/per-actor-packs-pilot.md`, comparing delegate tokens, review rounds and duplicate-finding rate against the baselines above.
- The pilot result stays pending and does not gate delivery; the single sample is indicative.

## Consequences

Delegate and subagent packs render from one source per rule with byte budgets that fail the build on regression. Reviewers stop re-reading findings history. The driver LOC ceiling is 15526 against a measured 15514, so the structural test passes with headroom. Writer and native token capture stays a follow-up; telemetry gaps stand.
