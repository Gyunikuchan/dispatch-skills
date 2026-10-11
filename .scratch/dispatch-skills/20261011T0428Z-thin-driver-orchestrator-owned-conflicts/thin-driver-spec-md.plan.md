# Thin driver: orchestrator-owned conflicts, live amendments, transient tests

> **TL;DR:** The implement driver hard-codes judgment (conflict = task failure, plan/scope change = drain all writers) and is the main bug source. Move those decisions to the orchestrator behind deterministic guards, merge redundant host events, and add plan support for overlap warnings, test seams, and transient tests.
>
> **Parent:** `.scratch/dispatch-skills/20261011T0428Z-thin-driver-orchestrator-owned-conflicts/thin-driver.spec.md` · sha256:ff5529ade1205f8f3312b5e80086c59499d1f91e5909262598b949f50e7a8a5f
>
> **Decide:** none
>
> **Risk:** high — rewrites the implement state machine, the host-event protocol, and the integration checkout path; a defect can lose writer work or admit unverified edits.
>
> **Scope:** `skills/dispatch/scripts/{core,machines,effects,domain}/`, `skills/dispatch/SKILL.md`, `skills/dispatch/references/`, `tests/`

## Background

- Integration cherry-picks a candidate onto the integration head; on conflict it discards and returns `conflict: true` (`skills/dispatch/scripts/effects/checkout.ts:176-181`); the machine then calls `taskFailed` (`skills/dispatch/scripts/machines/implement.ts:771`).
- Scope requests and in-run plan revisions use states `scope-adjudication`, `scope-user-decision`, `scope-draining`, `scope-drain-envelope`, and `revision-request` in `skills/dispatch/scripts/machines/implement.ts`, and wait for every live writer.
- Host replies are validated in `skills/dispatch/scripts/core/validate.ts` (12 shapes); write results use four types (`skills/dispatch/scripts/core/validate.ts:166-168`).
- `reconcileTasks` re-pends changed tasks and drops live handles; `invalidatesIntegration` forces a rebuild when accepted work is lost (`skills/dispatch/scripts/machines/implement-tasks.ts:85-97`).
- Final verification runs every criterion command (`startFinalVerify`, `skills/dispatch/scripts/machines/implement.ts:990`).
- Plan lint rejects any repeated change path (`duplicate-change-path`, `skills/dispatch/scripts/domain/plan.ts:586`).
- Journal replay rejects older protocol revisions (`skills/dispatch/scripts/core/interpreter.ts:135`).

## Key Decisions & Context

- **Thin driver with invariant guards (user).** The driver keeps isolation, write scope, verification, delivery safety, user gates, and recovery. The orchestrator owns conflict resolution, amendments, request rulings, sibling handling, and retries. Rejected: incremental feature addition (grows the hotspot); a command-style driver (loses frame/await recovery).
- **Conflicts are resolved by the orchestrator in the integration worktree (user).** Actions: `resolve` and `discard`. `discard` requires a preceding user-gated `AMEND` that records the discarded work. `delegate` is removed (user, R1-F016): its committed candidate cannot reuse the uncommitted-diff scope rebase, and a new handoff path adds driver complexity. The orchestrator can still consult a live writer through a notice.
- **Host-reply set shrinks from 12 to 11 types; internal effect-result types are unchanged.** Removed: `WRITE_LAUNCHED`, `WRITE_ENVELOPE`, `WRITE_FAILED`, `WRITE_CANCELLED`. Added: `WRITE_RECEIPT`, `REQUEST`, `AMEND`. Inside implement runs `AMEND` replaces `REVISE`; `REVISE` stays for design runs. The spec's "about 22" total is not met: merging the ~16 internal effect-result types touches review and design machines and does not reduce host burden; the orchestrator deferred it to a follow-up (user preference: orchestrator decides non-major calls).
- **States.** Removed from `implement.ts`: `scope-adjudication`, `scope-user-decision`, `scope-draining`, `scope-drain-envelope`, `revision-request`. Added: `integration-conflict`, `request-decision`.
- **Live amendments (user).** `AMEND` applies a plan delta immediately; writers not named keep running. Minor deltas need no user; intent change, a new external dependency, or discarded work needs `by: user` and a `quote`.
- **Amendment reconciliation (new `amendTasks`, not `reconcileTasks`).** pending → re-pend with the new signature. running → keep handle and attempt; if its paths or criteria change, `AMEND` must notify it (else rejected) and its brief is regenerated. submitted → keep the candidate; admit it against the new scope; an admission failure becomes a `request-decision`. accepted and unchanged → keep. accepted with changed paths or criteria → reset its evidence and re-verify its criteria on the integration head, no rebuild. removed accepted task → discarded work (user gate) and integration rewind. removed running task → requires its `cancelled` receipt before the task record is dropped. Dependents keep their state unless their own signature changes. An added prerequisite that is not yet accepted: a running task keeps its handle; its submission is parked until every prerequisite is accepted, then admitted and integrated on the new head with its criteria verified there. An accepted task cannot gain an unaccepted prerequisite; that `AMEND` is rejected (reorder, or discard with the user gate).
- **Writer requests replace `SCOPE_REQUEST` (user).** `REQUEST` keeps the writer live; the orchestrator answers with `AMEND`, a notice, or a decline.
- **Overlap is a warning (user).** Repeated write paths between tasks with no transitive `Requires` path become `overlap` warnings (unless justified by `Overlap:`); ordered tasks never warn; a repeat inside one task stays a `duplicate-change-path` defect. Case variants count as the same path. References never count.
- **Seams and transient tests (user).** Plan-level `Seams:`; the orchestrator chooses and checks seams against existing tests with no user step (user, R1-F020). A criterion with `Retain: transient` must name `Covered by: <SC#|FINAL>`. A file is trimmable only if `isTestPath` classifies it as a test and every criterion listing it in `Changes` is transient; production paths are never trimmed. After the final review/fix step, the driver runs `trim` automatically on trimmable files, keeps their evidence as `verified at <revision>`, excludes their Verify commands from final verification, then runs the final aggregate gate. `FIXES_APPLIED` that deletes a file listed by a durable criterion is rejected.
- **No legacy support.** Bump `JOURNAL_PROTOCOL_REVISION`.
- **Notice delivery fallback.** When a host cannot message a live writer, the notice is delivered at the writer's next `REQUEST` or receipt; a `submitted` receipt with a stale `briefHash` is accepted only when the amendment left that task's paths and criteria unchanged.
- **No generated brief context block (user).**
- **Review criteria follow the new rules (user request: check review criteria fit).** Plan review: a shared write path is a defect only without a `Requires` path or an `Overlap:` justification; Verify filters may match tests the plan names, not only existing ones; criteria are checked against `Seams:`, and transient criteria against `Covered by:`. Code review: tests owned only by `Retain: transient` criteria are trimmed after review, so they are not `test-leak`. Reuse the existing `test-leak` class (tests coupled to internals) for low-signal tests and extend it to duplicate seam coverage, instead of a new `low-signal-test` class; add `test-leak` to the plan prompt and `report-plan.json`. Reduce the plan budget from `8 + 2 × entries` to `8 + entries`, at most 24: this plan has about 60 entries, and the larger target asks for volume over signal. Design review needs no change.

## User Review Required

- Breaking protocol change: hosts and briefs use `WRITE_RECEIPT`, `REQUEST`, `AMEND`, and the generic `DECISION`. Older in-flight runs cannot resume.
- The orchestrator edits code in the integration worktree during conflict resolution; the driver scope-checks the full delta.

## Open Questions & Assumptions

- Assumption: the final review/fix step runs in the caller checkout after delivery (`skills/dispatch/references/verbs/implement.md:31`), so `trim` writes the caller checkout there.

## Proposed Changes

### T1 — Protocol: merged receipts, generic decisions, REQUEST and AMEND
- Outcome: Host replies match the new set, checkout ops include `resolve` and `trim`, and a protocol revision bump rejects older runs.
- Prerequisites: none
- Criteria: SC1, SC2, SC3

- #### [MODIFY] skills/dispatch/scripts/core/types.ts
  - Changes: Remove the four write event types; add `WRITE_RECEIPT` with status-specific shapes — `launched {task, attempt, signature, handle, model, effort}`, `submitted {task, attempt, signature, handle, envelopePath, briefHash, model, effort}`, `failed {task, attempt, signature, handle, detail, model, effort}`, `cancelled {task, attempt, signature, handle}`; taskless hotfix `submitted {envelopePath}` and `failed {detail}` omit identity. Add `REQUEST {task, attempt, need, paths, rationale}` and `AMEND {delta, notify: {task, notice}[], rationale, by?: {by: 'user', quote}}`. Generic orchestrator `DECISION` answer `{action, rationale, by: 'orchestrator', amendment?}` for kinds `integration-conflict` (actions `resolve`, `discard`), `request` (actions `approve`, `decline`, `escalate`), and `failure` (actions `stop`; `retry`; `hotfix` with `mode` and `external`); `rationale` replaces `rootCause`. Add user kind `request-user {by: 'user', requestId, choice: 'accept'|'decline', quote}` for an escalated request. `manual-complete` stays user-gated with `criteria`. Remove `scope-deviation` and `scope-deviation-user`. Add `'resolve' | 'trim'` to `CheckoutOp`. Increment `JOURNAL_PROTOCOL_REVISION`.
  - Invariants: user-gated kinds (`run-stop`, production approval, manual completion, `level-recommendation`) keep `{by: 'user', quote}`.
