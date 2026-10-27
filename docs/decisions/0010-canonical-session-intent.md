# ADR 0010: Canonical session intent

- **Status**: Accepted
- **Date**: 2026-10-16
- **Audience**: Maintainers

> Engine mechanics superseded by [ADR 0013](0013-toolkit-and-ledger.md). The SPEC_REVISED/SPEC_SETTLED events below describe the removed engine. Current intent revision follows [spec operation](../../skills/dispatch/references/spec-stage.md#revision-protocol).

## Context

Intent previously lived in chat, optional specs and duplicated design/plan sections. Review context could reduce it to a short flag or commit messages. Authors, writers and reviewers could therefore work from different assumptions. One durable governing document makes requirements, decisions and their rationale available to every participant.

## Decision

### Format and identity

Use a hybrid spec: Spec Kit's intent, scenarios and requirements, a MADR-style decision log, and a discussion record. Requirements use `REQ-<n>` with acceptance bullets; decisions use `DEC-<n>`. These IDs remain distinct from tasks, plan criteria, design increments and review findings. The [spec template](../../skills/dispatch/references/templates/spec.md) owns headings and level-specific fields; `domain/spec.ts` lints them.

At low level, intent/problem, requirements, non-goals and constraints are required. Higher levels add background, decisions, discussion and open questions. Depth scales, but material constraints, rejected options and user decisions remain durable. Free-form prose lacks enforceable structure; Spec Kit or EARS alone lacks the decision/discussion home; MADR alone lacks requirements. A host-repository OpenSpec tree would add a second owner.

### Settlement and approval

All work verbs except `ask`, including every review kind, settle a governing spec before their work child runs. Missing input emits an author-spec await; `AUTHORED` triggers lint and raw-byte hashing through `parse-artifact`. There is no separate delegate spec-review stage: design and plan reviews inspect intent with the concrete proposal.

Before design or plan authoring at medium and above, user approval binds a sha256 and recorded user words. This includes nested authoring. Low-level work proceeds and shows the spec at handoff. Settlement alone adds no approval gate to standalone code review. Design approval and production-write approval remain separate. Always gating would add unnecessary low-level coordination; never gating would defer intent errors until expensive work.

### Resolution and canonical ownership

A design or standalone plan directly pins its spec path and hash. An increment plan pins a design increment and resolves the spec transitively through that design. Explicit `--spec` must agree with the governing chain; otherwise resolution uses the unique session spec. Ambiguity requires selection; missing pinned input requires restoration; changed bytes or paths require explicit revision. The removed `user request` Parent and `--context` are not compatibility paths.

New specs live at the session root. An existing spec resolved through a Parent or explicit path retains that owner, even across sessions. While Dispatch is active, other planning skills direct spec/design discussion into this canonical owner in Dispatch format. Merge material content and decisions before removing a stray, retain merge evidence, and obtain user approval before tracked deletion. Link-only adoption would preserve split ownership. Managed third-party skills remain unchanged. [ADR 0003](0003-chat-session-artifact-lifecycle.md) owns artifact lifecycle.

### Readers and review

Every downstream author and reviewer reads the whole spec; native writers also read their bounded plan range. This spends context to preserve shared intent rather than filtering away material decisions. Standalone review reuses governing intent or authors it from chat and diff, labels inferred requirements `(inferred)`, and records user decisions only with evidence. Commit logs and a short context flag cannot carry the complete discussion.

Reviewers check unmet REQs, contradicted DECs and flawed premises first. `intent` and `spec` findings route through the intent gate; `spec` is for defects in governing spec text, and `testing` identifies test-spec coverage gaps. The orchestrator accepts or rejects intent findings when the spec or a retained DEC settles them, with a cited reason; otherwise the ruling is `needs-user`. The [review rules](../../skills/dispatch/references/review-rules.md#intent-and-findings) own this protocol. [ADR 0007](0007-review-context-and-intent.md) records its context-channel supersession.

### Revision and recovery

Ordinary design/plan authoring changes its own layer, leaving the spec stable. A user answer that changes intent adds a DEC. Revision first reaches quiescence: reconcile immutable pending results and finish authorized live-writer receipts without duplicate effects. At an admitted boundary, `SPEC_REVISED` makes root re-read, lint and hash the spec; applicable authoring requires approval of the new hash. Root alone synthesizes internal `SPEC_SETTLED` to resume its parked child.

Changed pins require owning-artifact recovery: design-governed delivery revises and approves its design first; standalone stale artifacts halt for reauthoring. An increment consumer with a stale transitive design pin stops with `stale-design-spec`, including before writer launch. Standalone code review re-prepares full review while retaining earlier rulings/history. Accepted work and evidence remain retained; a new spec does not authorize replay or silent rebinding. [Spec operation](../../skills/dispatch/references/spec-stage.md#revision-protocol) owns admission and recovery details; [ADR 0006](0006-dispatch-state-machine.md) records the machine architecture.

## Consequences

Intent becomes inspectable and hash-bound, at the cost of full-spec reader context and explicit reauthoring after changed intent. These costs are deliberate: partial reads and silent pin repair lose alignment or conceal changed authority. [ADR 0011](0011-layered-governing-documents.md) owns the document-layer split; the shared quality bar remains in [ADR 0009](0009-shared-quality-bar-and-host-rule-precedence.md). Operational instructions stay in shipped references rather than this record.
