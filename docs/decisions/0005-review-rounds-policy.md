# ADR 0005: Review rounds, context, and confirmation policy

- **Status**: Accepted
- **Date**: 2026-09-29
- **Updated**: 2026-11-23
- **Audience**: Maintainers

## Context

Read-only reviewers do not share the orchestrator's chat history, and a diff or commit message alone cannot establish requested outcomes or settled user decisions. At the same time, treating the reviewed artifact's own decisions as settled or anchoring every voice on a shared context map upfront causes independent models to make correlated errors.

During review rounds, a hard round cap bounds cost but cannot guarantee a blocking defect is resolved, while an unconfirmed orchestrator rejection can repeat the orchestrator's own blind spot. Conversely, unbounded MUST rounds mostly chase fix-induced regressions, and tight uniform idle timeouts caused false stops when streaming delegates paused inside a reasoning step (up to 137 s observed inside a step versus no silent gaps above 60 s between steps).

## Decision

### Intent and context composition

- **Spec-first reading:** Separate governing intent ([ADR 0010](0010-canonical-session-intent.md)) from implementation evidence. Reviewers read the full governing spec first. They treat the spec's Decisions and Non-goals—and decisions in an approved parent design or plan other than the artifact under review—as settled, never the reviewed artifact's own decisions.
- **Pre-registration and context maps:** In round 1 of a plan or design review, reviewers pre-register 3–5 expected changes and risks from the spec and touched code before opening the artifact or context map. The context map is a pre-change locator (omitted from code review, where it is stale), not a completeness claim; reviewers verify claims at source and run their own consumer/caller searches. Quality-family bullet order rotates across slots so independence comes from model diversity rather than prompt slicing.
- **Holistic voices:** Reviews use whole-target voices across providers rather than diff-sliced micro-reviewers so each voice retains cross-file architectural context.

### Rounds, confirmation, and fix verification

- **Caps, continuation, and ceiling:** One policy governs plan, design, and code review ([review rules](../../skills/dispatch/references/review-rules.md)). Routine quality rounds stop at the saved round-1 cap, while accepted MUST fixes and pending MUST rejections continue up to the ceiling (`cap + 2`, plus 2 per user grant) before escalating through the [review escalation Decision Frame](../../skills/dispatch/references/decision-frame.md#review-escalation).
- **Rejected MUST confirmation:** A rejected MUST requires explicit agreement from the original logical source slot (or configured reserve/native substitute) so unilateral orchestrator rejection cannot silence an independent check. When no decisive finding or target move requires a full/narrowed round, a compact confirmation-only prompt checks pending MUST rejections at minimal token cost. Repeated disagreement or non-response escalates to the user.
- **Inter-round context and fix review:** Re-reviews receive inter-round comparisons and `### Settled in earlier rounds` (with clipped defect/rationale lines and `(new)` markers) to judge `origin` (`original`, `fix-induced`, `unknown`). Every accepted plan or design fix batch (including final-round SHOULD fixes) runs an advisory `brief fix-review-lite` explorer before the next round or report; code and integration fixes use the fixer's consumer self-check.
- **Churn controls before the next round:** Fixers (review rules step 4) name the tests, golden fixtures and byte or line ceilings that pin the text they change, with current headroom, and list and re-check the consumer of each qualifier, branch or field a fix deletes or narrows; the fix-review-lite explorer runs the same consumer search on plan and design batches. Plan authors and reviewers apply the quality-bar `Pins:` bullet, so each task names its pins and owns every golden, generated output or ceiling its change can exceed. These controls target byte-ceiling headroom defects and fix-induced regressions.
- **Round cause as measurement:** Each review round after round 1 saves `cause` (`primary` and partitioned `counts`) in `findings.json`, and `diagnostics render` lists each round past the saved cap by cause or `unrecorded`. The cause changes no admission, roster, cap, ceiling or round count.

### Phase-aware idle limits and session resume

- Streaming CLI delegates that emit step events stop after 60 s of silence between steps and 180 s inside a step (unclassified lines default to the longer limit); other streaming delegates stop after 120 s, and Claude and Antigravity are never idle-stopped. Stopped or unfinished CLI slots resume in their saved session within the resume limit ([provider controls](../../skills/dispatch/references/providers.md#shared-provider-controls), [review contract](../../skills/dispatch/references/toolkit.md#review-run)).

## Consequences

Reviewers share durable intent with authors and writers while resisting framing bias through round-1 pre-registration. Blocking defects and disputed MUST rejections get independent closure or escalate cleanly at the ceiling, and phase-aware idle timeouts eliminate false mid-step kills.
