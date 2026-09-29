# ADR 0005: Review rounds policy

- **Status**: Accepted
- **Date**: 2026-09-29
- **Spec**: the review-rounds section of `skills/dispatch/references/review.md`

## Context

Automated code review runs in rounds. Each round a reviewer raises findings and the orchestrator
resolves them. `review --fix` and the code-review phase of `implement` previously followed
different re-review rules (`mustApplied` in `implement`, any applied fix in standalone
`review --fix`) and asked the user to extend or stop at the round cap. A per-level `consensus` config option
decided whether rejections needed reviewer confirmation at all; with `consensus: false` the
orchestrator's rulings were final. The policy has to satisfy
four needs:

- defects are dealt with promptly;
- review spending is bounded;
- blocking defects are never allowed through;
- errors by any single agent, the orchestrator included, are guarded against.

## Decision

| # | Decision | Rationale | Rejected |
|---|----------|-----------|----------|
| D1 | One review-rounds policy for `review --fix` and `implement`, defined once in `references/review.md` | Divergent policies handle the same finding differently by entry point, and separate descriptions produced contract gaps | Per-verb policies |
| D2 | Resolve every finding (fixed or `pending-rejection`) before deciding on another round | Defects are cheapest to handle while context is fresh; the round decision rests on outcomes, not raw findings | Deferring resolution to the end of the loop |
| D3 | Another round runs when a finding at or above the threshold was fixed or is pending rejection; threshold is `SHOULD` before the cap and `MUST` at or after it, evaluated after each round | Quality fixes are worth verifying before the cap; afterwards only blocking defects justify rounds; outcome-keyed triggers give every round something concrete to verify | Finding-keyed triggers |
| D4 | No round cap for `MUST` | A blocking defect is never acceptable to ship; the cap bounds spending on quality, not correctness | User extend/stop gate at the cap |
| D5 | The orchestrator finalizes rejections, and lets fixes stand unreviewed, only below the threshold; at or above it a rejection closes only when the reviewer agrees | The orchestrator can hallucinate or misjudge; agreement between agents beats one verdict for findings that matter | Orchestrator authority at all severities |
| D6 | Convergence check: halt and escalate to the user when a round re-raises a fixed finding (regression) or re-raises a pending rejection a second time (deadlock); findings match by location plus category with loose text similarity | D4 and D5 make loops possible; detecting non-convergence bounds them without silently accepting a defect; reviewers reword findings between rounds | A hard ceiling on `MUST` rounds (cap + N) |
| D7 | Always apply accepted fixes below the threshold, pass them through the final gate, and flag any fix no later round reviewed as `fixed-unreviewed` with its round | They are real defects; flagging by review status rather than cap status makes every unreviewed change visible | Flagging only post-cap fixes |
| D8 | Full-diff review before the cap; delta review (fixes since the previous round plus open `MUST` disputes) after it | Full review catches interactions before the cap; a narrow scope keeps an uncapped loop affordable | Full diff every round |
| D9 | Remove the `consensus` config option; reviewer confirmation of rejections is always on, for every review kind | D5 depends on reviewer agreement; an option that disables it would reintroduce single-agent verdicts on findings that matter | Keeping `consensus` for design/plan or report-only reviews; overriding it only for code `--fix`/`implement` |

The `MUST` ceiling in D6 was rejected because any ceiling eventually forces a choice between
shipping a blocking defect and halting a run that is still making progress.

## Consequences

- `implement` runs more rounds than a `MUST`-only policy, because `SHOULD` fixes are re-reviewed
  before the cap.
- A round can run with no code change, to settle a dispute at or above the threshold.
- Runs can end in escalation rather than completion; this is preferred to shipping an unresolved
  blocking defect.
- Some fixes below the threshold ship unreviewed; the completion output flags every one.
- Accepted residual risk: a run in which each `MUST` fix introduces a different new `MUST` is
  unbounded, because the convergence check only detects repeats.
- The round-cap `extend`/`stop` user gate is removed for code `--fix`/`implement` reviews.
- Breaking config change: `phases.*.consensus` is rejected by strict config validation
  (ADR 0001); configs that set it must delete the key. Level-dependent consensus (e.g. `low: false`)
  no longer skips reviewer confirmation, so low-level reviews can run an extra confirmation exchange.
