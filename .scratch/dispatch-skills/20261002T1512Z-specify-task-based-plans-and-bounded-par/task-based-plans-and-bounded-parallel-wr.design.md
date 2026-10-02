# Task-based plans and bounded parallel writers

> **TL;DR:** Generate readable, task-based plans and execute independent tasks concurrently with isolated writers and verified integration.
> **Parent:** user request
> **Decide:** Review this specification before implementation planning.
> **Risk:** high — changes writer coordination, evidence admission, worktree integration, and recovery.
> **Increments:** 3

## Context & Intent

The user wants plans grouped into meaningful parallelizable tasks. Each task begins with a plain-language summary, followed by the concrete file-by-file changes already provided today. Writers need the overall goal and interactions without loading every unrelated implementation detail.

Current `domain/plan.ts` parses a flat change list. `machines/implement.ts` coordinates one writer stage at a time, including separate tests-only and production launches. `effects/check-envelope.ts` attributes mutations against checkout snapshots. Parallel execution must change these assumptions deliberately.

The design balances correctness, token efficiency, speed, and implementation complexity. It retains deterministic coordination and acceptance while leaving the writer's development loop in prose.

The reference attachment mentioned initially was not available in this conversation; this specification derives from the discussed requirements and current checkout, not an unseen reference.

## Goals & Requirements

- Every planned change belongs to one meaningful task, with a stable ID, human summary, prerequisite IDs, detailed H4 file changes, and mapped acceptance criteria.
- A task has a distinct outcome, clear writable ownership, and independently checkable completion. Combine small or tightly coupled changes; avoid arbitrary file-count or token thresholds.
- The scheduler launches dependency-ready tasks up to a positive configured concurrency limit. Concurrency one uses the same execution path.
- Prerequisites refer to accepted tasks: submission alone never unlocks descendants.
- Concurrent tasks own disjoint writable paths and use task-local test resources. Unavoidable shared-resource contention is serialized through explicit dependencies with a rationale. Ownership derives from file-change entries rather than a duplicated path list.
- Each task gets one continuous native writer run in a separate worktree. Tests-first work and production remain within that run.
- The orchestrator independently validates receipts, scope, evidence, task checks, and affected integration checks before acceptance.
- Independent branches continue after a failure; descendants block and the overall run remains incomplete.
- Preserve caller dirt, existing production-approval requirements, scoped repair limits, and read-only provider boundaries.

Non-goals: parallel design-increment delivery, token-overhead measurement, global or frontier RED barriers, paused-agent retention, cross-task shared-file editing, and a driver state for every development action.

## Architecture & Boundaries

### Plan contract

Under `## Proposed Changes`, each H3 identifies a task, for example `### T1 — Define the shared contract`. Its opening prose explains the user-facing outcome and rationale. Structured metadata identifies prerequisites and acceptance criterion IDs. Existing `[NEW]`, `[MODIFY]`, `[DELETE]`, and `[GENERATED]` H4 entries remain the authoritative file-change detail.

The parser produces tasks alongside the derived aggregate change list used by existing approval and scope consumers. Validate unique IDs, known prerequisites, acyclicity, complete criterion mapping, unambiguous path ownership, and a non-empty, non-placeholder outcome summary under every task heading. Reuse the existing placeholder and filler-note validation rather than introducing a second vocabulary. The plan-review prompt explicitly requires inspecting semantic dependencies, ownership boundaries, and claimed independence against producer/consumer interfaces. A cross-task criterion belongs to integration verification rather than forcing duplicate file ownership. If two changes must edit the same file, combine them into one task. Shared interfaces settle in a prerequisite task before consumers become ready.

Every `[GENERATED]` entry belongs to a task and declares its generator command and input paths. If inputs are produced by other tasks, the generating task depends on every input-producing task, directly or transitively. Parser validation rejects ownerless generated entries, unknown input producers, and missing prerequisite coverage. Shared generated outputs use an ordinary generating task; no integration-owned file section or second ownership model is introduced. Required final regeneration runs the same mapped command against the accumulated result without transferring ownership.

A compact human execution summary is derived from the graph. Explicit pairwise parallel lists and fixed execution waves are unnecessary. Dependencies express required outputs or necessary serialization; the task prose explains the reason for each non-obvious dependency. There is no resource metadata or resource-lock subsystem.

### Scheduler and writer boundary

Use a small durable task lifecycle: pending, running, submitted, accepted, or failed. Derive readiness and dependency blocking from the graph instead of storing redundant scheduler states. A writer-reported blocker retains its existing receipt classification and reason; it cannot become acceptance. Persist task identity, attempt, governed plan hash, input baseline, worktree location, writer handle, receipt location, accepted result revision, integration progress and integrated revision, and final delivery/transfer progress and evidence. Recovery reconciles these records with actual checkout and caller state before applying or transferring anything again. Operational effect progress may require journal records without becoming writer-development phases.

