# Implement

Use `start implement --session-dir <dir> --orchestrator <platform> -- <objective-or-plan-or-design-path>`. The driver reuses settled plan evidence when available, verifies baseline, records production approval, then emits bounded writer briefs and verification summaries. For design delivery it reuses matching unfinished same-chat journals and binds derived approvals to the governed revision.

At `write`, launch the configured native writer for each task slot marked `launch`, using its worktree and verified brief hash. Retain each handle and report launch/completion through [the contract](../..). Apply the configured cap and available native capacity; capability failures require a named failure rather than shared-checkout execution.

On model fallback, the driver can retain the brief while advancing the launch attempt. Pass the replacement writer the current task entry's `task`, `attempt`, `signature`, and `model`, plus the frame's stage-level `effort`; use these for launch and receipts. Use that entry's `briefPath`, `briefHash`, `envelopePath`, and `checkpointPath` for the retained brief. Its embedded attempt identifies brief creation; the current frame governs the launch.

Before the first production write, assess the complete settled implementation scope once: after plan, baseline, and applicable authorization are concrete. This applies to ordinary tasks, inline baseline hotfixes, and the first child of a design. A classified run uses the assessment; an explicit level remains unless the assessment recommends higher and the user adopts it. Retries, later phases, amendments, and later design increments inherit that settled level.

Each task uses one continuous writer invocation from inspection through envelope submission; the [task brief](../templates/write-brief-task.md) owns the development sequence, including the RED checkpoint before production edits; full-plan access grants context while task paths govern writes. The driver independently admits scope and submitted GREEN, plus checkpoint/test identity and behavioral RED for unwaived RED criteria, then integrates only the candidate delta and checks the accumulated result. Acceptance releases prerequisites; submission alone does not. Amended criteria, commands, and paths become enforceable plan content.

## Decision and receipt contract

For changed observed inputs, verification mutation or a delivery collision, follow [change handling](../change-handling.md). Select affected obligations as the orchestrator and retain approved write scope and attempt identities.

Send each decision through `DECISION` with its exact `kind` and an `answer` matching the pending frame:

- `DECISION kind=run-stop`: `{ by: "user", quote }` at a level or scope gate.
- `DECISION kind=level-classification`: `{ evaluatedLevel, rationale, gateScope }`; echo the complete gate snapshot.
- `DECISION kind=level-recommendation`: `{ choice: "adopt" | "retain", quote }`.
- `DECISION kind=integration-conflict`: `{ by: "orchestrator", action: "resolve" | "discard", rationale, amendment? }`.
- `DECISION kind=request`: `{ by: "orchestrator", action: "approve" | "decline" | "escalate", rationale }`.
- `DECISION kind=request-user`: `{ by: "user", requestId, choice: "accept" | "decline", quote }`; only after `escalate`.

### Writer receipts

Report each writer through `WRITE_RECEIPT` with `status`:

- `launched`: `task`, `attempt`, `signature`, host-assigned `handle`, attested `model`/`effort`, and `substitution` when they differ.
- `submitted`: identity, `envelopePath`, and `briefHash` of the brief the writer finished under.
- `failed`: identity and `detail`. `cancelled`: identity, after the writer confirms it stopped.

Taskless hotfix receipts carry only `submitted` or `failed` and omit identity.

### Writer requests

When a live writer needs work outside its task scope, reply `REQUEST` with `{ task, attempt, need, paths, rationale }`; the writer keeps running. At the `request` decision, weigh the need against task intent and invariants:

- `approve` after an `AMEND` brings the paths in scope; the driver then resumes scheduling.
- `decline`, then tell the writer to continue within its scope.
- `escalate` when you disagree with the writer or the need changes intent; the user answers with `request-user`.

A submission against an older brief must still pass current scope admission. A writer notice grants no additional paths.

### Amendments

`AMEND` `{ delta, notify, rationale, by? }` changes the plan live at a write, request, conflict, or failure frame; it replaces `REVISE` in implement runs. `delta` lists exact-text `modify`, `remove`, or `add` edits. Writers not named keep running. Name in `notify` each running writer whose paths or criteria change, with a notice; the driver regenerates its brief and the write frame relays the notice with the new brief path and hash. Relay both to the writer; when the host cannot message a live writer, deliver them at its next request or receipt. A `submitted` receipt with a stale `briefHash` is accepted only when the amendment left that task's paths and criteria unchanged.

