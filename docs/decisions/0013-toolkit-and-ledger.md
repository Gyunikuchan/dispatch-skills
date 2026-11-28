# ADR 0013: Deterministic toolkit, append-only ledger, and advisory step hints

- **Status**: Accepted
- **Date**: 2026-10-25
- **Updated**: 2026-11-28
- **Audience**: Maintainers

## Context

A frame-per-step state machine made protocol recovery and receipt admission a large source of friction. Replacing the rigid driver with deterministic toolkit actions and an append-only ledger leaves sequencing and technical rulings with the orchestrator while enforcing safety, approval, and evidence boundaries deterministically.

## Decision

### Toolkit CLI and generated contracts

- **Orchestrator-owned sequencing:** `dispatch.ts` routes to the toolkit CLI ([toolkit contract](../../skills/dispatch/references/toolkit.md)). Tools own provider fan-out, lint, brief rendering, verification, worktrees, integration, ledger operations, status, and reports; the orchestrator owns sequencing, rulings, and writer notices.
- **Single-source call table and on-demand help:** `contracts.ts` and `recordSchemas()` define action, session, and ledger signatures. `npm run maintain` generates the marked `### call table` and argument spans in `toolkit.md` (`npm test` checks for drift). The orchestrator loads the compact `help call table` once per run and reads `help <heading>` only on demand or when an `ok: false` refusal names a `help` section. The [path workload measure](../../scripts/path-bytes.ts) gates must-load byte growth across all six verbs against baseline commit `88685174`.
- **Advisory step hints:** Every `ok: true` toolkit stdout envelope (excluding `native-pending`) may include an optional single-line advisory `hint` (`<= 240` UTF-8 bytes, `<step> — help <heading> — <command>`) derived fail-open from the post-write ledger fold and current hashes (`hints.ts`). Hints prevent missed or misordered steps without adding persisted state or a second transition table, and are omitted on errors, `native-pending`, or orchestrator-decision boundaries. Hard toolkit step-transition enforcement remains rejected so the orchestrator is never locked out of valid recovery paths.
- **Advisory resume actions:** `status show --resume` derives a phase `reason` and advisory next `action` (`<verb>[ <subject>]`) per implement phase from the same ledger fold (`RESUME_ROUTES` in `status.ts`) so recovery routes without inferring from detailed status; the `action` is advisory and enforces nothing, leaving action gates with each named tool.
- **Combined actions:** A fixed, judgment-free call chain may become one action that composes the existing primitives in process, each under its own lock and with no lock held across steps: `worktree land` (submit, integrate, `check run --task`), `lint run --edit --fix-review-lite` (edit, then brief) and `review run --note` (note append, then review). A combined action skips a step whose durable record exists (submit and integrate in `worktree land`; the edit and note appends), except that `worktree land` always reruns its check and records fresh evidence. It stops at the first failure and leaves the records that the separate calls leave, so a rerun resumes idempotently. Its failure output adds a `step` and the primitive's reason and exit; primitives keep their arguments, refusals and output, and stay the recovery path.
- **Unified payload input:** Payload-taking actions (`ledger append`, `ask run`, `brief explorer`, `brief test-cleanup`, `brief verifier`, `lint run --edit`, `worktree commit`, `worktree deliver --commit`) accept file paths, stdin (`-` with UTF-8 BOM stripping), or explicit inline flags (`input.ts`), avoiding cross-platform shell-quoting failures.

### Append-only ledger and authority

- **Ledger durability:** One append-only `ledger.jsonl` holds the closed record kinds (`KINDS <= 14`). Idempotency keys prevent duplicate effects, batch arrays commit atomically under one lock with `batchEndSeq` framing, and a torn final line is repaired on append while earlier corruption fails closed. Short critical sections use a session lock; long verification and provider calls run outside it.
- **User authority:** Approval tuples (`medium+`), spec confirmations, waivers, manual completions, and `xhigh`/`max` level selection require `by: "user"` with a verbatim user quote. Recorded non-intent edits extend an approval chain; intent, dependency, runtime prerequisite, or discard changes require new user approval ([ADR 0010](0010-canonical-session-intent.md), [ADR 0012](0012-orchestrator-user-deputy.md)).

### Worktrees, TDD, and two-phase delivery

- **Uniform task worktrees and TDD:** Every task runs in its own Git worktree. Writers own TDD (authoring failing RED proof tests, implementing to GREEN, and writing durable contract tests) without separate test-only checkpoint commits; the post-integration `test-cleanup` utility subagent and code reviewers apply the shared retention gates ([quality bar](../../skills/dispatch/references/templates/quality-bar.md#testing), [ADR 0018](0018-verification-stage-order-and-naming.md)).
- **Broken-citation lint:** Plan and design `lint run` and `review run` fail closed with `broken-citation` when governed prose cites an invalid repo-relative `path:line` or `path:start-end` range; `outside-increment` path mismatches warn without failing lint.
- **Two-phase delivery:** `worktree deliver` requires a clean caller index and restores verified integration changes as unstaged edits while preserving internal commits under the `delivered-source` ref. For multi-increment designs, `worktree deliver --commit` stages only the delivered paths, creates one caller commit per increment (or an empty/record-only commit when applicable) without pushing, and records `integrate` phase `committed` ([delivery contract](../../skills/dispatch/references/toolkit.md#worktree-deliver)).

## Consequences

The workflow avoids rigid state-machine deadlocks while deterministic checks protect user gates, worktree isolation, and evidence integrity. [Structural tests](../../tests/integration/structural-targets.test.ts) guard driver, ledger, and skill byte ceilings as consolidation hints rather than user-gated blockers.