- #### [MODIFY] skills/dispatch/scripts/core/validate.ts
  - Changes: Shapes for each `WRITE_RECEIPT` status, `REQUEST`, `AMEND`, and generic `DECISION`; remove removed shapes. `AWAIT_ACCEPTS`: `write` accepts `WRITE_RECEIPT`, `REQUEST`, `AMEND`; `decide` accepts `DECISION`, `AMEND`, `REVISE`.
  - Invariants: unknown fields and types stay rejected with a named defect.
- #### [MODIFY] skills/dispatch/scripts/core/frame.ts
  - Changes: Reply templates for `WRITE_RECEIPT`, `REQUEST`, `AMEND`, and generic `DECISION`.
- #### [MODIFY] skills/dispatch/scripts/core/interpreter.ts
  - Changes: Route the new types; remove removed types.
  - Invariants: replay folds recorded results and does not re-observe checkout state.
- #### [MODIFY] skills/dispatch/scripts/core/diagnostics.ts
  - Changes: Count write receipts and requests from `WRITE_RECEIPT` and `REQUEST`.
- #### [MODIFY] tests/unit/core/validate.test.ts
  - Changes: Tests `accepts each write receipt status`, `rejects removed write event types`, `accepts request event`, `accepts amend event`, `accepts generic orchestrator decision`, `write await accepts receipt request amend`, `decide await accepts amend`.
- #### [MODIFY] tests/unit/core/frame.test.ts
  - Changes: Tests `renders write receipt reply template`, `renders request reply template`, `renders amend reply template`, `renders generic decision reply template`.
- #### [MODIFY] tests/unit/core/interpreter.test.ts
  - Changes: Test `rejects journal from prior protocol revision`.

### T2 — Plan domain: overlap warnings, seams, transient criteria
- Outcome: Cross-task write overlap is a warning, and `Seams:`, `Overlap:`, `Retain: transient`, and `Covered by:` parse and lint.
- Prerequisites: none
- Criteria: SC4, SC5

- #### [MODIFY] skills/dispatch/scripts/domain/types.ts
  - Changes: `ParsedPlan` adds `seams: readonly string[]` and `warnings: readonly {kind: 'overlap'; tasks: readonly string[]; path: string}[]`; `PlanCriterion` adds `retain: 'durable' | 'transient'` and `coveredBy: string | null`; `PlanTask` adds `overlaps: readonly {path: string; reason: string}[]`.
- #### [MODIFY] skills/dispatch/scripts/domain/plan.ts
  - Changes: Track change-path ownership per task; a case-folded repeat in another task not connected by a transitive `Requires` path yields an `overlap` warning unless the owning task lists `Overlap: <path> — <reason>`; a repeat inside one task keeps `duplicate-change-path`; `changes` keeps one entry per heading. Parse `Seams:`, `Retain:` (default `durable`), and `Covered by:`; lint `transient-coverage` when a transient criterion lacks `Covered by:`, names a missing or transient criterion, or names `FINAL` while the plan has no `[FINAL]` command.
  - Invariants: only `[NEW]`/`[MODIFY]`/`[DELETE]`/`[GENERATED]` heading paths count as writes; each criterion still maps to one task or carries Integration.
- #### [MODIFY] tests/unit/domain/plan.test.ts
  - Changes: Tests `warns on unjustified cross-task overlap`, `accepts justified overlap`, `keeps duplicate path defect within one task`, `ignores reference-only paths for overlap`, `no overlap warning for directly ordered tasks`, `no overlap warning for transitively ordered tasks`, `parses seams`, `parses transient retain and coverage`, `rejects transient criterion without coverage`, `rejects final coverage without final command`; update existing duplicate-path tests for cross-task cases.

### T3 — Checkout: preserve conflicts, commit scoped resolutions, trim
- Outcome: An integration conflict survives retries and crashes; a resolution commits only when clean and in scope; `trim` deletes only allowed files.
- Prerequisites: T1
- Criteria: SC6, SC7

- #### [MODIFY] skills/dispatch/scripts/effects/checkout.ts
  - Changes: `integrate`: before `discard`, if `HEAD` equals `expected` and `CHERRY_PICK_HEAD` equals the candidate, return the recorded conflict (`conflict: true, paths, revision: expected`) without reset; on a new conflict keep the tree. New op `resolve {tasks, candidate, attempt, expected, permitted}`; `expected` is the integration head the attempt starts from (the pre-pick head for attempt 1, the prior resolution revision for a repair): refuse when conflict markers remain in the conflicted files on disk; enumerate all tracked and untracked changes against `expected` and refuse paths outside `permitted`; stage those paths; refuse remaining unmerged index entries; commit with `Dispatch-Candidate: <candidate>` and `Dispatch-Resolves: <tasks> attempt <n>`; a replay returns `reused: true` only when the head carries the trailer for the same attempt and the tree is clean; a repair attempt after a failed check is scope-checked and committed fresh on top of `expected`; returns `{revision, paths}`. `reset` aborts an in-progress cherry-pick (used by `discard`). New op `trim {files: {path, hash}[], allowed}`: before deleting anything, refuse a path not in `allowed`, an unsafe path, a symlinked or redirected ancestor (the same checks `deliver` uses), and a file whose content hash differs from `hash`; an already absent file counts as done on retry.
  - Invariants: only `deliver` and `trim` write the caller checkout; `deliver` still refuses caller-changed paths.
- #### [MODIFY] skills/dispatch/scripts/effects/index.ts
  - Changes: Register `resolve` and `trim`; write the submitted envelope from `WRITE_RECEIPT{status: 'submitted'}` instead of `WRITE_ENVELOPE`.
- #### [MODIFY] tests/unit/core/effects-checkout.test.ts
  - Changes: Tests `preserves conflicted integration tree`, `recovers conflict after interrupted integrate`, `refuses resolution with conflict markers`, `refuses resolution outside permitted paths`, `reuses committed resolution on retry`, `repairs failed resolution as new attempt`, `reset aborts in-progress cherry-pick`, `trim refuses unlisted path`, `trim refuses changed file`, `trim refuses redirected ancestor`, `trim treats absent file as done`.

### T4 — Implement machine: orchestrator decisions, amendments, transient evidence
- Outcome: The machine delegates conflict, request, and failure decisions to the orchestrator, applies `AMEND` without draining unaffected writers, and handles transient trimming; drain and revision-request states are gone.
- Constraints: Do not add a replacement drain.
- Prerequisites: T1, T2, T3
- Criteria: SC8, SC9, SC10, SC11, SC12, SC17, SC18, SC19, SC20

- #### [MODIFY] skills/dispatch/scripts/machines/implement.ts
  - Changes: Remove the five states listed in Key Decisions. On `integrate` conflict enter `integration-conflict` and emit `await decide` with paths, candidate, head, and both tasks' briefs and criteria. `resolve` → checkout `resolve` with `permitted` = the union of the involved tasks' current approved paths, then verify each task whose paths the resolution touched plus spanning Integration criteria; a failure re-emits the decision with evidence, and the next `resolve` is attempt n+1 from the current head, scope-checked and re-verified. `discard` requires `amendment` naming a user-gated `AMEND` that removed the work, then checkout `reset`. `REQUEST` enters `request-decision`; the writer stays active. `AMEND` validates the delta, applies `amendTasks`, writes a plan revision, regenerates notified briefs, and returns their brief hashes. In-run `REVISE` is rejected with a pointer to `AMEND`. Transient criteria record `verified at <revision>`; after the final review/fix step, dispatch checkout step `trim` (registered in `implementTransitions`) and handle its `CHECKOUT_DONE{op: trim}` before `startFinalVerify`, exclude a combined command mapping only when every criterion owning it is transient and trimmed (commands shared with durable criteria or `[FINAL]` stay); before trimming, reject the trim and return a `failure` decision when any retained command text names a trimmed path; then run final verification. `FIXES_APPLIED` deleting a durable criterion's file is rejected.
  - Invariants: write-scope admission, driver-run verification, delivery collision checks, and user-quote gates are unchanged; every effect stays journaled and idempotent across resume.
- #### [MODIFY] skills/dispatch/scripts/machines/implement-types.ts
  - Changes: Add `trim` to `CheckoutStep`; state and context types for `integration-conflict`, `request-decision`, amendments, and transient evidence; remove drain and revision-request types; `failureAnswer` parses the generic failure actions with `rationale`; `asParsedPlan` carries `seams`, `warnings`, `retain`, `coveredBy`, and `overlaps`.
- #### [MODIFY] skills/dispatch/scripts/machines/implement-tasks.ts
  - Changes: Add `amendTasks(tasks, before, after, notify)` with the reconciliation rules in Key Decisions; track `briefHash` per attempt; scheduling ignores overlap.
  - Invariants: `reconcileTasks` behavior is unchanged for design increments.
- #### [MODIFY] skills/dispatch/scripts/machines/revision.ts
  - Changes: Apply an `AMEND` delta as a plan revision without drained writers; plan-revision scope adjudication for root and design runs emits `kind: request` and accepts `approve`/`decline`/`escalate`, with `escalate` entering `kind: request-user` (same rules as `design-revision.ts`).
- #### [MODIFY] skills/dispatch/scripts/machines/design-revision.ts
  - Changes: Scope adjudication emits `kind: request` and accepts `approve`, `decline`, or `escalate`; `escalate` enters user decision `kind: request-user`; `run-stop` stays available in both; read writer attestation from `WRITE_RECEIPT`.
