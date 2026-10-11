# Thin Driver: Orchestrator-Owned Conflicts, Live Amendments, Transient Tests

Status: approved design (brainstorming 2026-10-11). Next: `/dispatch-plan`.

## Problem

- Parallel `implement` writers run in private worktrees. An integration conflict calls `taskFailed`, so the work is thrown away and retried (`skills/dispatch/scripts/machines/implement.ts:771`).
- A scope or plan revision drains all live writers before it continues. This is slow and wastes work.
- The driver is the main bug source: 25 of the last 80 commits are `fix`; `machines/implement.ts` (1,747 lines) has the most churn; the protocol has 32 event types. Hard-coded decision rules restrict the orchestrator.
- Plans create many low-signal tests that are not durable.

## Goals

1. The driver keeps only deterministic invariant guards. The orchestrator makes the judgment decisions, with a journaled rationale.
2. Integration conflicts are resolved and the work is kept. Discard and rewrite is a last resort that needs a scope expansion and user authorization.
3. The orchestrator can amend the plan while writers run and notify only the affected writers.
4. Writers ask the orchestrator for help (cross-task files, shared helpers) and stay live.
5. Fewer, more durable tests: plan-level seams, and transient tests trimmed after integration.
6. Fewer event types and states; `implement.ts` gets smaller.

## Non-goals

- A pre-task exploration phase (the plan already holds the planned context; discoveries go through `AMEND`/notices).
- Generated "where this fits" brief blocks (writers already read the full plan; see Briefs).
- Migration of live runs from older protocols (backward-incompatible; drop legacy support). Increment the protocol version.
- Changes to provider (non-native) delegates; they stay read-only.
- A command-style driver that drops the frame/await protocol.

## Ownership Boundary

### Driver invariants (it refuses replies that break one)

1. **Isolation:** writers work only in private worktrees. The driver owns the journal, lock, and generated artifacts.
2. **Write scope:** a candidate changes only paths in the current approved scope. The orchestrator can change the scope; the driver enforces the current version.
3. **Verification:** the driver runs every check command. A criterion passes only on driver-run evidence that postdates the last mutation, except transient criteria (see Tests).
4. **Delivery safety:** delivery never overwrites caller paths changed since the baseline.
5. **User gates:** production approval, manual completion, discarding task work, intent change, and a new external dependency need a user `quote`.
6. **Recovery:** effects are journaled and idempotent; resume repeats no effect.

### Orchestrator decisions (journaled rationale)

- Integration-conflict resolution.
- Plan amendment: when, what, and which writers to notify.
- Scope requests: approve or decline. A disagreement or intent change goes to the user.
- Siblings during a change: pause, update (for example to use a new shared helper), or leave running.
- Failure recovery: retry, revise, or stop.

## Protocol Changes

| Change | Before | After |
|---|---|---|
| Write receipts | `WRITE_LAUNCHED`, `WRITE_ENVELOPE`, `WRITE_FAILED`, `WRITE_CANCELLED` | `WRITE_RECEIPT{status: launched\|submitted\|failed\|cancelled}` with the same identity fields |
| Orchestrator decisions | kind-specific shapes (`scope-deviation`, drain replies) | `DECISION{kind, action, rationale, by}`; the driver validates only the guards |
| Writer requests | `SCOPE_REQUEST` status in an envelope | `REQUEST{need, paths, rationale}`; the writer stays live |
| Plan amendment | revision after drain | `AMEND{delta, notify:[{task, notice}], rationale, by?}` |
| Drain state machine | required for scope/plan changes | removed |
| Conflict | `taskFailed` | `await decide` with `kind: integration-conflict` |

The target is about 22 event types. The plan must list each removed and merged type, and each removed state.

## Flows

### Integration conflict

1. The cherry-pick conflicts. The driver keeps the conflicted integration worktree and emits `await decide`, `kind: integration-conflict`, with the paths, candidate, current tip, and both tasks' briefs and criteria.
2. The orchestrator chooses:
   - `resolve`: edit the conflicted files in the integration worktree with both tasks' intent (default).
   - `delegate`: if the task writer is live, the driver rebases the draft (`scopeRebase` replay) and the writer merges in its own worktree.
   - `discard`: needs a scope expansion and a user `quote`.