`REPLACE_PLAN` supplies a complete parsed plan, bound to the previous governed `expectedHash`. It uses the same reconciliation operation as `AMEND`. Account for all task IDs once in `retained`, `changed`, `added` and `retired`; attest actual `intentChanged` and external `dependencyChanged`. Title/manifest edits do not infer those decisions. Stale hashes or invalid graphs reject safely with prior work retained.

```json
{"type":"REPLACE_PLAN","path":"replacement.plan.md","expectedHash":"sha256:previous-governed-hash","rationale":"Retire the obsolete reporting requirement.","notify":[],"reconciliation":{"retained":["T1"],"changed":[],"added":[],"retired":["T2"],"intentChanged":false,"dependencyChanged":false}}
```

- Changed tasks keep candidates, integration, attempts, handles and previous brief provenance. Regenerate affected briefs and relay each notice; current scope governs admission. Evidence refresh changes obligations, not accepted history.
- An accepted consumer gaining an unfinished prerequisite keeps its implementation and gains validation/delivery obligations on the combined candidate. Accept the producer and complete its required rechecks before checking the consumer. Failed retained checks keep acceptance history, attempts, failure counters and worktree references; an explicit failure retry repeats checks after repair.
- Retirement archives work references and retains integrated bytes. Removing those bytes requires an approved scoped compensating task, named in `reconciliation.compensating`, with `by: { by: "user", quote }`.
- A retired live writer requires `retire: [{ task, disposition: "stop" | "retain" }]`; a `stop` disposition requires a user quote. Its slot remains occupied until a cancelled/terminal receipt. Retain its handle and submission history.

Attach a user quote for actual changed intent, a new external dependency/runtime prerequisite or work disposal. Ordinary requirement retirement alone does not discard work. See [change handling](../change-handling.md) for evidence dispositions and durable continuation.

### Integration conflicts

When a candidate conflicts with accepted work, the driver keeps the conflict in the integration worktree. Resolve the conflict markers there within the involved tasks' paths, against both tasks' intent and criteria, then reply `integration-conflict` `resolve`; the driver commits the resolution and verifies affected criteria, and a refused or failing attempt returns the frame with evidence. To drop the candidate instead, first send a user-gated `AMEND` that records the discarded work, then reply `discard` naming that amendment. An open conflict blocks amendments that rewind or re-verify accepted work.

For a delivery replay conflict, the frame offers `resolve` only. Keep the archived accepted integration and resolve the retained pick in the active worktree. The driver verifies the resolution, resumes remaining archived commits in order, rechecks accepted tasks and repeats all-path delivery preflight. Recovery uses recorded commit provenance to avoid duplicate picks. Task acceptance and writer attempts stay unchanged.

If replay fails after a resolved pick, use the failure frame's explicit `retry` decision. The saved continuation keeps the original archive range through checkpoints and rebind. Retry resumes that range before task checks or delivery; completion requires mappings for all retained accepted commits. Repeated failures preserve the same source and acceptance history.

Retired accepted work retains its recorded paths and verification contract for replay resolution. Repair within that retained scope; the checks test preserved work without restoring retired requirements or widening a live writer's scope. Replay remaps live and retired integration references while keeping original commits in history.

Independent branches continue after task failure; descendants remain blocked. Keep running handles and completed receipts across status/resume. At a consolidated failure decision, verify each failed task's `amendment` against plan intent, invariants, and code, treating `unresolvedTargets` as unverified; then retry with clarified context, send `AMEND` citing the amendment, or stop with artifacts retained. Preservation does not claim repair or retry.

After all tasks are accepted, the current runtime checks caller drift, transfers the integrated delta, and removes private worktrees. Concerns, final code review/fixes, generated-artifact regeneration, aggregate gates, and final evidence then run in the caller checkout. This order differs from pre-delivery review in private integration: review or final-gate failure can leave delivered edits for repair. After the final review and fixes, the driver trims test files owned only by `Retain: transient` criteria, keeps their evidence as `verified at <revision>`, drops their Verify commands, and then runs the final gate. Other final criterion passes must postdate mutation. Retain caller changes and report completion only with every criterion evidenced.