Schedule ready tasks deterministically, using plan order to break ties. Bound active writers by the configured cap; the validated graph serializes unavoidable shared-resource conflicts. Retain each launch handle and wait for completion or material blockers using the repository's event-driven waiting contract. Independent tasks continue while a failed branch remains blocked; there is no unbounded automatic retry.

Each brief supplies the overall goal, compact graph, task-owned file details, relevant contracts, prerequisite result revisions, downstream expectations, acceptance checks, repository rules, production-approval requirements, applicable prior concerns and recorded decisions, the expected receipt location and schema, and the full plan path and hash. Reading the full plan grants context, not additional write authority.

The writer follows a prose development loop: inspect, author discriminating tests where applicable, establish and record RED, implement, verify, and submit. Existing evidence classes and approved exceptions remain applicable. The driver does not pause the writer between RED and production.

The concurrency cap applies to active writer invocations; stopped/submitted writers release their slots. Retained worktrees do not consume writer slots. Serial acceptance may proceed while unrelated writers run; it neither starts another writer nor mutates their baselines. One writer means one continuous invocation per normal task attempt, not an obligation to retain an agent forever through failures. Repair/retry starts only through existing bounded policy.

Use the configured native writer selection for every task; add no task-specific model routing or adaptive concurrency policy. The implementation plan must choose one cap configuration in the existing configuration system, validate it before launches, and respect actual native capacity. Capability failure is an explicit diagnostic, never a silent shared-checkout fallback.

### Worktree inputs and evidence

Create a task worktree when the task becomes ready, from a recorded integrated revision containing accepted prerequisites. Supply the governed plan and brief as read-only context outside the writable task scope; scratch artifacts need not be present in Git history.

Existing caller changes must be represented faithfully in the execution input without committing or modifying the caller's checkout. Use a private captured baseline with an explicit manifest and validation; if the host cannot reproduce required local inputs, report a blocker rather than silently dropping them. Required untracked inputs, including source and configuration files, required ignored configuration, and dependency availability must be resolved before launch. Reuse available host tooling; introduce no external dependency through this design.

RED receipts must identify the test revision or reproducible test-only patch, command, selected criteria/tests, failure classification, and log path. Independent validation must distinguish intended behavioral failures from missing imports, setup failures, or zero selected tests. A failure log alone is insufficient proof. Production receipts bind the immutable submitted revision, owned diff, verification logs, concerns, and prerequisite baseline.

Prefer one immutable test-only checkpoint against the task input and one final result checkpoint. They are private execution artifacts, not requests to commit changes in the caller branch. Reproduce the RED check through the existing verification machinery in a disposable validation checkout, then verify the submitted GREEN result. The RED checkpoint may change only authorized test/fixture paths; setup-only failures cannot substitute for behavioral RED. Approved exceptions remain explicit. Receipts reference logs outside model context and carry concise evidence, avoiding a second test-author agent or an entire action transcript.

### Acceptance and integration

Stop task mutation before orchestrator checks. Verify the actual worktree diff and immutable submitted revision against the recorded baseline and owned paths; validate receipt identity and actual scoped command results. Evidence claims never substitute for checks.

Integrate accepted candidates serially into a private accumulated integration checkout, preserving caller state. Verify affected contracts against the accumulated result, not only the original task baseline. Integration conflicts or check failures prevent acceptance and descendant release. Record the candidate revision before integration and publish it as accepted only after checks pass; a failed integration must leave the previous accepted baseline recoverable.

Generated shared artifacts run through their owning task after their declared input producers are accepted. Required final regeneration uses that task's mapped command in the integration checkout; outputs retain their task ownership and post-mutation evidence requirements. Run required aggregate gates and code review against the final accumulated result. Final delivery transfers only verified task-owned changes to the caller checkout after checking for intervening caller edits; conflicting drift blocks transfer rather than overwriting it. Overall completion requires every task accepted and every final criterion evidenced.

A task started on an older accepted baseline need not restart merely because an independent task was integrated meanwhile. Admit only its task delta and verify it against the latest accumulated result. Input baseline validity and prerequisite revisions remain required. Never accept a task's entire checkout as a replacement for the integration tree.

Evidence is revision-bound: task checks establish the submitted result; integration checks establish the accumulated revision they inspected. Later integration can stale cross-task evidence. Final gates must cover the final accumulated result, and repaired inputs invalidate dependent results as required. A task acceptance is not a permanent assertion that every future combination is correct.

Use existing final code-review and fix behavior rather than a separate mandatory review wave for every task. Review/fix operations run against the integration checkout and stay within approved scope. Repair that changes accepted task inputs must reconcile acceptance and affected descendants before further release. Run post-mutation verification, retain the resulting integrated revision, then deliver. The final caller diff is relative to the captured caller baseline and excludes pre-existing caller dirt.