3. After `resolve`, the driver commits with a trailer that names both tasks, then runs the checks of each task whose paths the resolution touched, plus the Integration criteria that span them.
4. A check failure returns the decision to the orchestrator with evidence. There is no automatic task failure.

### Live plan amendment

1. Triggers: a writer `REQUEST`, a conflict resolution, a discovery, or the orchestrator's own judgment.
2. The orchestrator sends `AMEND`. A minor delta needs no user. An intent change, a new external dependency, or discarded work needs `by: user` with a `quote`.
3. The driver validates the delta against the invariants, writes a new plan revision, regenerates the affected briefs, and journals the amendment.
4. The orchestrator relays each notice through the native channel (for example `SendMessage`). If the host cannot message a live writer, the notice is delivered at that writer's next `REQUEST` or receipt.
5. A notified writer continues with the new brief; its next receipt echoes the new brief hash. A receipt with the old hash is accepted only when the amendment did not change that task's scope or criteria; otherwise the driver asks the orchestrator.
6. Writers that were not notified continue without a pause.

### Writer request

- The writer sends `REQUEST` before it edits outside its scope, or when another task's work is relevant (an owned file, a shared helper).
- The writer waits and stays live. The orchestrator answers with `AMEND`, a notice, or a decline. Only a disagreement or an intent change goes to the user.

### Recovery

A conflicted integration worktree, a pending amendment, and pending requests are journaled before any action, and they survive status/resume.

## Planning

### Overlap (best effort, no hard block)

- Plan validation compares the write paths (`[NEW]`, `[MODIFY]`, `[DELETE]`, `[GENERATED]` headings) of tasks without a `Requires` path between them.
- An overlap is a warning, not a failure. The planner merges the tasks, adds `Requires`, or keeps the overlap with `Overlap: <path> — <reason>`.
- Read-only context and references never count.
- At runtime, overlapping tasks still run in parallel. Conflicts use the conflict flow.

### Briefs

No generated context block. Writers keep full read access to the plan and design. Keep the plan's `Key Decisions & Context` a good overview; improve task summaries only where this does not duplicate content.

## Tests

### Seams

- The plan template gets a plan-level `Seams:` field: the fewest and highest test entry points that cover the acceptance criteria. Prefer existing seams. The planner confirms the seams with the user.
- Criteria verify through seams. A lower-level new test needs the template's `Test rationale`.
- `references/review-rules.md` adds the finding class `low-signal-test` (tests implementation details or duplicates seam coverage).

### Transient tests

- A criterion can declare `Retain: transient`.
- The driver records transient evidence as `verified at <revision>`. It does not have to postdate later mutation. Its behaviour must be covered by a durable seam test or the final aggregate gate.
- In the final review/fix step, removing or consolidating transient tests is in scope automatically. The final aggregate gate must pass after the removal.
- Guard: the driver refuses the removal of a test file that is not attributed to a transient criterion.

## Verification of This Change

- Pure machine tests: each `DECISION` kind, `AMEND`, `REQUEST`, and each guard rejection.
- Protocol tests: `WRITE_RECEIPT` frames and rendered sections.
- Plan domain tests: overlap warnings, `Overlap:` justification, `Seams:`, and `Retain: transient` parsing.
- e2e (`tests/e2e/`): a real two-task conflict resolved by `resolve`; a live amendment while a sibling keeps running; a transient-test trim after which the final gate passes.
- `npm run hashes` for hash-tracked files, then `npm test`.

## Affected Areas

`skills/dispatch/scripts/{core,machines,effects,domain,policy}/`, `skills/dispatch/SKILL.md`, `skills/dispatch/references/{verbs/implement.md,change-handling.md,review-rules.md,templates/plan.md,templates/write-brief-task.md,templates/schemas/}`, related tests.

## Risks

- The orchestrator writes code in the integration worktree. Mitigation: the driver re-runs the affected checks; review covers the result.
- A notice may not reach a writer on hosts without mid-run messaging. Mitigation: the brief-hash check at the next receipt.
- Transient trimming lowers regression protection. Mitigation: seam coverage requirement and the final gate.
