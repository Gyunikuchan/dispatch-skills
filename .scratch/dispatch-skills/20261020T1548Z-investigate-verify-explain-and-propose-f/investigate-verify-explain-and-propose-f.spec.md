# Inline hotfix recovery clarity

> **Status:** draft
>
> **Level:** low — bounded guidance correction in an existing recovery flow

## Intent & Problem
Investigate the two findings in the supplied 20261020T1242Z diagnostics report. Explain verified causes and propose a minimal fix that prevents an inline hotfix decision from preceding its edits. Preserve truthful attribution of elapsed waits. This invocation produces planning artifacts, not product implementation.

## Requirements
### REQ-1 — Evidence-grounded findings
- Acceptance: Each diagnostic claim has a disposition supported by current source and the retained run journal; unknown activity is explicit.

### REQ-2 — Clear recovery ordering
- Acceptance: The proposed fix states the inline edit-before-decision sequence and writer decision-before-launch sequence, including scope, user gates, admission, and single-attempt limits.

### REQ-3 — Proportional verification
- Acceptance: The plan names affected guidance and generated hashes, scenario review, and unchanged repository verification commands without adding redundant prose tests or changing runtime behavior.

## Non-goals
- Implement fixes during this planning invocation.
- Change timing budgets, hotfix attempt limits, authorization, or diagnostics measurements.
- Infer active reasoning from elapsed host-await time.

## Constraints
- Preserve unrelated dirty and scratch work.
- Commit only completed deliverables from this invocation, as requested by the user.
- Use the current runtime as the source for recovery behavior; the original run used its retained frozen controller.
- No new dependency or runtime prerequisite is needed. Interfaces and stored data remain unchanged.