### Failure, recovery, and revision

Persist sufficient identity to reconnect to live writers and reuse completed receipts after interruption. Recovery reconciles actual handles, worktrees, revisions, and integration progress before launching anything again. Interrupted integration must be safely resumable without applying a result twice.

A failed task blocks descendants; unaffected branches may proceed. Scoped repair uses the existing bounded failure policy. Changes to ownership, prerequisites, criteria, or governed plan invalidate affected task results and descendants; preserve unaffected evidence only when its inputs remain valid. Preserve task artifacts for unresolved failures; clean up only disposable run-owned worktrees after verified delivery or explicit disposition.

Continue-independent-branches applies to local task failures. A corrupted journal, invalid governed plan, broken isolation, unusable baseline, or unsafe integration/delivery state is a run-level blocker: stop new launches and retain evidence. Reconcile or stop existing handles explicitly; never delete a worktree with a live writer. When no runnable work remains, emit one consolidated failure/blocker decision rather than waiting indefinitely or asking once per descendant.

Plan revisions occur at a quiescent coordination boundary. Collect completed results or explicitly stop live writers before replacing their governing inputs. Previously approved production scope remains binding; expanding scope follows existing approval rules. User cancellation similarly stops launches, resolves live handles, and preserves recovery artifacts.

### Complexity budget

The user approved these simplifications; they are implementation requirements:

- Reuse existing journals, effects, verification, approval, review, and configuration mechanisms; add no independent scheduler service, queue database, or generic distributed workflow framework.
- Derive ownership from file entries, ready/blocked status from graph/results, and human scheduling summaries from the same graph. Store evidence and identity, not redundant facts.
- Use task-local ports, caches, and generated outputs. Express unavoidable resource conflicts as serialization dependencies with a rationale. Omit resource metadata and a reusable resource-lock registry. New evidence that this is insufficient reopens the design rather than silently expanding implementation scope.
- Require an explicit integration mapping for cross-task criteria. Keep `[FINAL]` and evidence-class semantics single-sourced, rather than inventing task-specific variants.
- Keep all scopes on the task graph, even a one-task plan. Use the same isolation/acceptance behavior at cap one, avoiding a shared-checkout fast path with separate recovery semantics.
- Preserve meaningful task granularity as a planning judgment. No automatic task-size estimator, token accounting, priority optimizer, or worktree pool.

Worktree preparation, immutable RED replay, serialized integration, and safe final delivery remain real costs. They earn their place by making writer claims independently checkable and preserving caller state. If implementation requires significantly more machinery than these boundaries imply, reopen that trade-off before expanding the design.

### Acceptance scenarios

| Scenario | Required observable result |
| --- | --- |
| Small coherent plan | One task uses the same execution path; no forced fragmentation. |
| Contract task followed by independent consumers | Consumers launch only after verified integration of the contract; run together within the cap. |
| Ready tasks exceed capacity | Deterministic plan-order admission; no oversubscription. |
| Different files with a semantic dependency | Plan records the dependency; review rejects a false independence claim. |
| Same-file edits or shared output conflict | Combine ownership or serialize the resource use; concurrent writers do not race. |
| Missing, fabricated, or setup-only RED | Task is not accepted; descendants remain blocked. |
| Valid RED and GREEN task | Independent checks bind both checkpoints; integration checks bind the accepted revision. |
| Independent result submitted from an older baseline | Integrate only its owned delta and verify current interactions; no automatic full restart. |
| Writer scope violation or unresolved concern | Existing admission/ruling policy applies; no automatic acceptance. |
| One task fails | Unaffected branches proceed; descendants block; run cannot report completion. |
| Restart during launch or integration | Reconcile retained identities; no duplicate writer or double-applied result. |
| Caller edits during execution | Preserve them; conflicting final transfer blocks and reports drift. |
| Interrupted final delivery | Recovery determines transferred state before resuming; partial transfer is not completion. |
| Final review applies a fix | Verify after the fix and reconcile affected evidence before delivery. |

## Alternatives & Decisions

