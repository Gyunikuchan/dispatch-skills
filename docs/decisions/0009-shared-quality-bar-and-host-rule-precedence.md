# ADR 0009: Shared quality bar and host-rule precedence

- **Status**: Accepted
- **Date**: 2026-10-15
- **Audience**: Maintainers

## Context

Writers and reviewers need the same quality criteria before work starts. Reviewer-only rules create avoidable fix rounds. Unclear precedence also lets Dispatch defaults conflict with deliberate host conventions.

## Decision

Keep shared, code, plan and design criteria in one [quality bar](../../skills/dispatch/references/templates/quality-bar.md). Prompts and authoring guidance point to applicable criteria rather than maintaining separate copies.

Host rules govern first; the quality bar fills gaps. Host precedence does not expand approved scope or relax write, verification and safety boundaries. Writers report conflicts between host rules and their brief for adjudication. Reviewers assess work against applicable host rules instead of flagging each compliant instance against a Dispatch default.

Keep writer execution protocol in the [write brief](../../skills/dispatch/references/templates/writer-brief.md) and [implementation reference](../../skills/dispatch/references/verbs/implement.md). Keep repository test entrypoints and storage guidance in [AGENTS.md](../../AGENTS.md). The quality bar owns quality criteria, not execution machinery.

## Consequences

Authors, writers and reviewers share one standard while host repositories retain their conventions. Applicable criteria add reading cost; fewer fix rounds are an intended benefit, not a measured result. Template assembly details belong to the toolkit implementation; this record owns standards and precedence.