- #### [MODIFY] skills/dispatch/scripts/machines/execution-config.ts
  - Changes: Read writer model/effort attestation from `WRITE_RECEIPT{status: 'launched'}` instead of `WRITE_LAUNCHED`; remove the `scope-drain-envelope` check.
- #### [MODIFY] skills/dispatch/scripts/machines/root.ts
  - Changes: Remove the `revision-request` child branch; plan revision during an implement child arrives as `AMEND`.
- #### [MODIFY] skills/dispatch/scripts/machines/design.ts
  - Changes: Remove the `revision-request` check and the `scope-adjudication`/`scope-user-decision` writer-drain guard; route child `request-decision` frames unchanged.
- #### [MODIFY] skills/dispatch/scripts/effects/check-envelope.ts
  - Changes: Read `envelopePath` and `briefHash` from `WRITE_RECEIPT{status: 'submitted'}`; remove `SCOPE_REQUEST` status handling.
- #### [DELETE] tests/unit/machines/implement-scope-deviation.test.ts
  - Changes: Drain and scope-deviation behavior is removed; request behavior moves to `tests/unit/machines/implement-request.test.ts`.
- #### [NEW] tests/unit/machines/implement-request.test.ts
  - Purpose: Tests `request keeps writer active`, `amend notifies only named writers`, `amend rejects intent change without user quote`, `amend rejects changed running task without notice`, `amend keeps submitted candidate pending admission`, `amend reverifies changed accepted task`, `stale brief hash accepted when scope unchanged`, `stale brief hash rejected when scope changed`, `added prerequisite parks running submission`, `amend rejects unaccepted prerequisite on accepted task`, `request escalation requires user quote`, `failure retry uses rationale`, `failure hotfix requires mode`, `failure rejects root cause field`.
- #### [NEW] tests/unit/machines/implement-conflict.test.ts
  - Purpose: Tests `conflict emits integration-conflict decision`, `resolve reverifies touched tasks`, `resolve check failure returns decision`, `discard requires user-gated amendment`, `repair after failed check resolves on replay`.
- #### [MODIFY] tests/unit/machines/implement-verify.test.ts
  - Changes: Tests `transient evidence survives later mutation`, `trim excludes transient commands from final verify`, `rejects fix deleting durable test`, `trim keeps production path of transient criterion`, `shared transient durable command is kept`, `shared transient final command is kept`, `trim rejected when retained command names trimmed file`.
- #### [MODIFY] tests/unit/machines/implement-tasks.test.ts
  - Changes: Receipts use `WRITE_RECEIPT`.
- #### [MODIFY] tests/unit/machines/fixtures/implement-tasks.ts
  - Changes: Fixture receipts use `WRITE_RECEIPT`.
- #### [MODIFY] tests/unit/machines/parity.test.ts
  - Changes: Replay steps use `WRITE_RECEIPT` and generic `DECISION`; replace drain-state parity steps with `integration-conflict` and `request-decision` transitions.
- #### [MODIFY] tests/unit/machines/revision.test.ts
  - Changes: In-run revision cases use `AMEND`; scope adjudication cases use `request` and `request-user`; tests `plan revision request approved by orchestrator`, `plan revision request escalates to user`.
- #### [MODIFY] tests/unit/machines/design-revision.test.ts
  - Changes: Decisions use the generic shape; tests `design revision request approved by orchestrator`, `design revision request escalates to user`.
- #### [MODIFY] tests/unit/core/fixtures/flow-implement.ts
  - Changes: Flow fixture receipts use `WRITE_RECEIPT`.
- #### [MODIFY] tests/unit/core/effects-envelope.test.ts
  - Changes: Replace `SCOPE_REQUEST` envelope cases with `submitted` receipt envelope and `briefHash` cases.
- #### [MODIFY] tests/unit/core/diagnostics-collect.test.ts
  - Changes: Journal fixtures send `WRITE_RECEIPT` statuses instead of `WRITE_LAUNCHED`, `WRITE_ENVELOPE`, `WRITE_FAILED`.
- #### [MODIFY] tests/unit/core/diagnostics-journal.test.ts
  - Changes: Journal-scan cases count submitted writes from `WRITE_RECEIPT{status: 'submitted'}` lines instead of `WRITE_ENVELOPE` lines.
- #### [MODIFY] tests/unit/core/diagnostics-retro.test.ts
  - Changes: Retro-report cases derive writer outcomes from `WRITE_RECEIPT{status: 'submitted'}` instead of `WRITE_ENVELOPE`.
- #### [MODIFY] tests/unit/core/diagnostics-waits.test.ts
  - Changes: Wait fixtures send `WRITE_RECEIPT{status: 'submitted'}` instead of `WRITE_ENVELOPE`.
- #### [MODIFY] tests/unit/core/design-replay-nested.test.ts
  - Changes: Nested replay sends `WRITE_RECEIPT` launched and submitted statuses.
- #### [MODIFY] tests/unit/machines/implement-recovery.test.ts
  - Changes: Recovery validation uses `WRITE_RECEIPT` cancelled and failed statuses.
- #### [MODIFY] tests/unit/machines/design.test.ts
  - Changes: Design flow sends `WRITE_RECEIPT` launched and submitted statuses; replace the writer-draining test with `design child request keeps siblings running`.
- #### [MODIFY] tests/unit/machines/design-delivery.test.ts
  - Changes: Scope adjudication answers use `request`.
- #### [MODIFY] tests/unit/machines/fixtures/design.ts
  - Changes: Fixture scope answers use `request`.

### T5 — Contract and references
- Outcome: The agent-facing contract describes the new boundary, events, plan fields, and review criteria in their canonical homes.
- Constraints: Apply `writing-for-agents`; keep each rule in one home and link to it.
- Prerequisites: T1, T2, T4
- Criteria: SC14, SC21

- #### [MODIFY] skills/dispatch/SKILL.md
  - Changes: `Await write` and `Await decide` use `WRITE_RECEIPT`, `REQUEST`, `AMEND`, and generic `DECISION`; remove drain instructions.
- #### [MODIFY] skills/dispatch/references/verbs/implement.md
  - Changes: Replace drain and scope-deviation sections with the conflict, amendment, request, and transient-trim flows.
- #### [MODIFY] skills/dispatch/references/verbs/plan.md
  - Changes: The orchestrator chooses `Seams:` from existing test entry points and checks criteria against them; no user confirmation step.
- #### [MODIFY] skills/dispatch/references/change-handling.md
  - Changes: In-run plan changes use `AMEND`.
- #### [MODIFY] skills/dispatch/references/providers.md
  - Changes: Attested fields reference `WRITE_RECEIPT` statuses.
- #### [MODIFY] skills/dispatch/references/templates/plan.md
  - Changes: Add `Seams:`, `Overlap:`, `Retain: transient`, `Covered by:`; replace the disjoint-path rule with the overlap warning rule.
- #### [MODIFY] skills/dispatch/references/templates/write-brief-task.md
  - Changes: Writers send `REQUEST` and stay live; echo `briefHash` in the submitted receipt; apply notices.
- #### [MODIFY] skills/dispatch/references/templates/write-brief.md
  - Changes: Same receipt, request, and notice rules as the task brief.
- #### [MODIFY] skills/dispatch/references/templates/write-brief-hotfix.md
  - Changes: Replace taskless `WRITE_ENVELOPE`/`WRITE_FAILED` instructions with `WRITE_RECEIPT{status}` without identity fields.
- #### [MODIFY] skills/dispatch/references/templates/schemas/report-plan.json
  - Changes: Plan reviewers can report planned tests coupled to internals or duplicating seam coverage: add `test-leak` to the finding `category` enum.
- #### [MODIFY] skills/dispatch/references/templates/review-prompt-plan.md
  - Changes: In `against`, a shared write path is a defect only without a `Requires` path or `Overlap:` justification; Verify filters match existing or plan-named test titles; criteria verify through `Seams:`; transient criteria name valid `Covered by:`. In `tags`, decomposition covers unjustified overlap and verification adds `test-leak` (planned tests coupled to internals or duplicating seam coverage). `budget` becomes `8 + proposed-change entries`, at most 24.
- #### [MODIFY] skills/dispatch/references/templates/review-prompt-code.md
  - Changes: In `tags`, `test-leak` also covers retained tests that duplicate seam coverage; tests owned only by `Retain: transient` criteria are trimmed after review and are not `test-leak`.
- #### [MODIFY] tests/unit/core/effects-brief.test.ts
  - Changes: Brief assertions expect `REQUEST` and `briefHash` instructions instead of `SCOPE_REQUEST` and deviation requests.
- #### [MODIFY] tests/integration/skill-contract.test.ts
  - Changes: Contract assertions use the new event names; test `contract documents receipt request amend events`.

### T6 — End-to-end flows and hashes
- Outcome: Real Git flows prove conflict resolution, live amendment, and transient trimming; existing flows use the new protocol; state diagrams and skill hashes match.
- Prerequisites: T3, T4, T5
- Criteria: SC15, SC16

- #### [MODIFY] tests/e2e/implement.test.ts
  - Changes: Migrate existing scenarios to `WRITE_RECEIPT`; replace the `SCOPE_REQUEST`/`scope-deviation`/`scope-draining` scenarios with a `REQUEST` → `AMEND` scenario; add tests `resolves two-task integration conflict in place`, `applies live amendment while sibling keeps running`, `trims transient tests before final gate`.
- #### [GENERATED] docs/state-diagrams.md
  - Command: `npm run diagrams`
  - Inputs: skills/dispatch/scripts/machines/implement.ts, skills/dispatch/scripts/machines/design.ts, skills/dispatch/scripts/machines/root.ts
