# Implement

For an objective, [spec operation](../spec-stage.md) precedes plan authoring. A supplied plan or design resolves its governing spec through Parent pins; an increment plan resolves transitively through its design. Apply spec approval at the authoring gate, then apply required design approval. Every writer reads the full spec at its bound path/hash plus the plan's shared range through Task Map, its task, assigned criteria and Verification Plan rows.

When intent changes, revise the spec before amending the plan. Follow the [revision protocol and recovery owners](../spec-stage.md#revision-protocol): reconcile immutable pending results and already-authorized writer receipts at quiescence before admitted `SPEC_REVISED`. Root re-settles new bytes, obtains applicable new-hash approval and internally synthesizes `SPEC_SETTLED`; the host never sends it. Preserve work and follow the owner-specific halt or pre-task authoring transition. Neither blind effect replay nor unauthorized writer stopping is a recovery step.

Use `start implement --session-dir <dir> --orchestrator <platform> -- <objective-or-plan-or-design-path>`. The driver reuses settled plan evidence when available, verifies baseline, then emits bounded writer briefs and verification summaries. For design delivery it reuses matching unfinished same-chat journals and binds derived approvals to the governed revision.

At `write`, launch the configured native writer for each `tasks` row marked `launch`, using the worktree and verified brief hash from its launch record. Retain each handle and report launch/completion through [the contract](../..). Apply the configured cap and available native capacity; capability failures require a named failure rather than shared-checkout execution.

On model fallback per [providers](../providers.md#providers), the driver can retain the brief while advancing the launch attempt. Read the task's current launch record: pass the replacement writer its `task`, `attempt`, `signature`, `model`, and `effort`, and copy its `launched` receipt. Its `briefPath`, `briefHash`, `envelopePath`, and `checkpointPath` name the retained brief; the replacement writer reads `briefPath` only, never a delta. The brief's embedded attempt identifies brief creation; the launch record governs the launch.

Before the first production write, assess the complete settled implementation scope once: after plan and baseline are concrete. This applies to ordinary tasks, inline baseline hotfixes, and the first child of a design. A classified run uses the assessment; an explicit level stays, and a higher assessment is reported. Retries, later phases, amendments, and later design increments inherit that settled level.

Each task uses one continuous writer invocation from inspection through envelope submission; the [task brief](../templates/write-brief-task.md) owns the development sequence, including the RED checkpoint before production edits; full-plan access grants context while task paths govern writes. The driver enforces scope, criterion evidence, submitted GREEN, path containment and immutable checkpoint test bytes. Missing or invalid checkpoint evidence, RED-matrix defects, unbuildable RED commands and RED replay failures become concerns; valid RED rows are replayed before GREEN verification. It integrates only the candidate delta and checks the accumulated result. Acceptance releases prerequisites; submission alone does not. Amended criteria, commands, and paths become enforceable plan content.

## Decision and receipt contract

For changed observed inputs, verification mutation or a delivery collision, follow [change handling](../change-handling.md). Select affected obligations as the orchestrator and retain approved write scope and attempt identities.

Send each decision through `DECISION` with its exact `kind` and an `answer` matching the pending frame; format user escalations per [Decision Frame](../decision-frame.md):

- `DECISION kind=run-stop`: `{ by: "user", quote }` at a level or scope gate.
- `DECISION kind=level-classification`: `{ evaluatedLevel, rationale, gateScopeHash }`; copy `gateScopeHash` from the frame after you assess its `gateScope`.
- `DECISION kind=integration-conflict`: `{ by: "orchestrator", action: "resolve" | "discard", rationale, amendment? }`.
- `DECISION kind=request`: `{ by: "orchestrator", action: "approve" | "decline" | "escalate", rationale }`.
- `DECISION kind=request-user`: `{ by: "user", requestId, choice: "accept" | "decline", quote }`; only after `escalate`.
- `DECISION kind=needs-user` / `concerns`: `{ decision: "accept" | "stop", by: "orchestrator" | "user", quote }`; rule autonomously as orchestrator with evidence, or escalate to user under user gates.
- `DECISION kind=baseline`: `accept-known-red` as `{ action: "accept-known-red", ids }` naming every listed `failureId`; `inline-hotfix` as `{ by: "orchestrator", action: "hotfix", mode: "inline", rationale, external }`; or `"stop"`.
- `DECISION kind=failure`: `retry` or `stop` as `{ by: "orchestrator", action, rationale }`. A task-phase frame offers `retry` only while a failed task has attempts left. After delivery, a final-verification failure also accepts `hotfix` as `{ by: "orchestrator", action: "hotfix", mode: "inline" | "writer", rationale, external: [{ path, reason }] }`, where `external` lists each needed path outside plan scope (`[]` when none), and the user-gated `manual-complete` as `{ by: "user", action: "manual-complete", quote, criteria: { <id>: <evidence> } }` with pass or user-waived evidence for every plan criterion.

### Hotfix order

Before a hotfix, inspect the failing check, identify its root cause and bounded paths, and complete applicable level assessment and user gates. Use the [baseline guidance](../decision-frame.md#baseline-failures-baseline) or [failure guidance](../decision-frame.md#implementation-failure-failure), plus the existing [scope rules](../change-handling.md#concrete-write-boundaries) and [user gate](../decision-frame.md#user-gate-boundaries). List every needed path outside plan scope in `external` with its reason; this supports hotfix admission and does not satisfy an applicable user gate.

For inline mode, complete the bounded repair in the caller checkout before sending the matching `DECISION kind=baseline` or `DECISION kind=failure`, with the root cause in `rationale` and required `external` entries. The decision snapshots and admits those existing edits, then verifies them, with no write frame between the decision and that check.

For writer mode, when the delivered final-verification frame offers it, send `DECISION kind=failure` first, then launch the emitted hotfix writer. Use its taskless `submitted` or `failed` receipt as described under [Writer receipts](#writer-receipts).

Use only modes offered by the current frame. Hotfixes remain single-shot and within their existing size limits; follow the [hotfix write rules](../templates/write-brief-hotfix.md). If the targeted failure remains unchanged, the hotfix is withdrawn for that stage; a retry does not add write scope or restore it.

### Writer receipts

Report each writer through `WRITE_RECEIPT` with `status`:

- `launched`: `task`, `attempt`, `signature`, host-assigned `handle`, attested `model`/`effort`, and `substitution` when the actual launch differs.
- `submitted`: identity, `envelopePath`, and `briefHash` of the brief the writer finished under.
- `failed`: identity and `detail`. `cancelled`: identity, after the writer confirms it stopped.

For task writers, bind a `failed` receipt to the actual launched handle. Follow [providers](../providers.md#providers) for configured model and effort, prelaunch capability blockers, and mismatch handling.

Copy each receipt from the row's launch record `receipts`: `launched` for `launch` rows, `submitted` or `failed` for `running` rows, `cancelled` for `cancel` rows and retained retirements. A retained retirement also offers `submitted` and `failed`: it may finish once, archived and never admitted. Copied `submitted` binds the latest issued brief; when the writer finished under an earlier brief, echo the `briefHash` and `envelopePath` it reports, so validation rejects a stale submission.

Taskless hotfix receipts carry only `submitted` or `failed` and omit identity.

Non-ignored paths outside the task scope open a `scope` request that the orchestrator approves or declines ([write boundaries](../change-handling.md#concrete-write-boundaries)). Keep host-owned scratch, such as extra worktrees or timing copies, in a Git-ignored path, or remove it before sending `submitted`.

### Writer requests

When a live writer needs work outside its task scope, reply `REQUEST` with `{ task, attempt, need, paths, rationale }`; the writer keeps running. At the `request` decision, weigh the need against task intent and invariants:

- `approve` after an `AMEND` brings the paths in scope; the driver then resumes scheduling.
- `decline`, then tell the writer to continue within its scope.
- `escalate` when you disagree with the writer or the need changes intent; present the [Decision Frame](../decision-frame.md#writer-requests-request-user) to the user; the user answers with `request-user`.

A `scope` request comes from a submitted candidate, not a live writer. `approve` admits exactly its paths without `AMEND`; inspect them first and decline incidental output that does not belong in delivery.

A submission against an older brief must still pass current scope admission. A writer notice grants no additional paths.

### Amendments

`AMEND` `{ delta, notify, rationale, by? }` changes the plan live at a write, request, conflict, or failure frame; it replaces `REVISE` in implement runs. `AMEND` and `REPLACE_PLAN` apply only in the task phase. At a final-verification failure, answer `DECISION failure` instead: `hotfix` (with `mode` and `external`), `retry`, `manual-complete` or `stop`. At the baseline gate, answer `DECISION baseline`: `accept-known-red`, `inline-hotfix` or `stop`. See the [answer shapes](#decision-and-receipt-contract) and [Decision Frame](../decision-frame.md#implementation-failure-failure). `delta` lists exact-text `modify`, `remove`, or `add` edits. Writers not named keep running. Name in `notify` each running writer whose paths or criteria change, with a notice; the driver regenerates its full brief and, for a launched writer, a delta bound to the brief it holds. Relay the launch record's `notice` and `deltaPath` with its `deltaHash` (else `briefPath`); when the host cannot message a live writer, deliver them at its next request or receipt. If the writer reports `LOST_CONTEXT`, relay its `launch.json` `briefPath` instead. Its `submitted` receipt echoes the latest delta or full brief hash. A stale full-brief `briefHash` is accepted only when the amendment left that task's paths and criteria unchanged; a superseded delta hash is rejected.

`REPLACE_PLAN` supplies a complete parsed plan, bound to the previous governed `expectedHash`. It uses the same reconciliation operation as `AMEND`. Account for all task IDs once in `retained`, `changed`, `added` and `retired`; attest actual `intentChanged` and external `dependencyChanged`. Title/manifest edits do not infer those decisions. Stale hashes or invalid graphs reject safely with prior work retained.

```json
{"type":"REPLACE_PLAN","path":"replacement.plan.md","expectedHash":"sha256:previous-governed-hash","rationale":"Retire the obsolete reporting requirement.","notify":[],"reconciliation":{"retained":["T1"],"changed":[],"added":[],"retired":["T2"],"intentChanged":false,"dependencyChanged":false}}
```

- Changed tasks keep candidates, integration, attempts, handles and previous brief provenance. Regenerate affected briefs and relay each notice; current scope governs admission. Evidence refresh changes obligations, not accepted history.
- An accepted consumer gaining an unfinished prerequisite keeps its implementation and gains validation/delivery obligations on the combined candidate. Accept the producer and complete its required rechecks before checking the consumer. Failed retained checks keep acceptance history, attempts, failure counters and worktree references; an explicit failure retry repeats checks after repair.
- Retirement archives work references and retains integrated bytes. Removing those bytes requires an approved scoped compensating task, named in `reconciliation.compensating`, with `by: { by: "user", quote }`.
- A retired live writer requires `retire: [{ task, disposition: "stop" | "retain" }]`; a `stop` disposition requires a user quote. Its slot remains occupied until a cancelled/terminal receipt. Retain its handle and submission history.

Attach a user quote for actual changed intent, a new external dependency/runtime prerequisite or discarded work under the [user gate](../decision-frame.md#user-gate-boundaries). Ordinary requirement retirement alone does not discard work. See [change handling](../change-handling.md) for evidence dispositions and durable continuation.

### Integration contract gate

Automated Tests commands that no criterion lists are contract commands. Each task writer runs them before it submits and records one `CHECK <command> | exit <code>` row per command its latest brief issued; missing rows become concerns, and any exit is admitted. Hotfix briefs carry no contract commands: every later integration and the final verification run each contract command, and a hotfix writer has no live route for a failure.

After each integration the driver runs every contract command. A failure is attributed to the task only when the command passed on the head the task integrated onto, even when its failure identity is an accepted baseline failure:

- Attributed failure, live writer under the attempt cap: the driver resets the integration head and rewinds the task worktree with the draft kept. Relay the launch record's `notice` and `deltaPath` with its `deltaHash` as for an amendment; the writer fixes within its scope and resubmits, or sends `REQUEST`. If the writer session ended, send a `failed` receipt; the relaunch brief carries the failure.
- Any other failure, or a criterion command that fails beside it: the task fails with a reason that names each log path, and the run reaches the failure decision. A retry brief carries the failure until acceptance.

A conflict resolution that fails such a command is not accepted; it stays in the integration-conflict decision.

Final verification still runs every contract command on the caller checkout.

### Integration conflicts

When a candidate conflicts with accepted work, the driver keeps the conflict in the integration worktree. Resolve the conflict markers there within the involved tasks' paths, against both tasks' intent and criteria, then reply `integration-conflict` `resolve`; the driver commits the resolution and verifies affected criteria, and a refused or failing attempt returns the frame with evidence. To drop the candidate instead, first send a user-gated `AMEND` that records the discarded work, then reply `discard` naming that amendment. An open conflict blocks amendments that rewind or re-verify accepted work.

For a delivery replay conflict, the frame offers `resolve` only. Keep the archived accepted integration and resolve the retained pick in the active worktree. The driver verifies the resolution, resumes remaining archived commits in order, rechecks accepted tasks and repeats all-path delivery preflight. Recovery uses recorded commit provenance to avoid duplicate picks. Task acceptance and writer attempts stay unchanged.

If replay fails after a resolved pick, use the failure frame's explicit `retry` decision. The saved continuation keeps the original archive range through checkpoints and rebind. Retry resumes that range before task checks or delivery; completion requires mappings for all retained accepted commits. Repeated failures preserve the same source and acceptance history.

Retired accepted work retains its recorded paths and verification contract for replay resolution. Repair within that retained scope; the checks test preserved work without restoring retired requirements or widening a live writer's scope. Replay remaps live and retired integration references while keeping original commits in history.

Independent branches continue after task failure; descendants remain blocked. Keep running handles and completed receipts across status/resume. At a consolidated failure decision, verify each failed task's `amendment` against plan intent, invariants, and code, treating `unresolvedTargets` as unverified; then retry with clarified context, send `AMEND` citing the amendment, or stop per [Decision Frame](../decision-frame.md#implementation-failure-failure) with artifacts retained. Preservation does not claim repair or retry.

After all tasks are accepted, the current runtime checks caller drift, transfers the integrated delta, and removes private worktrees. Concerns, final code review/fixes, generated-artifact regeneration, aggregate gates, and final evidence then run in the caller checkout. This order differs from pre-delivery review in private integration: review or final-gate failure can leave delivered edits for repair. After the final review and fixes, the driver trims test files owned only by `Retain: transient` criteria, keeps their evidence as `verified at <revision>`, drops their Verify commands, and then runs the final gate. Other final criterion passes must postdate mutation. Retain caller changes and report completion only with every criterion evidenced.
