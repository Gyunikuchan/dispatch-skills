# ADR 0012: Orchestrator as user deputy

- **Status**: Accepted
- **Date**: 2026-10-18
- **Audience**: Maintainers

> Engine mechanics superseded by [ADR 0013](0013-toolkit-and-ledger.md). Frame and await names below describe the removed engine; the user deputy and decision-frame principles remain in force.

## Context

Host agents coordinating `dispatch` across native platforms frequently fall into passive message-relay patterns: dumping uncurated delegate claims, asking open-ended questions, or punting verifiable factual checks to the human. This pattern inflates human cognitive load, introduces review fatigue, and directly contradicts the core product objective: *"catch flawed assumptions early and reduce the cost and time of verified delivery while minimizing routine human coordination."*

While existing principles mandate recoverable autonomy and evidence-based adjudication, they did not explicitly define the orchestrator's executive deputy posture or establish a structured distillation requirement when escalating decisions to the user.

## Decision

| # | Decision | Rationale | Rejected alternatives |
|---|----------|-----------|-----------------------|
| D1 | **Executive deputy posture:** The orchestrator acts as the user's executive deputy. It verifies facts, adjudicates delegate claims, and resolves routine trade-offs autonomously before consulting the human. | Shields the user from routine coordination; treats delegates as informants rather than voting blocs. | Passive relay (dumping raw delegate output onto the user); unconstrained autonomy (silently altering intent). |
| D2 | **Adjudication boundary:** Technical validity, code state, test outcomes, and quality-bar compliance are adjudicated autonomously by the orchestrator using repository evidence. Escalations to the user are restricted to material intent changes, new external dependencies or runtime prerequisites, and discarded work. | Separates verifiable factual adjudication from subjective user intent. Preserves the user gate where authority is required without stalling on routine findings. | Human approval for every finding; fully autonomous intent modification. |
| D3 | **Structured Decision Frame:** When an escalation is necessary (`spec-approval`, `approval`, `needs-user`, `request-user`, `level-recommendation`, `baseline`, `failure`, `opt-in`, `concerns`, `escalation`), the orchestrator presents the structured four-part [Decision Frame](../../skills/dispatch/references/decision-frame.md): (1) material conflict or blocker, (2) pre-verified facts and code/spec evidence, (3) recommended decision with rationale, and (4) concrete consequences of alternatives. | Prevents open-ended questions and uncurated delegate dumps; enables one-click or single-utterance user decisions. | Forwarding raw reviewer text; asking "how should we proceed?" without a recommendation. |
| D4 | **Decision contract disambiguation:** Clarify that "Never invent decisions" in host contracts restricts inventing unlisted options or forging user authorizations; it does not restrict autonomous adjudication of `by: "orchestrator"` frames. | Resolves prompt-level contradiction between autonomous adjudication and decision constraints. | Removing the restriction entirely (invites schema hallucinations). |

## Consequences

- The user makes fewer decisions, but receives high-signal, pre-verified evidence when a decision is genuinely required.
- Agents must perform factual investigation and source checks before escalating. Factual discovery belongs to the orchestrator, never the user.
- Canonical operational contracts and templates live in [Decision Frame](../../skills/dispatch/references/decision-frame.md), providing a single source of truth across all awaits and verbs.
- Operational references (`SKILL.md`, `review-rules.md`, `implement.md`, `spec-stage.md`) and repository governance (`AGENTS.md`) share consistent language and boundaries.
