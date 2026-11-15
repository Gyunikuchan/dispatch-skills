# ADR 0007: Review context and intent composition

- **Status**: Accepted principle
- **Date**: 2026-10-02
- **Updated**: 2026-11-15
- **Audience**: Maintainers

## Context

Read-only reviewers do not share the orchestrator's chat history. A diff or commit message alone cannot establish the requested outcome, deliberate trade-offs or user decisions. Synthetic walkthroughs and short context summaries lose that distinction.

Attaching the reviewed artifact's own decisions as settled and sharing one context map upfront can also anchor every voice on the author's framing and any shared map omissions, causing independent models to make correlated errors.

## Decision

Separate governing intent from implementation evidence. The settled spec carries requirements and user decisions; plans, walkthroughs, diffs and verification results show how the work addresses them. Reviewers read the whole governing spec first and inspect relevant evidence.

Reviewers treat the governing spec's Decisions and Non-goals, and decisions recorded in an approved governing design or plan other than the artifact under review, as settled — never the artifact under review itself (code review continues to treat the plan's `Key Decisions & Context` as settled).

In round 1 of a plan or design review (when not a re-review or rerun with settled rulings), reviewers pre-register 3-5 expected changes and risks in plain text from the spec and touched code before opening the artifact under review or the context map, then judge the artifact against both the spec and that list. The context map is a pre-change locator, not a completeness claim: reviewers verify claims at source and run their own consumer and caller search for each contract the artifact changes. Every voice receives the same prompt except for the rotated order of quality-family bullets, so independence comes from model diversity.

Standalone review reuses governing intent or authors a spec from chat and inspected artifacts, labels inferred requirements, and records user decisions only with evidence. Artifact ambiguity requires investigation rather than selection of an arbitrary or newest file.

## Consequences

Reviewers share intent with authors and writers, at the cost of reading the full spec, authoring it when missing, and spending extra round-1 turns on spec-first pre-registration and independent consumer/caller searches (with no extra delegate launches). Changed intent requires a recorded user decision and updated downstream obligations. [Spec operation](../../skills/dispatch/references/spec-stage.md) owns resolution and revision; [review rules](../../skills/dispatch/references/review-rules.md) own adjudication and review history.