- Dependency graph with bounded concurrency (user): chosen over fixed waves and manually listed parallel groups; avoids waiting for unrelated slow tasks and duplicated scheduling declarations.
- Meaningful task writers with separate worktrees (user): isolation, stable checks, attribution, and recovery justify integration cost. Shared-checkout concurrency complicates snapshot attribution and permits changing test inputs during checks.
- Focused brief with full governed plan access (user): retain interaction context without loading every task detail into initial context.
- One continuous writer per task (user): replace the earlier two-writer and pause/resume proposals; repeated bootstrap and harness-resumption machinery do not earn their cost.
- Per-task tests-first, checked at acceptance (user): supersedes the previously discussed frontier barrier. Gives up independent pre-production RED approval while preserving independently validated evidence before acceptance. Global and frontier barriers add waiting and speculative downstream test setup.
- Hybrid coordination (user): prose owns the native reasoning loop; deterministic driver gates own eligibility, ownership, concurrency, verification, integration, and release. All-prose scheduling is unreliable; hardcoding every writer phase expands the recovery protocol.
- Continue independent branches on failure (user): descendants remain blocked and completion remains false.
- No token-measurement subsystem (user): record qualitative trade-offs; no unsupported percentage estimates.
- Serial and parallel execution share one path: cap one is serial execution, avoiding separate orchestration implementations.
- Minimal coordination (user): derive readiness, blocking, ownership, and execution summaries from their authoritative inputs; reuse existing journal, verification, approval, and final review mechanisms. Use task-local resources or serialization dependencies instead of resource locks. Retain one writer-selection policy and omit per-task review waves, adaptive scheduling, and token instrumentation.
- Current task format replaces component-only grouping for new authoring. Existing run journals are not silently migrated; older artifacts require an explicit reauthor/restart diagnostic when the new contract cannot be satisfied.

Implementation planning must resolve exact metadata syntax, concurrency configuration location/default, baseline capture mechanics, native writer handle capabilities, and receipt schema changes against existing infrastructure. These choices must preserve the invariants above and avoid adding optional scheduling modes.

Consideration record: task writers improve context focus; worktrees provide isolation rather than additional context hygiene. Setup, RED replay, and integration consume tokens/time; reduced unrelated exploration and rework may offset them, with no measured estimate. Initial two-writer-per-task and later same-writer pause/resume approaches were rejected because repeated bootstrap or retention/rebasing machinery adds cost. The initially preferred frontier RED barrier was explicitly superseded by the simpler continuous-writer recommendation. Prose handles development judgment; driver gates protect verifiable coordination. The authoritative decisions are the final choices, not every intermediate proposal.

Task IDs inside an implementation plan are distinct from design increment IDs. The existing design orchestrator still delivers increments in its current order; bounded concurrency operates within each increment's plan. The three increments below are a provisional delivery breakdown, not the task graph for every future host project and not a promise to execute this repository change in parallel.

## Risks, Security & Operations

Worktrees do not themselves enforce file-write permissions. Native writer scope remains explicit, and actual diff admission detects violations; provider runners retain read-only invocation. Reject path escapes and ownership aliases according to the existing path policy, including filesystem case behavior.

Task commands may contend for ports, caches, or shared output directories despite disjoint code paths. Use task-local resources or explicit serialization dependencies. Serialization adds ordering and can block a later task if the earlier one fails; accept that conservative behavior rather than introduce separate lock and failure semantics. Integration is serialized. Do not run Git writes in the caller checkout concurrently with delivery.

Token savings are unmeasured. Repeated task setup and integration add overhead; focused contexts and less rework may offset it. Meaningful task granularity and disclosed references are the chosen controls.

The most complex retained area is preserving dirty inputs and performing recoverable integration. Implement this as an explicit baseline/result boundary, not ad hoc merges or caller stashes. Unsupported input reproduction must fail before writers launch. Existing journals retain their protocol interpretation; never replay old writer events through changed semantics without validation.

## Increment Dependency Graph

| ID | Priority | Summary | Prerequisites | Paths |
| --- | ---: | --- | --- | --- |
| I01 | 1 | Define task plans and focused writer inputs | none | skills/dispatch/references/templates/plan.md, skills/dispatch/references/templates/review-prompt-plan.md, skills/dispatch/scripts/domain/plan.ts, skills/dispatch/scripts/domain/types.ts, tests/unit/domain/plan.test.ts, tests/unit/domain/templates.test.ts |
| I02 | 2 | Execute isolated task writers through bounded scheduling and verified integration | I01 | skills/dispatch/scripts/dispatch.ts, skills/dispatch/scripts/core/, skills/dispatch/scripts/effects/, skills/dispatch/scripts/machines/, skills/dispatch/scripts/domain/execution-config.ts, skills/dispatch/scripts/lib/config.ts, skills/dispatch/scripts/lib/platform.ts, skills/dispatch/scripts/lib/session.ts, skills/dispatch/scripts/policy/hotfix.ts, skills/dispatch/config.sample.jsonc, skills/dispatch/SKILL.md, skills/dispatch/references/templates/write-brief*.md, tests/integration/skill-contract.test.ts, tests/unit/core/, tests/unit/machines/, tests/unit/domain/templates.test.ts, tests/unit/policy/hotfix.test.ts, tests/unit/lib/config.test.ts, tests/unit/lib/session.test.ts, tests/unit/lib/platform.test.ts, tests/e2e/ |
| I03 | 3 | Align contracts and prove recovery and delivery end to end | I02 | skills/dispatch/SKILL.md, skills/dispatch/README.md, skills/dispatch/references/verbs/plan.md, skills/dispatch/references/verbs/implement.md, skills/dispatch/references/readme/, tests/integration/, tests/unit/domain/templates.test.ts, tests/unit/policy/hotfix.test.ts, tests/e2e/ |