- #### [GENERATED] skills/dispatch/skill-hashes.json
  - Command: `npm run hashes`
  - Inputs: skills/dispatch/SKILL.md, skills/dispatch/references/verbs/implement.md, skills/dispatch/references/verbs/plan.md, skills/dispatch/references/templates/plan.md, skills/dispatch/references/templates/write-brief-task.md, skills/dispatch/scripts/machines/implement.ts, skills/dispatch/scripts/effects/checkout.ts

## Success Criteria

- [SC1] The validator accepts each `WRITE_RECEIPT` status, `REQUEST`, `AMEND`, and generic `DECISION`, and rejects removed write types by name.
  - Changes: skills/dispatch/scripts/core/types.ts, skills/dispatch/scripts/core/validate.ts, tests/unit/core/validate.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="^(accepts each write receipt status|rejects removed write event types|accepts request event|accepts amend event|accepts generic orchestrator decision|write await accepts receipt request amend|decide await accepts amend)$" tests/unit/core/validate.test.ts`
  - Evidence: red
  - Test rationale: Fails today because no shapes exist; retained because these shapes are the public host contract.
- [SC2] Frames render reply templates for the new types.
  - Changes: skills/dispatch/scripts/core/frame.ts, tests/unit/core/frame.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="^renders (write receipt|request|amend|generic decision) reply template$" tests/unit/core/frame.test.ts`
  - Evidence: red
  - Test rationale: Fails today because no templates exist; retained because hosts copy templates verbatim.
- [SC3] Journal replay rejects the prior protocol revision.
  - Changes: skills/dispatch/scripts/core/interpreter.ts, tests/unit/core/interpreter.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="^rejects journal from prior protocol revision$" tests/unit/core/interpreter.test.ts`
  - Evidence: red
  - Test rationale: Fails today because the current revision is the prior one; retained to guard against silent replay of incompatible journals.
- [SC4] Cross-task overlap warns unless justified, a same-task repeat stays a defect, and references never count.
  - Changes: skills/dispatch/scripts/domain/plan.ts, skills/dispatch/scripts/domain/types.ts, tests/unit/domain/plan.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="^(warns on unjustified cross-task overlap|accepts justified overlap|keeps duplicate path defect within one task|ignores reference-only paths for overlap|no overlap warning for directly ordered tasks|no overlap warning for transitively ordered tasks)$" tests/unit/domain/plan.test.ts`
  - Evidence: red
  - Test rationale: Fails today because any repeat is a defect; retained at the plan-parse seam that planners depend on.
- [SC5] `Seams:`, `Retain: transient`, and `Covered by:` parse, and an uncovered transient criterion is a defect.
  - Changes: skills/dispatch/scripts/domain/plan.ts, skills/dispatch/scripts/domain/types.ts, tests/unit/domain/plan.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="^(parses seams|parses transient retain and coverage|rejects transient criterion without coverage|rejects final coverage without final command)$" tests/unit/domain/plan.test.ts`
  - Evidence: red
  - Test rationale: Fails today because the fields are unknown; retained because the driver reads them to decide trimming.
- [SC6] Checkout preserves a conflict across retry and interrupted integrate, and `reset` aborts the cherry-pick.
  - Changes: skills/dispatch/scripts/effects/checkout.ts, tests/unit/core/effects-checkout.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="^(preserves conflicted integration tree|recovers conflict after interrupted integrate|reset aborts in-progress cherry-pick)$" tests/unit/core/effects-checkout.test.ts`
  - Evidence: red
  - Test rationale: Fails today because integrate discards conflicts; retained because lost conflict work is the highest-cost regression.
- [SC7] `resolve` refuses markers and out-of-scope paths and reuses a committed resolution; `trim` refuses unlisted, changed, or redirected paths and is idempotent.
  - Changes: skills/dispatch/scripts/effects/checkout.ts, skills/dispatch/scripts/effects/index.ts, tests/unit/core/effects-checkout.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="^(refuses resolution with conflict markers|refuses resolution outside permitted paths|reuses committed resolution on retry|repairs failed resolution as new attempt|trim refuses unlisted path|trim refuses changed file|trim refuses redirected ancestor|trim treats absent file as done)$" tests/unit/core/effects-checkout.test.ts`
  - Evidence: red
  - Test rationale: Fails today because the ops do not exist; retained because they are the guards on orchestrator-authored code.
- [SC8] A conflict emits `integration-conflict`; `resolve` re-verifies touched tasks; a check failure returns the decision; `discard` without a user-gated amendment is rejected.
  - Changes: skills/dispatch/scripts/machines/implement.ts, tests/unit/machines/implement-conflict.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="^(conflict emits integration-conflict decision|resolve reverifies touched tasks|resolve check failure returns decision|discard requires user-gated amendment|repair after failed check resolves on replay)$" tests/unit/machines/implement-conflict.test.ts`
  - Evidence: red
  - Test rationale: Fails today because a conflict calls taskFailed; retained at the machine seam as the discard-gate guard.
- [SC9] `REQUEST` keeps the writer active; `AMEND` notifies only named writers, follows the reconciliation rules, and rejects ungated intent changes.
  - Changes: skills/dispatch/scripts/machines/implement.ts, skills/dispatch/scripts/machines/implement-tasks.ts, skills/dispatch/scripts/machines/revision.ts, tests/unit/machines/implement-request.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="^(request keeps writer active|amend notifies only named writers|amend rejects intent change without user quote|amend rejects changed running task without notice|amend keeps submitted candidate pending admission|amend reverifies changed accepted task)$" tests/unit/machines/implement-request.test.ts`
  - Evidence: red
  - Test rationale: Fails today because REQUEST and AMEND do not exist; retained because writer continuity is the core behavior.
- [SC10] A stale `briefHash` is accepted only when the amendment left the task's paths and criteria unchanged.
  - Changes: skills/dispatch/scripts/machines/implement.ts, skills/dispatch/scripts/machines/implement-tasks.ts, tests/unit/machines/implement-request.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="^stale brief hash (accepted when scope unchanged|rejected when scope changed)$" tests/unit/machines/implement-request.test.ts`
  - Evidence: red
  - Test rationale: Fails today because no brief hash is tracked; retained to block work submitted against an obsolete scope.
- [SC11] Transient evidence survives later mutation, trimmed commands leave final verification, and a fix deleting a durable test is rejected.
  - Changes: skills/dispatch/scripts/machines/implement.ts, tests/unit/machines/implement-verify.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="^(transient evidence survives later mutation|trim excludes transient commands from final verify|rejects fix deleting durable test|trim keeps production path of transient criterion|shared transient durable command is kept|shared transient final command is kept|trim rejected when retained command names trimmed file)$" tests/unit/machines/implement-verify.test.ts`
  - Evidence: red
  - Test rationale: Fails today because all evidence must postdate mutation; retained because the guard prevents loss of durable tests.
- [SC12] The removed states no longer occur in the implement machine.
  - Changes: skills/dispatch/scripts/machines/implement.ts, skills/dispatch/scripts/machines/implement-types.ts
  - Verify: `node -e "const fs=require('fs');const s=['implement.ts','implement-types.ts'].map(f=>fs.readFileSync('skills/dispatch/scripts/machines/'+f,'utf8')).join('');const bad=['scope-adjudication','scope-user-decision','scope-draining','scope-drain-envelope','revision-request'].filter(t=>s.includes(\"'\"+t+\"'\"));if(bad.length){console.error(bad);process.exit(1)}"`
  - Evidence: verify
  - Test rationale: Structural dead-state check; a retained test would be low-signal, so it is a one-off Verify command.
- [SC21] Review prompts and the plan report schema match the new planning rules.
  - Changes: skills/dispatch/references/templates/review-prompt-plan.md, skills/dispatch/references/templates/review-prompt-code.md, skills/dispatch/references/templates/schemas/report-plan.json
  - Verify: `node -e "const fs=require('fs');const p=fs.readFileSync('skills/dispatch/references/templates/review-prompt-plan.md','utf8'),c=fs.readFileSync('skills/dispatch/references/templates/review-prompt-code.md','utf8'),j=fs.readFileSync('skills/dispatch/references/templates/schemas/report-plan.json','utf8');const miss=[[p,'Overlap:'],[p,'Seams:'],[p,'Covered by:'],[p,'test-leak'],[p,'at most 24'],[c,'Retain: transient'],[j,'test-leak']].filter(([t,k])=>!t.includes(k)).map(x=>x[1]);if(miss.length||/low-signal-test/.test(p+c+j)){console.error(miss);process.exit(1)}"`
  - Evidence: verify
  - Test rationale: Prompt-text presence check; a retained test would be low-signal, so it is a one-off Verify command.
- [SC13] No skill file names a removed event or decision kind.
  - Changes: skills/dispatch/SKILL.md, skills/dispatch/references/verbs/implement.md, skills/dispatch/references/templates/write-brief-task.md
  - Verify: `node -e "const fs=require('fs'),p=require('path');const w=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?w(p.join(d,e.name)):[p.join(d,e.name)]);const bad=w('skills/dispatch').filter(f=>/\.(md|ts|json)$/.test(f)&&/WRITE_ENVELOPE|WRITE_FAILED|WRITE_CANCELLED|WRITE_LAUNCHED|SCOPE_REQUEST|scope-deviation/.test(fs.readFileSync(f,'utf8')));if(bad.length){console.error(bad);process.exit(1)}"`
  - Evidence: verify
  - Test rationale: Stale-name scan over contract text; low-signal as a retained test, so it is a one-off Verify command.
  - Integration: removed names occur in T1, T3, T4, and T5 files.
- [SC14] The contract documents `WRITE_RECEIPT`, `REQUEST`, and `AMEND`.
  - Changes: tests/integration/skill-contract.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="^contract documents receipt request amend events$" tests/integration/skill-contract.test.ts`
  - Evidence: red
  - Test rationale: Fails today because the contract names the old events; retained because contract drift breaks hosts.
