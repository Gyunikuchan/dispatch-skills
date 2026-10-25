# ADR 0013: Deterministic toolkit and append-only ledger

- **Status**: Accepted
- **Date**: 2026-10-25
- **Supersedes**: [ADR 0006](0006-dispatch-state-machine.md), engine decisions D5–D6 and their dependents

## Context

The frame-per-step driver made protocol recovery and admission checks a large part of delivery. The approved [spec](../../.scratch/dispatch-skills/20261021T1011Z-refactor-dispatch-to-cut-complexity-brit/refactor-the-dispatch-skill-to-be-less-c.spec.md) chooses deterministic tools with orchestrator-owned sequencing (DEC-1, DEC-3–DEC-5). The [design](../../.scratch/dispatch-skills/20261021T1011Z-refactor-dispatch-to-cut-complexity-brit/design-ordered-increments-for-the-dispat.design.md) records AD-1–AD-10. The [I08 comparison](../evaluations/2026-10-dispatch-toolkit-comparison.md) passed its fixed correctness and token rule before legacy deletion.

## Decision

`dispatch.ts` routes to the toolkit CLI. Tools own provider fan-out, lint, brief rendering, verification, worktrees, integration, ledger operations, status and reports. The orchestrator owns order, technical rulings and targeted writer notices. The per-verb reducer machines, event journal, checkpoint/rebind protocol and receipt admission machinery are removed. Toolkit domain modules are canonical; shared library, policy and provider modules remain reusable (AD-1, AD-5).

One append-only `ledger.jsonl` holds twelve closed record kinds. Idempotency keys prevent duplicate effects. A torn final line is preserved and repaired on append; corruption before the final line fails closed. Short critical sections use a session lock; long verification and provider calls run outside it (AD-2, AD-10).

At medium and above, one user approval binds the spec, plan and optional design hashes. Recorded non-intent edits extend that approval chain. An intent, dependency, runtime prerequisite or discard change needs new approval. Writer brief rendering and integration check the chain. Waivers and manual completion require a user quote; `xhigh` and `max` require user selection. Other technical decisions belong to the orchestrator (AD-3).

Verification always executes and binds evidence to the tested tree and command. Reports distinguish verified, waived and manual criteria, and accept only current eligible evidence. Tools return compact summaries and result paths. Recovery uses recorded integration phases, Git identity, writer state and status, rather than replaying a workflow journal (AD-4, AD-6–AD-9).

## Consequences

The workflow has fewer routine gates and permits living plans and designs. Deterministic checks preserve approval, evidence and worktree boundaries; the orchestrator must still judge sequencing and findings. Structural tests guard the 9,600 driver TS LOC, twelve ledger kinds and 4,096-byte skill limits. Semantic workflow review remains necessary to check gate sequencing.

v0.7.x sessions, journals and frames are incompatible. Finish old runs or preserve their controller and session files before upgrading. The increments ship together as v0.8.0; this ADR does not publish or change the package version.