## Increment Details

### I01
- Outcome: Authors generate task summaries followed by file details; malformed graphs and ownership are rejected.
- Scope: Task model, parser/lint, task criterion mapping, execution-summary derivation, brief-selection contract, and semantic dependency/independence inspection in the plan-review prompt.
- Non-scope: Concurrent writer launches.
- Observable behavior: Plan defects identify unknown dependencies, cycles, duplicate ownership, missing acceptance mappings, or empty/placeholder task summaries.
- Affected contracts: ParsedPlan and plan template.
- Validation: Behavioral parser tests cover valid dependency graphs and each rejected condition; strict typecheck and repository gates pass.
- Rollback boundary: Restore the former plan contract before any task-based execution journal exists.
- Parallel safety: Unsafe beside I02 because scheduler inputs depend on this contract.

### I02
- Outcome: Ready tasks execute in isolated worktrees with bounded concurrency, verified receipts, and serialized integration.
- Scope: Single-run writer lifecycle, checkout-aware effect wiring, task-addressed host events and frames, bounded launch/result coordination, concurrency configuration and schema, baseline capture, worktree preparation, scoped receipt admission, RED validation, integration, hotfix/recovery alignment, failure propagation, and replay-safe task records. Directory ownership admits new task-specific helpers; implementation plans enumerate concrete files and remain limited to these outcomes.
- Non-scope: Parallel design increments and optional frontier barriers.
- Observable behavior: Dependents start only after acceptance; failed branches block descendants while unrelated work continues; cap one follows the same path.
- Affected contracts: Host write frames, writer receipts, effects, implementation context, configuration, and recovery identity.
- Validation: Deterministic scheduler/protocol tests exercise ordering, cap, serialization dependencies, receipt rejection, integration failure, and interruption without duplicate launches or integration. Run npm test, including strict typecheck and integrity gates; run npm run hashes when hash drift is reported, then rerun the gates; run git diff --check. Keep runtime contracts, agent-facing await/event instructions, and their guards aligned within I02. Extend existing e2e files within the cap.
- Rollback boundary: Restore prior execution with explicit rejection of incompatible new journals; preserve task worktrees and evidence.
- Parallel safety: Unsafe beside I01 or I03 because execution and instruction contracts are shared.

### I03
- Outcome: Agent instructions, human documentation, and end-to-end evidence agree with the new execution contract.
- Scope: Owning references and templates, human invocation/configuration/concept documentation, affected tests and integration contract guards, hashes, portability and caller-state preservation checks; implementation planning enumerates concrete files within declared ownership. Extend existing e2e files within the repository cap by default; any justified cap change is an explicit owned edit to tests/integration/e2e-cap.test.ts, not an implicit weakening of a gate.
- Non-scope: Unrelated cleanup or token instrumentation.
- Observable behavior: Users can read task summaries, observe bounded task progress, recover failures, and receive verified integrated changes without losing caller edits.
- Affected contracts: Agent-facing writing instructions, public invocation/configuration documentation, completion and handoff evidence.
- Validation: Git/subprocess tests in tests/e2e cover dirty baselines, dependent input transfer, concurrent independent writers, missing/false RED evidence, integration conflict, recovery, and final transfer drift. Run npm test, npm run hashes when required, and git diff --check.
- Rollback boundary: Revert aligned documentation and test changes together with their runtime contract.
- Parallel safety: Strictly sequential after I02 acceptance. I03 extends shared test files only after I02 finishes; there are no concurrent edits to overlapping directories. Rollback proceeds in reverse increment order, preserving the I02 accepted baseline and recovery evidence when reverting I03 alignment.

## Final Integration

Demonstrate a prerequisite contract task, two independent dependent tasks, and a final cross-task criterion. Prove bounded concurrent execution, immutable task checking, serialized integration, and delayed descendant release. Repeat with one failed branch and an interruption, preserving unaffected results and caller dirt. Exercise concurrency one through the same scheduler. Verify tests-first evidence discriminates behavioral failure and reject setup-only failures. Run the required repository suite and integrity checks. Cross-platform claims require corresponding evidence; report untested hosts explicitly.

## Execution Status

Not started. This specification is awaiting written-spec review; no implementation is authorized by its existence.

Next Action: implement:I01

## Review Findings & Resolutions

### Round 1 — full