- [SC15] Real Git flows resolve a two-task conflict in place, apply a live amendment while a sibling runs, and trim transient tests before the final gate.
  - Changes: tests/e2e/implement.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="^(resolves two-task integration conflict in place|applies live amendment while sibling keeps running|trims transient tests before final gate)$" tests/e2e/implement.test.ts`
  - Evidence: red
  - Test rationale: Fails today because the flows do not exist; retained as the only seam that exercises real cherry-pick conflicts.
- [SC16] The full suite and hash check pass.
  - Changes: skills/dispatch/skill-hashes.json
  - Verify: `npm test` [FINAL]
  - Evidence: verify
  - Test rationale: Aggregate gate; adds no new test.

- [SC17] An added unaccepted prerequisite parks a running task's submission, and is rejected on an accepted task.
  - Changes: skills/dispatch/scripts/machines/implement-tasks.ts, tests/unit/machines/implement-request.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="^(added prerequisite parks running submission|amend rejects unaccepted prerequisite on accepted task)$" tests/unit/machines/implement-request.test.ts`
  - Evidence: red
  - Test rationale: Fails today because amendments do not exist; retained to block admission before a newly required producer completes.
- [SC18] Failure decisions accept `stop`, `retry`, and `hotfix` with `rationale`, reject `rootCause`, and an escalated request needs a user quote.
  - Changes: skills/dispatch/scripts/machines/implement-types.ts, skills/dispatch/scripts/machines/implement.ts, tests/unit/machines/implement-request.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="^(failure retry uses rationale|failure hotfix requires mode|failure rejects root cause field|request escalation requires user quote)$" tests/unit/machines/implement-request.test.ts`
  - Evidence: red
  - Test rationale: Fails today because failure answers require rootCause; retained because these payloads are the orchestrator's recovery contract.
- [SC20] Plan revision scope requests use `request` and `request-user`.
  - Changes: skills/dispatch/scripts/machines/revision.ts, tests/unit/machines/revision.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="^plan revision request (approved by orchestrator|escalates to user)$" tests/unit/machines/revision.test.ts`
  - Evidence: red
  - Test rationale: Fails today because plan revision emits scope-deviation; retained because root and design runs share the request contract.
- [SC19] Design revision scope requests use `request` and `request-user`.
  - Changes: skills/dispatch/scripts/machines/design-revision.ts, tests/unit/machines/design-revision.test.ts
  - Verify: `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts --test-name-pattern="^design revision request (approved by orchestrator|escalates to user)$" tests/unit/machines/design-revision.test.ts`
  - Evidence: red
  - Test rationale: Fails today because design revision emits scope-deviation; retained because design runs share the request contract.

## Verification Plan
### Automated Tests
- None: `npm test` is the SC16 Verify command.
### Manual Verification
- Read one rendered `integration-conflict` frame and one `AMEND` reply template; confirm they carry the paths, candidate, briefs, and notice fields the orchestrator needs.

## Out of Scope

- Merging internal effect-result event types (follow-up; touches review and design machines).
- `delegate` conflict action; pre-task exploration; generated brief context blocks.
- Migration of older live runs; provider (non-native) delegate changes.

## Rollback & Blast Radius

- Hosts that send removed events get a named validation defect; older live runs stop at replay with the protocol diagnostic. Rollback: revert the change set; no persistent data migrates.
- Lost-work risk is bounded by conflict preservation across crashes and journaling before effects.

## Review Findings & Resolutions

### Review 20261011T0428Z-thin-driver-orchestrator-owned-conflicts/001-plan/plan.review

#### Round 1 — full

- Reviewers: agy[0] gemini-3.8-flash (medium), codex[0] gpt-6.1-sol (low)

##### R1-F001

- Status: **[Fixed]**
- Severity: MUST
- Sources: agy[0]
- Location: § T1 — Protocol: merged receipts, generic decisions, REQUEST and AMEND
- Category: spec-gap
- Finding: The spec explicitly mandates: 'The target is about 22 event types. The plan must list each removed and merged type, and each removed state' (.scratch/dispatch-skills/20261011T0428Z-thin-driver-orchestrator-owned-conflicts/thin-driver.spec.md:L59). The plan only replaces 4 write events with WRITE_RECEIPT and adds REQUEST and AMEND, leaving 31 of 32 event types intact (skills/dispatch/scripts/core/types.ts:L197-250), and fails to enumerate which types are removed or merged to reach ~22, as well as omitting the full list of removed states beyond drain states.
- Required change: Enumerate each removed and merged event type required to reach the ~22 target count, and list every state removed or introduced across implement.ts (including scope-adjudication, scope-user-decision, and pending conflict/request states).

##### R1-F002

- Status: **[Fixed]**
- Severity: MUST
- Sources: agy[0]
- Location: § T3 — Checkout: keep conflicts and commit resolutions
- Category: correctness
- Finding: T3 specifies that checkout op resolve 'refuses unmerged paths and conflict markers in the conflicted paths, commits with trailers...'. When integrate cherry-pick conflicts (skills/dispatch/scripts/effects/checkout.ts:L176-181), git records unmerged index stages (diff-filter=U). Because the orchestrator resolves conflicts by editing worktree files and does not execute Git staging commands, checking for unmerged index paths prior to staging will always fail.
- Required change: Specify that resolve inspects the conflicted files on disk to ensure conflict markers are absent, stages the resolved paths with git add, verifies that no unmerged paths remain in the index, and then commits.

##### R1-F003

- Status: **[Fixed]**
- Severity: MUST
- Sources: agy[0]
- Location: § T3 — Checkout: keep conflicts and commit resolutions
- Category: state-machine
- Finding: T3 modifies integrate to keep the conflicted cherry-pick state in the integration worktree instead of calling discard(ports, root, expected) (skills/dispatch/scripts/effects/checkout.ts:L175-181). While resolve handles committing a resolution, neither T3 nor T4 provides an op or transition to abort the in-progress cherry-pick when the orchestrator chooses delegate or discard, leaving the integration worktree dirty and corrupting subsequent operations.
- Required change: Specify that when the orchestrator chooses delegate or discard, the driver executes a checkout reset/discard operation to abort the in-progress cherry-pick and restore the integration worktree to expected HEAD.

##### R1-F004

- Status: **[Fixed]**
- Severity: MUST
- Sources: agy[0]
- Location: § T1 — Protocol: merged receipts, generic decisions, REQUEST and AMEND
- Category: architecture
- Finding: The spec requires that discard during integration conflict 'needs a scope expansion and a user quote' (.scratch/dispatch-skills/20261011T0428Z-thin-driver-orchestrator-owned-conflicts/thin-driver.spec.md:L69). However, T1 defines the generic DECISION shape strictly as {kind, action, rationale, by}, providing no field or mechanism for transmitting or validating the scope expansion delta when discard is selected.
- Required change: Define how the scope expansion delta is provided and validated for discard—either by including an optional delta field in the DECISION shape or by requiring a preceding AMEND before discard is accepted.

##### R1-F005

- Status: **[Fixed]**
- Severity: SHOULD
- Sources: agy[0]
- Location: § T2 — Plan domain: overlap warnings, seams, transient criteria
- Category: architecture
- Finding: T3 adds checkout ops resolve and trim, but neither T1 nor T3 updates CheckoutOp in skills/dispatch/scripts/core/types.ts:L133. Furthermore, T2 adds seams, retain, and warnings to plan parsing, but neither T1 nor T2 updates ParsedPlan or PlanCriterion in skills/dispatch/scripts/domain/types.ts:L62-103, nor asParsedPlan in skills/dispatch/scripts/machines/implement-types.ts:L78, which will cause TypeScript compilation failures and drop parsed fields across journal boundaries.
- Required change: Add skills/dispatch/scripts/core/types.ts to T3 (or T1) to add 'resolve' | 'trim' to CheckoutOp; add skills/dispatch/scripts/domain/types.ts to T2 to update ParsedPlan and PlanCriterion; and update asParsedPlan in implement-types.ts.

##### R1-F006

- Status: **[Fixed]**
- Severity: SHOULD
- Sources: agy[0]
- Location: § T4 — Implement machine: orchestrator decisions, amendments, no drain
- Category: blast-radius
- Finding: Replacing write events and removing scope-deviation breaks existing callers and tests not accounted for in the plan: tests/unit/machines/parity.test.ts:L91, tests/unit/machines/revision.test.ts:L226, tests/unit/machines/design-revision.test.ts:L130, tests/unit/core/fixtures/flow-implement.ts:L114, tests/integration/skill-contract.test.ts:L79-102, existing scenarios in tests/e2e/implement.test.ts, and skills/dispatch/scripts/effects/index.ts:L89 (which writes WRITE_ENVELOPE). These unlisted dependents will fail during npm test.
- Required change: Include the affected tests (parity.test.ts, revision.test.ts, design-revision.test.ts, flow-implement.ts, skill-contract.test.ts, existing tests in tests/e2e/implement.test.ts) and skills/dispatch/scripts/effects/index.ts in the proposed changes and task scopes.

