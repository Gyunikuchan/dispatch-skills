# ADR 0007: Review context and intent composition

- **Status**: Accepted principle; intent ownership updated by [ADR 0010](0010-canonical-session-intent.md)
- **Date**: 2026-10-02
- **Audience**: Maintainers

## Context

Read-only reviewers do not share the orchestrator's chat history. A diff or commit message alone cannot establish the requested outcome, deliberate trade-offs or user decisions. Synthetic walkthroughs and short context summaries lose that distinction.

## Decision

Separate governing intent from implementation evidence. The settled spec carries requirements and user decisions; plans, walkthroughs, diffs and verification results show how the work addresses them. Reviewers read the whole governing spec and inspect relevant evidence.

Standalone review reuses governing intent or authors a spec from chat and inspected artifacts, labels inferred requirements, and records user decisions only with evidence. Artifact ambiguity requires investigation rather than selection of an arbitrary or newest file.

## Consequences

Reviewers share intent with authors and writers, at the cost of reading the full spec and authoring it when missing. Changed intent requires a recorded user decision and updated downstream obligations. [Spec operation](../../skills/dispatch/references/spec-stage.md) owns resolution and revision; [review rules](../../skills/dispatch/references/review-rules.md) own adjudication and review history. The old context flag, commit-log synthesis and automatic plan/walkthrough discovery rules have been retired from this record.
