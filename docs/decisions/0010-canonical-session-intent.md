# ADR 0010: Session artifacts, canonical intent, and layered governing documents

- **Status**: Accepted
- **Date**: 2026-10-16
- **Updated**: 2026-11-23
- **Audience**: Maintainers

## Context

Scattering temporary files across the repository or moving sessions to OS temp complicates recovery and creates competing authorities. Similarly, repeating intent and decisions across chat, designs, and plans causes layers to drift, while a single shared decision log would churn upstream spec hashes during tactical planning.

## Decision

### Session artifact governance

Keep human deliverables (`.spec.md`, `.design.md`, `.plan.md`, `.walkthrough.md`, context maps) and machine evidence (`ledger.jsonl`, `.state/`) together in one authoritative workspace session folder (`.scratch/dispatch-skills/<session>/`), identified in the handoff and retained until deliberate cleanup. An existing resolved spec keeps its path rather than copying into the session.

### Layered governing documents

Governing documents follow a strict hierarchy where each downstream layer cites upstream IDs (`REQ-<n>`, `DEC-<n>`, `AD-<n>`) instead of copying their content:

| Layer | Owns | Upstream relationship |
| --- | --- | --- |
| **Spec** | Why/what, `REQ` acceptance, non-goals, constraints, user-made `DEC`s, discussion, and open questions | Canonical intent owner ([spec template](../../skills/dispatch/references/templates/spec.md)) |
| **Design** (optional) | Strategy, `REQ`-to-component mapping, architecture/boundaries, architectural decisions (`AD`), risk/operations, increment graph, and optional advisory `Grounding leads:` | Pins direct spec path and `sha256` `Parent:` |
| **Plan** | Code background, tactical decisions, Task Map, scoped file changes, criteria (`SC<n>` tracing to `REQ-<n>`), verification, and rollback ([ADR 0008](0008-task-based-plans-and-bounded-parallel-writers.md)) | Pins direct spec (or design increment `Parent:` with transitive spec resolution) |
| **Implementation & Walkthrough** | Code, routine writer choices, and post-execution record of delivered behavior, criterion evidence, deviations, and review resolutions | Follows plan scope and criteria |

### Identity, approval, and readers

- **Canonical hashing:** Artifact identity uses the formatting-tolerant canonical SHA-256 hash from [`lint run`](../../skills/dispatch/references/toolkit.md#lint-run) (excluding generated `Review Findings & Resolutions` sections).
- **Settlement and approval:** Settle governing intent before `design`, `plan`, `implement`, or `review` (`ask` needs no spec). Confirm new-spec intent at every level before planning. At `medium` and above, implementation requires a user-quoted approval tuple binding spec, plan, and optional design hashes ([spec operation](../../skills/dispatch/references/spec-stage.md)).
- **Readers and review:** Authors, reviewers, and writers read the full governing spec so material decisions are never lost to summarization; writers also read shared plan context and their assigned task ([review rules](../../skills/dispatch/references/review-rules.md#intent-and-findings), [ADR 0005](0005-review-rounds-policy.md)).
- **In-place revision:** Edit canonical artifacts in place and append a ledger `edit` record ([toolkit](../../skills/dispatch/references/toolkit.md#edit)). Non-intent edits extend an approved chain; intent edits require a recorded user quote, a new spec `confirm`, and a new approval tuple where applicable ([revision protocol](../../skills/dispatch/references/spec-stage.md#revision-protocol)).

## Consequences

Deliverables and evidence stay recoverable in one workspace session, and intent remains durable and hash-bound across layers withoutupstream hash churn during tactical edits. Full-spec reads and explicit ID tracing trade reading tokens for shared authority.