##### R1-F007

- Status: **[Fixed]**
- Severity: SHOULD
- Sources: agy[0]
- Location: § T4 — Implement machine: orchestrator decisions, amendments, no drain
- Category: domain-logic
- Finding: T4 states that 'after delivery the final review/fix step may call trim with the transient criteria's test paths', but does not specify the machine state or trigger for trim, how reviewers signal test trimming, or how the driver enforces 'the driver refuses the removal of a test file that is not attributed to a transient criterion' (.scratch/dispatch-skills/20261011T0428Z-thin-driver-orchestrator-owned-conflicts/thin-driver.spec.md:L117) during review fix application.
- Required change: Specify the machine state and effect dispatch for trim in implement.ts, and define how the driver validates test file deletions during review/fix (e.g. during FIXES_APPLIED or snapshot checks) against transient criteria.

##### R1-F008

- Status: **[Fixed]**
- Severity: SHOULD
- Sources: agy[0]
- Location: § SC7
- Category: verification
- Finding: SC7's Verify command executes the entire tests/unit/machines/implement-request.test.ts without --test-name-pattern. Because SC8 also targets implement-request.test.ts (with --test-name-pattern="stale brief"), SC7 executes tests outside its own criterion, violating the requirement that a criterion's command runs only that criterion's tests.
- Required change: Add --test-name-pattern to SC7's Verify command to match only SC7's tests (e.g. --test-name-pattern="request decision|amend").

##### R1-F009

- Status: **[Fixed]**
- Severity: CONSIDER
- Sources: agy[0]
- Location: § T4 — Implement machine: orchestrator decisions, amendments, no drain
- Category: validation
- Finding: The spec states delegate is chosen 'if the task writer is live' (.scratch/dispatch-skills/20261011T0428Z-thin-driver-orchestrator-owned-conflicts/thin-driver.spec.md:L68). T4 does not define guard behavior or diagnostic rejection if the orchestrator sends action: 'delegate' when the writer is not live.
- Required change: Add a driver guard rejecting delegate with a descriptive error when the candidate task writer is not active.

##### R1-F010

- Status: **[Fixed]**
- Severity: CONSIDER
- Sources: agy[0]
- Location: § SC2
- Category: standards
- Finding: SC2 checks that 'journal replay rejects the prior protocol revision' using tests/unit/core/frame.test.ts. Prior protocol rejection on replay is enforced by skills/dispatch/scripts/core/interpreter.ts:L135 and belongs in tests/unit/core/interpreter.test.ts, not frame.test.ts.
- Required change: Target tests/unit/core/interpreter.test.ts for the protocol revision rejection check and add it to T1's modified test paths.

##### R1-F011

- Status: **[Fixed]**
- Severity: CONSIDER
- Sources: agy[0]
- Location: § SC10
- Category: testability
- Finding: SC10 validates state removal and size reduction by checking that implement.ts has fewer lines than 1,747 via an inline script. Line count is a brittle proxy for dead-code removal that can fail on minor formatting or error handling changes.
- Required change: Replace the raw line count check with a behavioral test or structural check asserting that drain states are absent from exported machine transitions.

##### R1-F012

- Status: **[Fixed]**
- Severity: SHOULD
- Sources: codex[0]
- Location: § T1 — Protocol: merged receipts, generic decisions, REQUEST and AMEND
- Category: coherence
- Finding: The proposed WRITE_RECEIPT fields omit the brief hash required by SC8 and the task-brief instructions. With unknown fields rejected, a writer cannot echo that hash. The existing submitted receipt also carries envelopePath, whereas T1 substitutes an undefined envelope field (skills/dispatch/scripts/core/validate.ts:L166). SC8 should expose this mismatch during implementation.
- Required change: Define status-specific receipt schemas, including the submitted envelope path, brief hash, required identity fields, and retained attestation fields. Use those exact schemas in frames, briefs, admission, and tests.

##### R1-F013

- Status: **[Fixed]**
- Severity: SHOULD
- Sources: codex[0]
- Location: § T2 — Plan domain: overlap warnings, seams, transient criteria
- Category: correctness
- Finding: T2 describes removing a hard disjoint-path defect, but the actual blocker is global duplicate-change-path validation at skills/dispatch/scripts/domain/plan.ts:L586. It rejects repeated paths regardless of task dependencies or Overlap justification. Adding warnings alone leaves overlapping plans invalid; SC3 should expose this.
- Required change: Explicitly revise global duplicate validation to distinguish permitted cross-task overlap from malformed duplicate entries and case aliases. Define the flattened change representation and update affected duplicate-path tests.

##### R1-F014

- Status: **[Fixed]**
- Severity: MUST
- Sources: codex[0]
- Location: § T3 — Checkout: keep conflicts and commit resolutions
- Category: partial-failure
- Finding: Conflict preservation covers retries with a recorded pending conflict, but omits a crash after Git creates conflicts and before CHECKOUT_DONE records them. On replay, the existing integrate operation resets the tree at skills/dispatch/scripts/effects/checkout.ts:L175. A journaled effect intent alone does not supply the pending-conflict result, so this crash window can erase resolution work.
- Required change: Define recovery for an interrupted integrate effect before its result is recorded. Detect and bind existing cherry-pick/conflict state to the candidate and expected head before any reset. Add interruption-and-resume verification at this boundary.

##### R1-F015

- Status: **[Fixed]**
- Severity: MUST
- Sources: codex[0]
- Location: § T4 — Implement machine: orchestrator decisions, amendments, no drain
- Category: security
- Finding: The new resolve operation checks unresolved paths and markers, then commits orchestrator edits, but the plan specifies no admission check for all resulting changes against approved scope. Existing scope admission checks the writer candidate before integration at skills/dispatch/scripts/machines/implement.ts:L760; it cannot constrain edits made afterward in the integration tree. Passing affected checks can therefore admit an out-of-scope resolution.
- Required change: Before committing a resolution, enumerate all tracked and untracked changes against the recorded integration head and enforce approved scope. Bind returned paths and verification selection to that complete delta. Add rejection tests for extra edits outside scope.

##### R1-F016

- Status: **[Fixed]**
- Severity: MUST
- Sources: codex[0]
- Location: § Open Questions & Assumptions
- Category: approach
- Finding: The assumption that delegate can reuse scopeRebase unchanged is contradicted by its interface: it copies the uncommitted diff against HEAD into a different worktree (skills/dispatch/scripts/effects/checkout.ts:L243 and skills/dispatch/scripts/effects/checkout.ts:L258). Integration happens after the candidate is committed, so that diff can be empty. Its machine continuation also clears the handle and makes the task pending (skills/dispatch/scripts/machines/implement.ts:L755), rather than retaining a live writer.
- Required change: Specify a candidate-aware delegation transfer and live-writer handoff. Define which writer receives the work, its destination and identity, how committed candidate changes are preserved, and how transfer conflicts return to the orchestrator. Add delegate-specific machine and Git-flow checks.

##### R1-F017

- Status: **[Fixed]**
- Severity: MUST
- Sources: codex[0]
- Location: § T4 — Implement machine: orchestrator decisions, amendments, no drain
- Category: spec-gap
- Finding: Transient trimming has no defined source of test-file attribution, rule for files shared with durable criteria, or durable-coverage check. Criterion changes include production files as well as tests (skills/dispatch/scripts/domain/types.ts:L62). The final verifier still schedules every criterion command at skills/dispatch/scripts/machines/implement.ts:L990, so exempting evidence freshness alone does not prevent commands targeting deleted transient tests from failing.
- Required change: Define authoritative transient test attribution and shared-file protection. Specify how durable seam or aggregate coverage is established, how trimmed criterion commands are excluded from later execution while retaining historical evidence, and how trim enters the final review/fix flow. Verify these cases explicitly.

##### R1-F018

- Status: **[Fixed]**
- Severity: MUST
- Sources: codex[0]
- Location: § T4 — Implement machine: orchestrator decisions, amendments, no drain
- Category: state-machine
- Finding: AMEND has no concrete reconciliation rules for changed running tasks, removed tasks, changed prerequisites, or already accepted work. Existing reconcileTasks replaces changed tasks and descendants with fresh records, dropping live handles (skills/dispatch/scripts/machines/implement-tasks.ts:L85), and invalidatesIntegration detects accepted work that must be rebuilt (skills/dispatch/scripts/machines/implement-tasks.ts:L95). T4 only assigns brief-hash tracking and scheduling changes to this file. Reusing reconciliation breaks writer continuity; bypassing it can retain work accepted under obsolete criteria.
- Required change: Define amendment transitions for running, submitted, accepted, removed, and dependent tasks. Preserve live attempt identities, retain submitted work pending an orchestrator ruling, and specify when accepted work and evidence require revalidation or integration reconstruction. Add tests for each boundary.

##### R1-F019

- Status: **[Fixed]**
- Severity: SHOULD
- Sources: codex[0]
- Location: § Success Criteria
- Category: verification
- Finding: Several Verify filters have no matching existing test names, and the plan does not name their proposed replacements. For example, SC2 selects receipt template, amend template, and prior protocol, none present in tests/unit/core/frame.test.ts:L13 onward. SC7 runs the entire request file, including SC8's stale-brief tests. SC11 checks only forbidden names and can pass without documenting new fields. Thus the specified checks do not establish each criterion independently.
- Required change: Name the exact new or renamed tests and align anchored filters with those names. Separate SC7 and SC8 checks, include REQUEST and generic-decision frame coverage, and add positive documentation checks for required events and fields. Ensure each command fails when no intended tests match.

