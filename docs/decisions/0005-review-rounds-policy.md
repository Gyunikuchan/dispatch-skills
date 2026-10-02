# ADR 0005: Review rounds policy

- **Status**: Accepted; extended to every review kind by [ADR 0006](0006-dispatch-state-machine.md)
- **Date**: 2026-09-29
- **Spec**: the review-rounds section of `skills/dispatch/references/review-rules.md`

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
| D1 | One review-rounds policy for every review kind (plan, design, code) and mode (fix or report-only), defined once in `references/review-rules.md` and enforced by `policy/rounds.ts` (ADR 0006) | Divergent policies handle the same finding differently by entry point, and separate descriptions produced contract gaps | Per-verb or per-kind policies; a separate rebuttal-wave protocol for plan, design, or report-only reviews |
| D2 | Resolve every finding (fixed or `pending-rejection`) before deciding on another round | Defects are cheapest to handle while context is fresh; the round decision rests on outcomes, not raw findings | Deferring resolution to the end of the loop |
| D3 | Another round runs when a finding at or above the threshold was fixed or is pending rejection; threshold is `SHOULD` before the cap and `MUST` at or after it, evaluated after each round | Quality fixes are worth verifying before the cap; afterwards only blocking defects justify rounds; outcome-keyed triggers give every round something concrete to verify | Finding-keyed triggers |
| D4 | No round cap for `MUST` | A blocking defect is never acceptable to ship; the cap bounds spending on quality, not correctness | User extend/stop gate at the cap |
| D5 | The orchestrator finalizes rejections, and lets fixes stand unreviewed, only below the threshold; at or above it a rejection closes only when the reviewer agrees | The orchestrator can hallucinate or misjudge; agreement between agents beats one verdict for findings that matter | Orchestrator authority at all severities |
| D6 | Convergence check: halt and escalate to the user when a round re-raises a fixed finding (regression) or re-raises a pending rejection a second time (deadlock); findings match by location plus category with loose text similarity | D4 and D5 make loops possible; detecting non-convergence bounds them without silently accepting a defect; reviewers reword findings between rounds | A hard ceiling on `MUST` rounds (cap + N) |
| D7 | Always apply accepted fixes below the threshold, pass them through the final gate, and flag any fix no later round reviewed as `fixed-unreviewed` with its round | They are real defects; flagging by review status rather than cap status makes every unreviewed change visible | Flagging only post-cap fixes |
| D8 | Full-target review before the cap; delta review (fixes since the previous round plus open `MUST` disputes) after it; a round in which nothing was fixed reviews disputes only | Full review catches interactions before the cap; a narrow scope keeps an uncapped loop affordable; a dispute-only round costs what a targeted confirmation costs | Full target every round; dedicated rebuttal waves |
| D9 | Remove the `consensus` config option; reviewer confirmation of rejections is always on, for every review kind | D5 depends on reviewer agreement; an option that disables it would reintroduce single-agent verdicts on findings that matter | Keeping `consensus` for design/plan or report-only reviews; overriding it only for code `--fix`/`implement` |
| D10 | Affinity is a roster rule: each pending rejection rides to the slot that raised it, or to that slot's substitute | The raising reviewer is best placed to accept or re-raise; routing needs no extra wave | Any reviewer in the next round |
| D11 | A finding category `intent` (the governing plan or design itself is wrong) must be ruled `needs-user`; the answer may trigger a revision | Plan-level disagreement belongs to the user, reached in one round instead of after two re-raises | Treating intent disputes as ordinary findings |
| D12 | For plan and design reviews, a fix is a revision of the document, verified by re-parsing and linting it; in report-only reviews, accepted findings are recorded without edits and only pending rejections at or above the threshold trigger another round | The same loop serves documents, code, and report-only reviews | Kind-specific loops |

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
- There is no round-cap `extend`/`stop` user gate for any review kind.
- After the cap, orchestrator rejections of `SHOULD` findings are final for plan and design reviews as
  well as code reviews.
- Breaking config change: `phases.*.consensus` is rejected by strict config validation
  (ADR 0001); configs that set it must delete the key. Level-dependent consensus (e.g. `low: false`)
  no longer skips reviewer confirmation, so low-level reviews can run an extra confirmation exchange.