- Reviewers: opencode[1] opencode-go/deepseek-v4.1-flash (high), agy[0] gemini-3.7-flash (medium), opencode[0] opencode-go/muse-spark-1.3-contributor (xhigh)
- Failed: claude[0] (cli-outdated: claude exit 1: API Error: 400 Claude Code 2.1.268 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.)
- **[Fixed]** [R1-F001] [SHOULD] [sources=opencode[1]] § Increment Dependency Graph — dependency-graph: I02 promises isolated task worktrees, bounded concurrent writers, RED replay in a disposable checkout, serialized integration, and recoverable final delivery, but its Paths cover only machines/implement.ts, machines/implement-types.ts, core/types.ts, effects/write-brief.ts, effects/check-envelope.ts, and the three write-brief templates. Those behaviors depend on the runtime/effect layer, which binds one fixed checkout and one outstanding effect: createHandlers closes over deps.cwd (skills/dispatch/scripts/effects/index.ts:52) sourced from cwd: repo (skills/dispatch/scripts/dispatch.ts:111); each worktree-sensitive handler captures its own cwd (skills/dispatch/scripts/effects/snapshot.ts:10, skills/dispatch/scripts/effects/restore.ts:7, skills/dispatch/scripts/effects/check-envelope.ts:9, skills/dispatch/scripts/effects/verify.ts:11, skills/dispatch/scripts/effects/prepare-review.ts:60); the interpreter runs only the queue head (skills/dispatch/scripts/core/interpreter.ts:300-307) and rejects a host event while any effect is pending (skills/dispatch/scripts/core/interpreter.ts:190-191), so multiple simultaneous writer awaits/frames are impossible; and the root machine tracks a single child (skills/dispatch/scripts/machines/root.ts, last/awaitOf). The cap configuration is likewise unowned: the design mandates one cap in the existing configuration system (L55) but no increment lists skills/dispatch/scripts/lib/config.ts, skills/dispatch/config.sample.jsonc, or its tests, and validateConfig is a closed schema (skills/dispatch/scripts/lib/config.ts:13, skills/dispatch/scripts/lib/config.ts:221-237). Increment path ownership is enforced by validateDesignTraceability (skills/dispatch/scripts/domain/plan.ts:585), so an I02 plan that edits these files is rejected as outside increment scope; the changed writer lifecycle also leaves the hotfix surface (write-brief-hotfix.md, policy/hotfix.ts) unowned. → Verified path admission constrains increment plans; required checkout-aware runtime handlers and closed config schema are absent from I02 ownership.
- **[Fixed]** [R1-F002] [SHOULD] [sources=opencode[1]] § Plan contract — architecture: L73 states that generated shared artifacts run through their owning task or the integration stage with explicit ownership, matching ADR §7 (docs/decisions/0008-task-based-plans-and-bounded-parallel-writers.md:L115), but the plan contract makes each task's H4 file entries the sole ownership source (L37-L39) and validates unambiguous path ownership. No representation is defined for an integration-stage-owned [GENERATED] entry or for its mapped inputs, so a generated artifact whose inputs span several tasks has no valid owner: under a task it is task-owned and its generator runs without the other tasks' inputs, while outside any task the ownership validation has nothing to bind it to. → Every file needs one task owner. Define shared generated outputs as task-owned with prerequisites covering all input producers, avoiding a second ownership representation.
- **[Needs User]** [R1-F003] [SHOULD] [sources=opencode[1]] § Scheduler and writer boundary — intent: The brief contract enumerates what each brief supplies (L49) but omits the expected receipt location and schema, which ADR §4 requires the brief to contain (docs/decisions/0008-task-based-plans-and-bounded-parallel-writers.md:L69), and omits production-approval requirements and applicable concerns/recorded decisions (docs/decisions/0008-task-based-plans-and-bounded-parallel-writers.md:L67). Because task submission is a claim whose acceptance depends on the receipt (L45, L63), a brief that does not guarantee the receipt path/schema can leave the writer unable to produce an admissible receipt; dropping prior concerns also removes the carrier that constrains a task. → user: Do it — apply the proposed writer-brief alignment with ADR 0008, including expected receipt path/schema, production approval, and applicable concerns/recorded decisions.

### Round 2 — full

