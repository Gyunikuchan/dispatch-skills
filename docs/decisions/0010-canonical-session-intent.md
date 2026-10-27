# ADR 0010: Canonical session intent

- **Status**: Accepted; execution updated for [ADR 0013](0013-toolkit-and-ledger.md)
- **Date**: 2026-10-16
- **Audience**: Maintainers

## Context

Intent scattered across chat and repeated design/plan sections lets participants work from different assumptions. One durable governing spec preserves requirements, decisions and rationale for authors, reviewers and writers.

## Decision

### Format and identity

The spec owns intent, requirement acceptance, constraints, user decisions, discussion and open questions. REQ and DEC IDs remain distinct from tasks, plan criteria and design decisions. The [spec template](../../skills/dispatch/references/templates/spec.md) owns exact headings and level-specific fields.

Artifact identity uses the formatting-tolerant canonical hash reported by toolkit lint. Incidental formatting and report history do not define a new approval identity. The [toolkit contract](../../skills/dispatch/references/toolkit.md#lint-run) owns hashing behavior.

### Settlement and approval

Settle governing intent before design, plan, implement or review work; ask needs no spec. Confirm new-spec intent before planning. At medium and above, implementation uses one approval tuple for the spec, plan and optional design hashes, backed by actual user words. Design approval precedes increment planning and is recorded with the first plan's tuple. Low-level work shows governing artifacts at handoff; standalone review settlement adds no approval gate.

### Resolution and canonical ownership

Follow plan/design Parent pins to the governing spec; an increment plan follows its design. Otherwise reuse the single session spec. Investigate ambiguity before selection. A missing spec is authored from chat and inspected artifacts, with inferred requirements identified and user decisions supported by evidence.

New specs use the session root. Preserve an existing resolved spec's path. Other planning skills direct their output into this canonical owner. Merge stray material before removal; tracked deletion follows the user gate. [ADR 0003](0003-chat-session-artifact-lifecycle.md) records session artifact ownership; [ADR 0011](0011-layered-governing-documents.md) separates document layers.

### Readers and review

Authors, reviewers and writers read the whole governing spec. Writers also read shared plan context, their task, criteria and verification commands. This reading cost preserves material decisions that a short summary can omit.

Reviewers check unmet requirements, contradicted decisions and flawed premises. The orchestrator resolves settled intent claims with cited spec evidence and escalates unsettled intent. [Review rules](../../skills/dispatch/references/review-rules.md#intent-and-findings) own adjudication; [ADR 0007](0007-review-context-and-intent.md) records the distinction between intent and implementation evidence.

### Revision and recovery

Edit canonical artifacts in place. Record before/after hashes, classification, affected tasks, rationale and diff reference in a ledger edit record. Non-intent edits can extend an approved chain; intent changes require a recorded user quote and a new approval tuple where applicable.

Update dependent references and verification obligations before their next use. Continue unaffected writers and notify affected writers; preserve handles, candidates, evidence and review history. [Spec operation](../../skills/dispatch/references/spec-stage.md#revision-protocol) owns the revision procedure. The former engine events and quiescent revision gates have been removed.

## Consequences

Intent becomes durable and hash-bound, at the cost of full-spec reading and explicit updates after changed intent. Operational rules stay in shipped references; this record explains why a canonical owner is required.