##### R1-F020

- Status: **[Fixed]**
- Severity: SHOULD
- Sources: codex[0]
- Location: § T5 — Contract and references
- Category: intent
- Finding: The requirement says the planner confirms Seams with the user, but T5 only adds the field; no task adds that confirmation step. It also adds low-signal-test only to review-rules.md, while the plan-report tag vocabulary is separately declared in skills/dispatch/references/templates/schemas/report-plan.json:L46. The new finding class is not traced through its reporting contract.
- Required change: Add the user confirmation step to the canonical planning instructions and assign its verification. Trace low-signal-test through the report schema and any enforcing vocabulary, or explicitly define its intended reporting representation.
- Ruling:
  user: if it's not a major decision that needs me, I'd prefer if the orchestrator can make the call  

#### Round 2 — full

- Reviewers: codex[0] gpt-6.1-sol (low)
- Failed: agy[0] (timeout: timed out after 599992 ms; partial output at C:/Users/fchei/Projects/dispatch-skills/.scratch/dispatch-skills/20261011T0428Z-thin-driver-orchestrator-owned-conflicts/.state/runs/001-plan/plan.review.prepare-review.2/agy-0.log)

##### R2-F001

- Status: **[Fixed]**
- Severity: MUST
- Sources: codex[0]
- Location: § T3 — Checkout: preserve conflicts, commit scoped resolutions, trim
- Category: security
- Finding: The new trim operation deletes caller files based only on path membership in allowed. It has no content binding or ancestor checks. A caller edit after delivery, or a replaced ancestor, can therefore cause deletion of unrelated work. Existing delivery checks content and ancestors before mutation at skills/dispatch/scripts/effects/checkout.ts:L207-L219; T3 preserves those checks only for deliver.
- Required change: Bind trim to the expected post-review file content and checkout location. Reject changed files, unsafe paths, and redirected ancestors before deleting anything; treat an already absent file as an idempotent retry. Add focused collision and path-safety tests.

##### R2-F002

- Status: **[Fixed]**
- Severity: MUST
- Sources: codex[0]
- Location: § T4 — Implement machine: orchestrator decisions, amendments, transient evidence
- Category: dependency-graph
- Finding: The new reconciliation rule keeps dependents unchanged unless their own signature changes. If AMEND adds a prerequisite to a running or accepted task, it also preserves that task without specifying how the prerequisite is satisfied before admission. Existing readiness enforces prerequisites only for pending tasks at skills/dispatch/scripts/machines/implement-tasks.ts:L99-L101. Thus a live task can remain admissible before its newly required producer completes. This concerns the explicit replacement rule added after R1-F018.
- Required change: Define admission and acceptance guards for amended prerequisite graphs. Preserve live handles, but park affected submissions until prerequisites are accepted and establish the required verification against their integrated outputs. Add tests for newly added prerequisites on running, submitted, and accepted tasks.

##### R2-F003

- Status: **[Fixed]**
- Severity: MUST
- Sources: codex[0]
- Location: § Key Decisions & Context
- Category: correctness
- Finding: The replacement trimming rule makes any file trimmable when every criterion listing it is transient, without requiring that it is a test file. Criterion Changes includes production paths at skills/dispatch/scripts/domain/types.ts:L66, and the repository already distinguishes test paths at skills/dispatch/scripts/machines/implement-types.ts:L75. Automatic trim can therefore delete production implementation owned only by transient criteria. This is new evidence against the concrete attribution rule introduced to resolve R1-F017.
- Required change: Restrict automatic trimming to explicitly attributed test files, using a defined test-path classifier or explicit test-file metadata. Preserve production files regardless of criterion retention. Add a test where a transient criterion lists both production and test paths.

##### R2-F004

- Status: **[Fixed]**
- Severity: MUST
- Sources: codex[0]
- Location: § T1 — Protocol: merged receipts, generic decisions, REQUEST and AMEND
- Category: coherence
- Finding: The strict generic failure answer permits only action, rationale, by, and amendment, but the existing failure consumer requires rootCause for retry and rootCause plus hotfix configuration for hotfix at skills/dispatch/scripts/machines/implement-types.ts:L53-L66. T4 does not assign replacement failure parsing or action semantics. A schema-valid retry answer cannot satisfy the existing consumer, while the fields it needs are rejected as unknown. No named criterion tests this failure path.
- Required change: Define the supported failure actions and their exact payloads, update failureAnswer and all consumers, and assign focused tests for each action and guard rejection. If rationale replaces rootCause, state that mapping explicitly.

##### R2-F005

- Status: **[Fixed]**
- Severity: SHOULD
- Sources: codex[0]
- Location: § T4 — Implement machine: orchestrator decisions, amendments, transient evidence
- Category: compatibility
- Finding: T1 removes scope-deviation and scope-deviation-user globally, but T4 only tells design-revision to accept generic answers. Design revisions still emit these removed kinds and use a user escalation branch at skills/dispatch/scripts/machines/design-revision.ts:L151-L152 and skills/dispatch/scripts/machines/design-revision.ts:L161-L167. Changing answer shapes alone leaves design revisions unable to receive valid replies. SC13 will deterministically expose the remaining names.
- Required change: Specify replacement decision kinds, emitted frames, user-quote handling, and transitions for design revision scope adjudication. Add focused design-revision tests for orchestrator approval and user escalation.

##### R2-F006

- Status: **[Fixed]**
- Severity: SHOULD
- Sources: codex[0]
- Location: § T2 — Plan domain: overlap warnings, seams, transient criteria
- Category: intent
- Finding: T2 warns for every cross-task repeated path, including tasks ordered by Requires. The approved requirement limits overlap detection to tasks without a Requires path between them in .scratch/dispatch-skills/20261011T0428Z-thin-driver-orchestrator-owned-conflicts/thin-driver.spec.md:L95. Ordered tasks therefore receive spurious warnings even though adding Requires is the prescribed remedy.
- Required change: Exclude task pairs connected by a transitive Requires path from overlap warnings. Add focused tests for direct and transitive ordering, and include them in SC4.
- Ruling:
  user: if it's not a major decision that needs me, I'd prefer if the orchestrator can make the call  

#### Round 3 — full

- Reviewers: agy[0] gemini-3.8-flash (medium), codex[0] gpt-6.1-sol (low)

##### R3-F001

- Status: **[Fixed]**
- Severity: MUST
- Sources: agy[0]
- Location: § T3 — Checkout: preserve conflicts, commit scoped resolutions, trim
- Category: state-machine
- Finding: T3 specifies that checkout op resolve 'commits with Dispatch-Candidate: <candidate> and Dispatch-Resolves: <tasks>; a retry that finds the trailer returns reused: true'. However, when a resolution check verification fails (spec §6.1.4, plan §SC8: 'a check failure returns the decision'), the integration worktree already contains the committed resolution R1 with those trailers. When the orchestrator updates files in the integration worktree to fix the failing checks and re-submits action: 'resolve', resolve's trailer check against git log in skills/dispatch/scripts/effects/checkout.ts:L170-L174 finds Dispatch-Resolves and returns reused: true with the prior failing revision R1, ignoring dirty working tree edits and failing to commit the fix. The plan specifies no mechanism to reset, amend, or supersede a resolution commit after a check failure.
- Required change: Specify that resolve only returns reused: true when the working tree is clean and matches the recorded revision. If the working tree contains uncommitted changes or if re-resolving after a check verification failure, resolve must reset/amend the prior failed attempt or commit the updated resolution against expected without triggering reused: true.

##### R3-F002

- Status: **[Fixed]**
- Severity: MUST
- Sources: agy[0]
- Location: § T4 — Implement machine: orchestrator decisions, amendments, transient evidence
- Category: blast-radius
- Finding: T1 removes scope-deviation and scope-deviation-user globally, and T4 updates design-revision.ts (per R2-F005). However, skills/dispatch/scripts/machines/revision.ts:L134-L144, skills/dispatch/scripts/machines/revision.ts:L209-L210, and skills/dispatch/scripts/machines/revision.ts:L220-L226 still emit and validate scope-deviation and scope-deviation-user for plan revision scope adjudication during root and design runs (skills/dispatch/scripts/machines/root.ts:L15, skills/dispatch/scripts/machines/design.ts:L10), and tests/unit/machines/revision.test.ts:L226-L277, L309-L353 tests those exact shapes. T4 omits updating revision.ts to use request / request-user. Consequently, SC13 will fail deterministically on skills/dispatch/scripts/machines/revision.ts, and npm test will fail TypeScript compilation and tests in revision.test.ts.
- Required change: Add explicit changes in T4 for skills/dispatch/scripts/machines/revision.ts to emit kind: 'request' and accept request / request-user (matching design-revision.ts), and update tests/unit/machines/revision.test.ts in T4 to test request and request-user.

##### R3-F003