- Reviewers: opencode[1] opencode-go/deepseek-v4.1-flash (high), agy[0] gemini-3.7-flash (medium), opencode[0] opencode-go/muse-spark-1.3-contributor (xhigh)
- Failed: claude[0] (cli-outdated: claude exit 1: API Error: 400 Claude Code 2.1.268 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.)
- **[Fixed]** [R2-F001] [MUST] [sources=opencode[1]] § Increment Dependency Graph — testability: I03's Paths cell ends with tests/e2e (no trailing slash) while its Scope, Observable behavior, and Validation require git/subprocess tests under tests/e2e. incrementPathMatches treats a pattern without a trailing slash as an exact match (skills/dispatch/scripts/domain/plan.ts:558), so tests/e2e/<file> does not match tests/e2e; validateDesignTraceability rejects every plan change outside the increment's paths (skills/dispatch/scripts/domain/plan.ts:585). I02 owns tests/e2e/ (Increment Dependency Graph, I02 row), so I03 cannot add or update the e2e files its own validation and observable behavior depend on. → Verified contract/scope gap; align spec with required delivery and ADR boundaries.
- **[Fixed]** [R2-F002] [SHOULD] [sources=opencode[1]] § Increment Details — integration: I03 promises additional git/subprocess e2e coverage, but tests/e2e/ already holds the cap of four files (tests/integration/e2e-cap.test.ts:6, E2E_CAP = 4) and the cap declaration lives in tests/integration/, which no increment owns. A new e2e file fails tests/integration/e2e-cap.test.ts:15, and no increment's paths permit editing it to raise E2E_CAP. The same unowned directory holds contract tests (tests/integration/skill-contract.test.ts:13,57) that assert the exact await set, documented events, SKILL.md word budget, and config terms the design changes. → Verified contract/scope gap; align spec with required delivery and ADR boundaries.
- **[Fixed]** [R2-F003] [SHOULD] [sources=opencode[1]] § Increment Details — scope: I03's Outcome requires human documentation to agree with the new execution contract, and the design adds a concurrency configuration control that skills/dispatch/references/readme/configuration.md:3 documents, but no increment lists skills/dispatch/README.md, skills/dispatch/references/readme/configuration.md, concepts.md, or verbs.md in its Paths. validateDesignTraceability rejects changes outside increment paths (skills/dispatch/scripts/domain/plan.ts:585), so the promised human-documentation alignment cannot be authored. → Verified contract/scope gap; align spec with required delivery and ADR boundaries.
- **[Fixed]** [R2-F004] [SHOULD] [sources=opencode[1]] § Acceptance scenarios — testability: The scenario Different files with a semantic dependency | Plan records the dependency; review rejects a false independence claim relies on plan review to catch semantic dependencies and false independence, but the plan review prompt block (skills/dispatch/references/templates/review-prompt-plan.md) has no instruction to inspect task prerequisites, ownership, or independence claims, and no increment owns that template. Deterministic parser validation cannot detect semantic dependency (no resource/interface metadata exists), so the stated observable result has no owned carrier. → Verified contract/scope gap; align spec with required delivery and ADR boundaries.
- **[Rejected]** [R2-F005] [CONSIDER] [sources=opencode[1]] § Increment Details — dependency-graph: I02 owns skills/dispatch/scripts/policy/hotfix.ts and skills/dispatch/references/templates/write-brief*.md but none of their unit tests (tests/unit/policy/hotfix.test.ts, tests/unit/domain/templates.test.ts). If I02 changes those files' semantics, the paired tests fail and cannot be updated within I02's scope (skills/dispatch/scripts/domain/plan.ts:585), unlike the lib sources that I02 pairs with their tests in its Paths. → Conditional suggestion does not demonstrate changed hotfix/template semantics or failing tests. I03 owns affected-test alignment; its scope will explicitly cover these paired tests as part of required test/document alignment. No separate I02 test-semantic change is established.
- **[Fixed]** [R2-F006] [MUST] [sources=opencode[0]] § Increment Dependency Graph — dependency-graph: I03 Paths lists "tests/e2e" without trailing slash, so incrementPathMatches treats it as an exact-file match and rejects any plan change under tests/e2e/*.test.ts as outside increment scope: skills/dispatch/scripts/domain/plan.ts:L558 requires a trailing '/' for prefix ownership and skills/dispatch/scripts/domain/plan.ts:L585 rejects non-matching paths. I03 Validation requires Git/subprocess tests in tests/e2e, so I03 cannot deliver its promised e2e evidence. → Duplicate of R2-F001; same path correction resolves both.
- **[Fixed]** [R2-F007] [SHOULD] [sources=opencode[0]] § Increment Dependency Graph — parallel-safety: After the slash fix, I02 ("tests/e2e/") and I03 ("tests/e2e/") both claim the whole e2e directory with overlapping directory ownership. I03 Parallel safety permits documentation work to be drafted separately after I02 contracts settle, which risks file collisions in the shared directory and makes the I02 rollback (preserve worktrees/evidence) versus I03 rollback (revert docs and tests together with runtime) ambiguous for the same files. → Verified contract/scope gap; align spec with required delivery and ADR boundaries.
- **[Fixed]** [R2-F008] [SHOULD] [sources=opencode[0]] § Architecture & Boundaries — correctness: Worktree inputs requires resolving "Required ignored configuration and dependency availability" but omits untracked files required by ADR §6 (docs/decisions/0008-task-based-plans-and-bounded-parallel-writers.md:L93: "untracked or ignored"). An untracked source or config file needed for the build could be silently dropped from the private captured baseline, launching the writer with incomplete inputs despite manifest validation. → Verified contract/scope gap; align spec with required delivery and ADR boundaries.
- **[Fixed]** [R2-F009] [SHOULD] [sources=opencode[0]] § Architecture & Boundaries — operations: Scheduler and writer boundary persists task identity, attempt, governed plan hash, input baseline, worktree location, writer handle, receipt location, and accepted result revision, but omits the integration/delivery progress required by ADR §9 (docs/decisions/0008-task-based-plans-and-bounded-parallel-writers.md:L135). Without durable integration progress and transfer evidence, interrupted integration risks double application and interrupted final delivery cannot reliably determine transferred state before resuming. → Verified contract/scope gap; align spec with required delivery and ADR boundaries.

### Round 3 — delta

- Reviewers: opencode[1] opencode-go/deepseek-v4.1-flash (high), agy[0] gemini-3.7-flash (medium), opencode[0] opencode-go/muse-spark-1.3-contributor (xhigh)
- Failed: claude[0] (cli-outdated: claude exit 1: API Error: 400 Claude Code 2.1.268 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.)
- **[Fixed]** [R3-F001] [SHOULD] [sources=opencode[1]] § Increment Dependency Graph — dependency-graph: I02 owns the runtime contracts it changes (skills/dispatch/scripts/core/validate.ts AWAIT_ACCEPTS, core/frame.ts host events, lib/config.ts schema), but the guard that binds those contracts to agent-facing docs lives in tests/integration/skill-contract.test.ts (it imports AWAIT_ACCEPTS at tests/integration/skill-contract.test.ts:6 and asserts each await documents exactly its accepted events plus the SKILL.md word budget at :13-18) and in skills/dispatch/SKILL.md — both assigned to I03, which the graph places after I02. I02's Scope and Affected contracts name 'task-addressed host events and frames' and 'Host write frames'. If I02 adds or changes an accepted host event or await kind, the guard fails during I02, while I02's paths exclude tests/integration/ and SKILL.md, so I02 cannot reach a green repository or be accepted independently. → Verified missing explicit contract/validation coverage; correct within the design.
- **[Fixed]** [R3-F002] [SHOULD] [sources=opencode[1]] § Increment Details (I02) — standards: AGENTS.md requires 'Run npm test before completing any edit task; when it reports hash drift, run npm run hashes'. I01's Validation lists 'strict typecheck and repository gates pass' and I03's lists 'Run npm test, npm run hashes when required, and git diff --check', but I02's Validation only requires 'Deterministic scheduler/protocol tests'. I02 changes shared engine contracts (skills/dispatch/scripts/core/, effects/, machines/, lib/config.ts), so a plan authored to I02 can be accepted with the repository suite and integrity/hash gates never verified, unlike its sibling increments. → Verified missing explicit contract/validation coverage; correct within the design.
- **[Fixed]** [R3-F003] [SHOULD] [sources=opencode[1]] § Architecture & Boundaries — Plan contract — correctness: ADR 0008 §2 (docs/decisions/0008-task-based-plans-and-bounded-parallel-writers.md:L41) requires plan validation to cover 'meaningful task descriptions', but the Plan contract enumerates only 'unique IDs, known prerequisites, acyclicity, complete criterion mapping, and unambiguous path ownership' (L39), and I01's Observable behavior lists only 'unknown dependencies, cycles, duplicate ownership, or missing acceptance mappings' (L169). A task H3 with an empty or placeholder outcome summary therefore passes structural validation, so the human-readable task summary the goals depend on (L21, L37) is not enforced against the repository's own placeholder/filler lints. → Verified missing explicit contract/validation coverage; correct within the design.
- **[Rejected]** [R3-F004] [CONSIDER] [sources=opencode[1]] § Increment Dependency Graph — integration: I02 owns tests/e2e/ but not the e2e cap declaration tests/integration/e2e-cap.test.ts, and tests/e2e/ is already at its cap of four files (tests/integration/e2e-cap.test.ts:4-6). If I02 requires a new end-to-end file for its worktree-preparation and serialized-integration behavior (ADR 'Acceptance boundaries' assigns git/worktree/subprocess scenarios to end-to-end tests), it cannot add one: checkE2eCap fails and I02's paths exclude the file that could raise E2E_CAP. The design does not state that I02 extends the existing tests/e2e files only. → No need for a new e2e file is demonstrated. Existing e2e files can cover these scenarios; repository gates and test-cap rules govern every increment. No implicit cap increase is authorized.
