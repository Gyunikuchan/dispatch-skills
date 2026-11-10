# ADR 0013: Deterministic toolkit and append-only ledger

- **Status**: Accepted
- **Date**: 2026-10-25

## Context

The frame-per-step driver made protocol recovery and admission checks a large part of delivery. The refactor chose deterministic tools with orchestrator-owned sequencing (spec DEC-1, DEC-3–DEC-5; design AD-1–AD-10). Its planning artifacts were session-local, not durable repository references.

## Decision

`dispatch.ts` routes to the toolkit CLI. Tools own provider fan-out, lint, brief rendering, verification, worktrees, integration, ledger operations, status and reports. The orchestrator owns order, technical rulings and targeted writer notices. The per-verb reducer machines, event journal, checkpoint/rebind protocol and receipt admission machinery are removed. Toolkit domain modules are canonical; shared library, policy and provider modules remain reusable (AD-1, AD-5).

One append-only `ledger.jsonl` holds the closed record kinds defined by the [toolkit contract](../../skills/dispatch/references/toolkit.md#ledger-records). Idempotency keys prevent duplicate effects. A torn final line is preserved and repaired on append; corruption before the final line fails closed. Short critical sections use a session lock; long verification and provider calls run outside it (AD-2, AD-10).

At medium and above, one user approval binds the spec, plan and optional design hashes. Recorded non-intent edits extend that approval chain. An intent, dependency, runtime prerequisite or discard change needs new approval. Writer brief rendering and integration check the chain. Waivers and manual completion require a user quote; `xhigh` and `max` require user selection. Other technical decisions belong to the orchestrator (AD-3).

Verification always executes and binds evidence to the tested tree and command. Reports distinguish verified, waived and manual criteria, and accept only current eligible evidence. Tools return compact summaries and result paths. Recovery uses recorded integration phases, Git identity, writer state and status, rather than replaying a workflow journal (AD-4, AD-6–AD-9). Delivery requires an empty caller index and restores verified integration changes as unstaged edits; internal commits remain available through the delivered-source ref. See the [delivery contract](../../skills/dispatch/references/toolkit.md#worktree-deliver).

The user accepted writer-observed RED evidence on 2026-10-27: “Ok to forego red assurance, just let writers follow TDD.” Independent RED replay and immutable test-only checkpoints are not required; host inspection, scope checks and integrated verification remain. On the same date, “Rejected MUST: yes” restored explicit source-slot or configured fallback confirmation for rejected MUST findings. Pending confirmation permits post-cap review; repeated disagreement escalates. See the [review rules](../../skills/dispatch/references/review-rules.md).

Writers own TDD: failing proof tests, implementation to GREEN and durable contract tests. The post-integration `test-cleanup` utility subagent owns aggressive test pruning, and reviewers apply the identical retention standard so cleanup and review converge instead of trading conflicting test expectations. Per-task worktrees stay uniform: local Git worktree creation costs under a second, while a second single-worktree execution path adds permanent state-machine and recovery branches. Batch ledger appends accept a JSON array in a file rather than inline CLI JSON: file input avoids cross-platform shell-quoting errors, and in-band `batchEndSeq` framing commits the array under one lock without external marker files or multi-file snapshot races. Single-record appends keep their single-handle path.

The [toolkit contract](../../skills/dispatch/references/toolkit.md) remains the canonical source for per-call detail. On-demand help serves its sections and refusals point to the governing section, avoiding repeated mandatory reads without maintaining a second contract.

The [path workload measure](../../scripts/path-bytes.ts) counts deterministic representative reads against a fixed baseline as a proxy for token workload, not observed usage. Its 25% reduction target is aspirational: a smaller measured reduction is reported rather than failing the work.

## Consequences

The workflow has fewer routine gates and permits living plans and designs. Deterministic checks preserve approval, evidence and worktree boundaries; the orchestrator must still judge sequencing and findings. [Structural tests](../../tests/integration/structural-targets.test.ts) guard current driver, ledger and skill limits. Semantic workflow review remains necessary to check gate sequencing.
