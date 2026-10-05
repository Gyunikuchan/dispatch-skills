# Dispatch efficiency evaluation

Maintainer protocol for judging whether an instruction change, such as post-GREEN refactor inspection, improves verified delivery cost or speed. It uses evidence Dispatch already retains. It adds no instrumentation, does not enable diagnostics by default, and does not change local configuration.

The question is total cost to a verified result, not the number of TDD steps. A cheaper run that needs more repairs or fails review is not an improvement.

## What counts as evidence

- **Measurement:** a value read from a retained artifact with known coverage.
- **Unavailable:** a value no retained artifact records. Record `unavailable`; never estimate, interpolate, or treat it as zero.
- **Opinion:** reviewer or maintainer judgment. Label it as such and keep it out of numeric comparisons.

Instruction word counts measure prose load only. A word reduction alone does not establish token, time, or cost savings.

## Sources

| Source | Provides | Coverage caveat |
| --- | --- | --- |
| Git revision and `skills/dispatch/skill-hashes.json` | Instruction revision and shipped file hashes | Unshipped `.agents/skills/` files need their own Git blob hashes |
| `diagnostics.md` (opt-in `"diagnostics": true`) | Session timing and supported provider-usage summaries | Partial when a provider or execution surface reports no usage; see [usage provenance](diagnostic-usage-provenance.md) |
| Session journals and receipts | Phase transitions, admission and integration results, repair attempts | Only for runs whose session directory was retained |
| Verification and admission records | Commands run, pass/fail, admission defects | Durations only where recorded |
| Review reports and rulings | Findings, adjudicated outcomes, rounds | Rulings are adjudicated claims, not proof of defects |

## Observation table

Record one row per run. Every cell names its source artifact and collection method; a missing value is `unavailable`, not blank.

| Field | Notes |
| --- | --- |
| Run id and session directory | Retained location |
| Instruction revision | Commit plus relevant file hashes |
| Task | Representative task id and size class; compare like with like |
| Model, effort, provider, concurrency, tooling | Confounders; differences prevent a direct comparison |
| Whitespace-delimited word counts | Changed instruction files, before and after (`wc -w`) |
| Elapsed active time per phase | Exclude approval and user wait; record that wait separately |
| Verification duration | Only when recorded; otherwise `unavailable` |
| Invocation counts | Writers, reviewers, providers; distinct from elapsed time, since overlapping delegates make total work exceed wall time |
| Token subtotals | Per provider and scope as diagnostics reports them; never sum incompatible scopes |
| Repair attempts and admission defects | From journals and admission records |
| Review findings and adjudicated outcomes | Accepted/rejected counts by severity |
| Final verification outcome | Pass/fail of required final commands |
| Coverage | Which fields were measured, partial, or unavailable |

## Comparison method

1. Choose representative tasks that exercise the changed instructions. Run or select comparable runs for the baseline and changed revisions with identical model, effort, provider, concurrency, and tooling. When any differ, report the difference as a confounder rather than adjusting for it.
2. Fill the observation table for every run, including failed and abandoned runs.
3. Compare correctness first: final verification, admission defects, repair attempts, and accepted review findings. A cost or time gain accompanied by more repairs or accepted findings is a regression unless explained.
4. Compare elapsed active time and invocation work separately, then token subtotals where both sides have the same coverage.
5. Report the sample size, per-run spread, and comparison uncertainty. With few runs, report observations, not a trend.

## Reporting rules

- Pass only when correctness outcomes are no worse and a measured cost or time dimension improves with comparable coverage.
- State every unavailable field and confounder next to the result.
- Claim no percentage improvement without adequate measured evidence on both sides.
- Keep diagnostics opt-in; propose instrumentation separately when a needed field is persistently unavailable.