- Status: **[Fixed]**
- Severity: SHOULD
- Sources: agy[0]
- Location: § T4 — Implement machine: orchestrator decisions, amendments, transient evidence
- Category: blast-radius
- Finding: T1 replaces the four write event types with WRITE_RECEIPT and removes SCOPE_REQUEST handling from check-envelope.ts. Multiple existing test suites and fixtures outside the plan's listed changes depend on these removed types and will fail under npm test (SC16): tests/unit/core/effects-brief.test.ts:L46-L76 asserts SCOPE_REQUEST and deviation request instructions in briefs; tests/unit/core/effects-envelope.test.ts:L40-L60 tests SCOPE_REQUEST status and scope request parsing in envelopes; tests/unit/core/diagnostics-collect.test.ts:L65-L117, L175-L180, L365 sends WRITE_LAUNCHED, WRITE_ENVELOPE, and WRITE_FAILED; tests/unit/core/diagnostics-journal.test.ts:L259-L277, tests/unit/core/diagnostics-retro.test.ts:L44-L58, and tests/unit/core/diagnostics-waits.test.ts:L98-L265 send WRITE_ENVELOPE; tests/unit/machines/implement-recovery.test.ts:L71-L72 validates WRITE_CANCELLED and WRITE_FAILED; tests/unit/machines/design.test.ts:L46 and tests/unit/core/design-replay-nested.test.ts:L68-L70 send WRITE_LAUNCHED and WRITE_ENVELOPE; tests/unit/machines/design-delivery.test.ts:L50 and tests/unit/machines/fixtures/design.ts:L25 send scope-deviation; and tests/e2e/implement.test.ts:L163-L178, L197-L200 contains dedicated scenarios for SCOPE_REQUEST, scope-deviation, and scope-draining.
- Required change: Include these test and fixture files in the task scopes (T1, T4, T6) and specify their migration to WRITE_RECEIPT, REQUEST, and request/request-user, and replace or remove the deleted scope-draining e2e test scenario.

##### R3-F004

- Status: **[Fixed]**
- Severity: SHOULD
- Sources: agy[0]
- Location: § T1 — Protocol: merged receipts, generic decisions, REQUEST and AMEND
- Category: coherence
- Finding: In skills/dispatch/scripts/core/validate.ts:L191-L201, AWAIT_ACCEPTS defines permitted host event types per await. T1 defines new shapes in validate.ts but does not update AWAIT_ACCEPTS. At await write, incoming WRITE_RECEIPT, writer REQUEST, and live AMEND will be rejected by validateHostEvent (skills/dispatch/scripts/core/validate.ts:L212-L215). Furthermore, at await decide in request-decision, an orchestrator answering a writer request with AMEND (per Key Decisions: 'REQUEST keeps the writer live; the orchestrator answers with AMEND') will be rejected because decide currently only accepts DECISION and REVISE.
- Required change: Specify the updates to AWAIT_ACCEPTS in skills/dispatch/scripts/core/validate.ts: write accepts WRITE_RECEIPT, REQUEST, AMEND; and decide accepts DECISION, AMEND.

##### R3-F005

- Status: **[Fixed]**
- Severity: SHOULD
- Sources: agy[0]
- Location: § T4 — Implement machine: orchestrator decisions, amendments, transient evidence
- Category: state-machine
- Finding: T4 states that 'after the final review/fix step, emit trim for trimmable files, exclude trimmed criteria commands from startFinalVerify, then run final verification'. However, trim is an asynchronous checkout effect returning CHECKOUT_DONE with op 'trim'. Neither ImplementState in skills/dispatch/scripts/machines/implement.ts:L73-L119, implement-types.ts, nor CheckoutStep (skills/dispatch/scripts/machines/implement.ts:L71) defines a state or step to receive and handle the in-flight trim effect and its CHECKOUT_DONE result event before progressing to startFinalVerify, and implementTransitions (skills/dispatch/scripts/machines/implement.ts:L1649) defines no static transitions for trim.
- Required change: Add a checkout step (e.g. 'trim' in CheckoutStep) or machine state in implement.ts and implement-types.ts that dispatches the trim checkout effect and handles CHECKOUT_DONE with op: 'trim' before invoking startFinalVerify, and register its transition in implementTransitions.

##### R3-F006

- Status: **[Fixed]**
- Severity: MUST
- Sources: codex[0]
- Location: § T3 — Checkout: preserve conflicts, commit scoped resolutions, trim
- Category: state-machine
- Finding: T4 returns a failed resolution check to the orchestrator, but T3 makes resolve reuse any commit with the candidate trailer. After the orchestrator edits that committed resolution to fix the failure, another resolve can reuse the previous commit without committing or scope-checking the repair. The existing trailer recovery at skills/dispatch/scripts/effects/checkout.ts:L170-L173 distinguishes candidates, not resolution attempts. The plan does not define a fresh repair attempt or its expected head, so the promised recovery loop is incomplete.
- Required change: Distinguish replay of a completed resolve effect from a new resolution attempt after verification failure. Bind each attempt to its expected head and resolution identity; scope-check and commit fresh repairs, then rerun affected checks. Add a named test covering resolve -> failed check -> edited repair -> successful resolve, including replay.

##### R3-F007

- Status: **[Fixed]**
- Severity: MUST
- Sources: codex[0]
- Location: § T2 — Plan domain: overlap warnings, seams, transient criteria
- Category: verification
- Finding: The new Covered by: FINAL rule accepts the sentinel without requiring an aggregate gate to exist. Current parsing derives finalCommands only from explicitly marked commands at skills/dispatch/scripts/domain/plan.ts:L492; it can therefore be empty. A plan can attribute all transient coverage to FINAL, trim those tests, and exclude their commands without executing the promised replacement coverage. This is new evidence about the concrete coverage rule added after R1-F017.
- Required change: Reject Covered by: FINAL when no applicable final aggregate command exists. Before trimming, validate that each coverage target remains executable after removal, and require successful post-trim coverage before completion. Add focused tests for an absent FINAL gate and a coverage target that references a trimmed file.

##### R3-F008

- Status: **[Fixed]**
- Severity: MUST
- Sources: codex[0]
- Location: § T4 — Implement machine: orchestrator decisions, amendments, transient evidence
- Category: invariant
- Finding: The instruction to exclude trimmed criteria's Verify commands has no rule for commands shared with durable criteria or the final gate. commandMappings deduplicates commands and combines their criterion ownership at skills/dispatch/scripts/machines/implement-types.ts:L143-L165, and startFinalVerify executes those combined mappings at skills/dispatch/scripts/machines/implement.ts:L990-L992. Removing a command because a trimmed criterion owns it can also remove durable verification or the aggregate gate; retaining it can execute a command targeting deleted tests. File-level shared ownership protection does not resolve command-level ownership.
- Required change: Define exclusion at the combined command-mapping boundary. Preserve every command required by durable criteria or final coverage; reject trimming when such a command requires the removed files unless an approved amendment replaces it. Add named tests for a transient/durable shared command and a transient/final shared command.

#### Round 4 — delta

- Reviewers: agy[0] gemini-3.8-flash (medium), codex[0] gpt-6.1-sol (low)

##### R4-F001

- Status: **[Fixed]**
- Severity: SHOULD
- Sources: agy[0]
- Location: § T4 — Implement machine: orchestrator decisions, amendments, transient evidence
- Category: blast-radius
- Finding: T4 modifies skills/dispatch/scripts/machines/implement-types.ts to remove states scope-adjudication, scope-user-decision, scope-draining, scope-drain-envelope, and revision-request from ImplementState, and removes their transitions from implement.ts. However, unlisted parent and wrapper machines pattern-match on these removed states: skills/dispatch/scripts/machines/root.ts:L110 matches child.state.tag === 'revision-request' to launch plan revisions; skills/dispatch/scripts/machines/design.ts:L133 checks child.tag === 'revision-request'; skills/dispatch/scripts/machines/design.ts:L333 checks state.child.tag === 'scope-adjudication' || state.child.tag === 'scope-user-decision' to enforce writer draining; and skills/dispatch/scripts/machines/execution-config.ts:L42 checks state.tag === 'scope-drain-envelope'. Furthermore, tests/unit/machines/design.test.ts:L49-L80 tests draining and asserts against scope-adjudication and scope-user-decision, and tests/unit/machines/parity.test.ts:L301-L317,L355-L495 asserts machine parity across transitions between scope-adjudication, scope-user-decision, scope-draining, and scope-drain-envelope. When these states and transitions are removed, npm run typecheck (tsc -p ., invoked by npm test) will fail with TS2367/TS2322 on root.ts, design.ts, execution-config.ts, and design.test.ts, and parity.test.ts will fail on removed transitions. Neither root.ts nor design.ts is included in T4's scope, and T4's changes for execution-config.ts, design.test.ts, and parity.test.ts omit updating these dead state checks and transition assertions.
- Required change: Add skills/dispatch/scripts/machines/root.ts and skills/dispatch/scripts/machines/design.ts to T4 to remove the obsolete revision-request, scope-adjudication, and scope-user-decision branches; update skills/dispatch/scripts/machines/execution-config.ts in T4 to remove the scope-drain-envelope check; update tests/unit/machines/design.test.ts in T4 to remove or update the writer-draining test; and update tests/unit/machines/parity.test.ts in T4 to replace the removed drain state transition assertions with the new machine transitions.

##### R4-F002

- Status: **[Fixed]**
- Severity: SHOULD
- Sources: codex[0]
- Location: § T6 — End-to-end flows and hashes
- Category: blast-radius
- Finding: T4 changes implementTransitions, but no task owns regeneration of docs/state-diagrams.md. scripts/diagram.ts:L10 imports those transitions, and scripts/diagram.ts:L34 compares the generated diagram with the checked-in file. The existing diagram still contains removed states at docs/state-diagrams.md:L283 and docs/state-diagrams.md:L286. SC16's npm test includes check:diagrams and will fail deterministically.
- Required change: Add docs/state-diagrams.md as a generated output owned by T6, with npm run diagrams after the machine changes and before SC16 verification. Include this path in the bounded change scope.
