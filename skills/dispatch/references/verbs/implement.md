# Implement

Use `start implement --session-dir <dir> --orchestrator <platform> -- <objective-or-plan-or-design-path>`. The driver reuses settled plan evidence when available, verifies baseline, records production approval, then emits bounded writer briefs and verification summaries. For design delivery it reuses matching unfinished same-chat journals and binds derived approvals to the governed revision.

At `write`, launch the configured native writer for each task slot marked `launch`, using its worktree and verified brief hash. Retain each handle and report launch/completion through [the contract](../..). Apply the configured cap and available native capacity; capability failures require a named failure rather than shared-checkout execution.

Before the first production write, assess the complete settled implementation scope once: after plan, baseline, and applicable authorization are concrete. This applies to ordinary tasks, inline baseline hotfixes, and the first child of a design. A classified run uses the assessment; an explicit level remains unless the assessment recommends higher and the user adopts it. Retries, later phases, accepted scope changes, and later design increments inherit that settled level.

Each task uses one continuous writer invocation from inspection through envelope submission; the [task brief](../templates/write-brief-task.md) owns the development sequence, including the RED checkpoint before production edits; full-plan access grants context while task paths govern writes. The driver independently admits scope and submitted GREEN, plus checkpoint/test identity and behavioral RED for unwaived RED criteria, then integrates only the candidate delta and checks the accumulated result. Acceptance releases prerequisites; submission alone does not. A scope request must define every newly referenced criterion completely; accepted criteria, commands, final commands, phase duties, obligations, and paths become enforceable plan content.

When required work exceeds the brief, the writer pauses before editing outside it and submits the typed `SCOPE_REQUEST` from its brief. The orchestrator adjudicates against task intent and invariants. If it agrees, Dispatch records the approved delta, informs the user before writer resumption, and continues at the settled level. If it disagrees, the user decides whether to accept the delta. This also applies to plan and design revisions before rebinding; only a disagreement requires user adjudication.

## Decision and receipt contract

Send each decision through `DECISION` with its exact `kind` and an `answer` matching the pending frame:

- `DECISION kind=run-stop`: `{ by: "user", quote }` at a level or scope gate.
- `DECISION kind=level-classification`: `{ evaluatedLevel, rationale, gateScope }`; echo the complete gate snapshot.
- `DECISION kind=level-recommendation`: `{ choice: "adopt" | "retain", quote }`.
- `DECISION kind=scope-deviation`: `{ by: "orchestrator", request, ruling: "approve" | "disagree", rationale }`; copy the pending proposal unchanged.
- `DECISION kind=scope-deviation-user`: `{ by: "user", requestId, choice: "accept" | "decline", quote }`; decide only after the orchestrator disagrees.

A task writer submits `SCOPE_REQUEST` as the `status` in its `WRITE_ENVELOPE`, with the complete proposal in `scopeRequest`. It pauses before changing any path outside its current envelope. Task-scoped `WRITE_ENVELOPE`, `WRITE_FAILED`, and `WRITE_CANCELLED` receipts echo the original task, attempt, signature, and handle. Taskless hotfix `WRITE_ENVELOPE` and `WRITE_FAILED` receipts omit those four fields.

If a scope decision starts while sibling writers are live, collect each original attempt's terminal receipt using its original identity from the drain frame. A sibling `SCOPE_REQUEST` during this drain is nonterminal: keep that attempt active, surface the request in the drain frame, and ask the writer to continue within the current scope or provide a terminal receipt. Do not charge its retry budget or launch replacements while any live sibling remains. Show the writer's rationale and the orchestrator's rationale to the user only when they disagree; after agreement, journal the accepted delta and show its notice before resuming the writer.

Independent branches continue after task failure; descendants remain blocked. Keep running handles and completed receipts across status/resume. At a consolidated failure decision, retry or revise within emitted bounds, or stop with artifacts retained. Resolve live writers before plan revision; preservation does not claim repair or retry.

After all tasks are accepted, the current runtime checks caller drift, transfers the integrated delta, and removes private worktrees. Concerns, final code review/fixes, generated-artifact regeneration, aggregate gates, and final evidence then run in the caller checkout. This order differs from pre-delivery review in private integration: review or final-gate failure can leave delivered edits for repair. A final criterion pass must postdate mutation. Retain caller changes and report completion only with every criterion evidenced.
