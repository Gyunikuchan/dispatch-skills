# ADR 0008: Task-based plans and bounded parallel writers

- **Status**: Accepted; implementation pending
- **Date**: 2026-10-02
- **Audience**: Maintainers

## Context

Dispatch plans serve two audiences. People need to understand the outcome and interactions of each piece of work. Native writers need concrete changes, clear authority, relevant context, and independently checkable completion criteria.

Parallel development is useful when substantial tasks have stable boundaries. Safe coordination requires explicit dependencies, attributable mutations, reproducible evidence, and verified integration. Additional agents and coordination also consume time and tokens. The architecture therefore prioritizes correctness, then token efficiency, then speed, while keeping coordination small enough to reason about and recover reliably.

## Decision

Dispatch represents implementation work as a dependency graph of meaningful tasks. A bounded scheduler runs ready tasks through native writers in separate worktrees. Each writer executes its tests-first development loop continuously, guided by prose. Deterministic driver gates control launch eligibility, scope, evidence admission, integration, and dependent release.

The same architecture executes one task or many, with concurrency one providing serial execution. Task submission is a claim; acceptance requires independent verification of the task and its integrated result.

### 1. Meaningful task boundaries

A task has one coherent outcome, clear writable ownership, and independently checkable completion. Its size justifies a dedicated writer's orientation and integration cost. Task granularity is a planning judgment rather than a file-count, token, or duration threshold.

Combine small or tightly coupled changes. Group changes to a shared file under one owner. Separate substantial independent outcomes when their interfaces are settled and their completion can be checked separately. A plan may contain one task; parallelism is an opportunity, not a decomposition quota.

Task IDs belong to an implementation plan. Design increments remain a separate delivery boundary: task concurrency operates within the active increment's plan and does not imply concurrent design-increment delivery.

### 2. Human-readable plans with precise ownership

Under `Proposed Changes`, each task has:

- A stable ID and descriptive title.
- A plain-language summary of its outcome and rationale.
- Prerequisite task IDs, with reasons for non-obvious dependencies.
- Acceptance criterion references and scoped verification.
- Detailed file-by-file changes, including concrete symbols, interfaces, behavior, invariants, and rationale as appropriate.

Task headings group the file changes. File entries use `[NEW]`, `[MODIFY]`, `[DELETE]`, or `[GENERATED]` actions and portable workspace-relative paths. Those entries are the authoritative writable ownership; a separate manually maintained ownership list is unnecessary. Aggregate change scope and task briefs derive from them.

The plan includes a compact execution summary derived from its graph. It explains which tasks depend on which outcomes and which branches can proceed independently. Parallel eligibility is derived rather than maintained as pairwise lists or fixed waves.

Plan validation requires unique task IDs, known prerequisites, an acyclic graph, unambiguous ownership, meaningful task descriptions, and complete acceptance mapping. Deterministic validation establishes structural correctness; plan review verifies semantic dependencies and claims of independence.

Different writable files alone do not establish independence. A consumer may depend on an interface owned by another task. Shared contracts belong in a prerequisite task; consumers become eligible only after that contract is accepted and integrated.

Every acceptance criterion has an explicit verification owner: a task or integration. Cross-task criteria belong to integration verification, with affected tasks identified. Evidence classes, exceptions, and final-command semantics have one operational definition; tasks do not introduce parallel variants of those rules.

### 3. Bounded graph scheduling

A task becomes ready when every prerequisite is accepted. The scheduler launches ready tasks up to a positive configured concurrency cap, using plan order to break ties. Readiness and dependency blocking derive from the graph and recorded results rather than being persisted as additional authoritative states.

The cap counts active writer invocations. Submitted or stopped writers release their slots; retained worktrees do not consume writer slots. Serial verification and integration can proceed while unrelated writers run, without mutating those writers' inputs.

The task lifecycle is limited to pending, running, submitted, accepted, and failed. Writer-reported blockers retain their receipt classification and reason; they do not become acceptance. Journal records may describe effect progress without encoding every development action as a driver phase.

Use one cap configuration in the dispatch configuration system and the configured native writer-selection policy. Scheduling has no per-task model routing, adaptive cap, priority optimizer, or automatic task-size estimator. Validate configuration and native capacity before launches. Unsupported isolation or launch capabilities produce an explicit diagnostic rather than silently selecting another execution mode.

Use task-local ports, caches, and generated outputs. Express unavoidable resource contention through serialization dependencies with a rationale. There is no resource metadata or resource-lock registry. This deliberately accepts conservative ordering: failure of an earlier serialization prerequisite blocks the later task, even when the dependency exists for resource safety rather than data flow.

### 4. Focused briefs with full-plan access

Each writer receives a focused brief containing:

- The overall goal and compact task graph.
- Its summary, detailed file changes, writable scope, and acceptance checks.
- Relevant shared contracts and accepted prerequisite revisions.
- What downstream tasks expect it to deliver.
- Repository rules, production approval, and applicable concerns or recorded decisions.
- The full governing plan's accessible path and hash.
- The expected receipt location and schema.

The writer reads the overview and its task first, consulting other task details when an interaction requires them. Access to the full plan provides context without expanding write authority. Shared scratch artifacts are made accessible as read-only context; they need not be committed into task history.

Concise briefs and receipts keep unrelated implementation detail and execution traces out of initial context. Logs and detailed evidence remain in session artifacts and are reached by pointer. Worktrees provide isolation; focused agent contexts provide context hygiene.

### 5. One continuous writer per task attempt

A normal task attempt uses one native writer invocation. Its prose contract directs it to inspect relevant code, author discriminating tests where applicable, establish RED evidence, implement, verify GREEN, and submit its result. The driver does not gate a pause between RED and production.

Applicable tests precede the production changes they exercise. Criteria using verification or review evidence follow their governing rules; behavior-preserving work does not acquire artificial failing tests. Exceptions remain explicit and subject to the approval contract.

The writer records an immutable test-only checkpoint against its input and an immutable final result checkpoint. RED evidence identifies the checkpoint, command, selected tests and criteria, observed failure, and log. The test-only checkpoint changes only authorized test or fixture paths. Private checkpoints are execution artifacts, not a request to create commits on the caller's branch.

The orchestrator reproduces applicable RED checks using a disposable validation checkout and verifies the submitted GREEN result. It rejects missing or fabricated evidence, zero selected tests, and setup failures presented as behavioral RED. Logs alone do not establish reproducibility or tests-first ordering. Approved exceptions remain checkable.

This puts independent RED validation at acceptance rather than before production. The writer may implement before its RED claim is independently checked, but invalid evidence prevents acceptance and dependent release. The architecture intentionally bears that trade-off to avoid additional test-author agents, collective barriers, and paused-agent retention.

Repair and retry remain bounded. One continuous invocation per normal attempt does not require keeping an agent alive indefinitely through failures. A replacement attempt receives the task's saved inputs, evidence, concerns, and failure reason.

### 6. Stable worktree inputs

Create a task worktree when it becomes ready, from a recorded integrated baseline containing accepted prerequisites. Give concurrent writers separate worktrees; each owns only its task's authorized paths.

Capture relevant caller working-tree state faithfully into a private execution baseline without changing the caller's branch, index, or files. Record and validate the input manifest. Resolve required untracked or ignored configuration and dependency availability before launch. Preserve unrelated scratch artifacts and local configuration; do not treat the caller's checkout as disposable.

If required inputs cannot be reproduced safely, block execution with an explicit reason. A clean Git revision is insufficient when task behavior depends on local changes. Reuse host tooling and dependency facilities without introducing an external runtime prerequisite through this decision.

A task worktree stays on its recorded baseline while its writer runs. Integrating an independent result does not trigger an automatic rebase or restart. Accepted prerequisite identities must remain valid, and later acceptance checks evaluate the task delta against the accumulated result.

Worktrees are not permission sandboxes. Native writers receive explicit scope; independent diff admission detects violations. Provider runners remain structurally read-only. Validate paths against escapes, symlinks, and filesystem-equivalent ownership aliases according to the platform path policy.

### 7. Independent acceptance and serial integration

The orchestrator can inspect and execute checks in a task worktree by selecting that checkout as the working directory. The writer must stop mutating it before verification, and the receipt must bind the immutable submitted revision, task and attempt identity, input baseline, owned diff, logs, and concerns.

Acceptance requires all of the following:

1. Validate receipt identity, governed plan binding, prerequisite inputs, and actual scope.
2. Independently validate applicable RED evidence and final task checks.
3. Integrate only the task-owned delta into a private accumulated integration checkout.
4. Verify the affected interactions against that accumulated result.
5. Record acceptance and the integrated revision, then release dependents.

Integration is serialized. A candidate is not accepted until its integration checks pass. Conflicts or failures retain the last accepted baseline and leave descendants blocked. A task's entire checkout never replaces the integration tree; independent changes already accepted must survive.

Generated artifacts have explicit ownership, either in a task or in the integration stage. Shared generators run where their mapped inputs are available, without concurrent ownership of their output paths.

Evidence is revision-bound. A task check establishes its submitted revision; an integration check establishes the accumulated revision it inspected. Later integration may stale cross-task evidence. Required final checks cover the final accumulated result, including changes made by review fixes.

Use the dispatch final code-review and scoped fix process, rather than mandatory review waves per task. Review fixes remain within approved scope and reconcile affected task acceptance, evidence, and descendants when their inputs change.

### 8. Safe final delivery

Completion requires every task accepted, every final criterion evidenced, and required final review and post-mutation checks satisfied.

Deliver only the verified run-owned delta, relative to the captured caller baseline. Check the caller's checkout for intervening changes before transfer. Preserve unrelated edits and pre-existing staged state. Conflicting drift blocks delivery rather than overwriting caller work.

Delivery must be recoverable if interrupted and must not report completion after only a partial transfer. Retain the final verified revision and sufficient transfer evidence to reconcile actual caller state before retrying. Serial integration and final delivery never compete with Git writes in the caller checkout.

### 9. Failure and recovery

A task-local failure blocks descendants while unaffected branches continue. The overall run remains incomplete. Scope violations, unresolved concerns, failed checks, and integration conflicts follow bounded admission and repair policy rather than becoming implicit acceptance.

A run-level failure in journal integrity, governed inputs, isolation, baseline reproduction, or integration/delivery safety stops new launches. Reconcile or stop existing handles explicitly and preserve evidence. When no runnable work remains, emit a consolidated blocker/failure decision rather than waiting indefinitely or asking separately for every blocked descendant.

Persist the task and attempt identity, plan hash, baseline revision, worktree location, launch handle, receipt location, accepted revision, and integration/delivery progress. The journal remains authoritative. Recovery reconciles live handles and actual artifacts before relaunching or applying results. A crash must not cause a duplicate writer or double integration.

Retain each launch handle and use event-driven waits for completion, material blockers, or user input, with bounded fallback handling. Routine progress does not trigger repeated status requests.

Plan revisions occur at a quiescent coordination boundary: collect completed results or explicitly stop live writers before replacing their governing inputs. Changed prerequisites, ownership, criteria, or contracts invalidate affected results and descendants. Preserve unaffected evidence only when its inputs remain valid. Scope expansion follows production-approval rules.

User cancellation stops launches, resolves live handles, and preserves recovery artifacts. Never remove a worktree with a live writer. Keep unresolved task worktrees and evidence; clean up disposable run-owned worktrees only after verified delivery or explicit failure disposition. Physical worktree and checkpoint locations follow session governance and native visibility requirements; all locations are recorded rather than reconstructed by guessing.

### 10. Complexity boundaries

Coordination uses dispatch-owned journals, effects, configuration, verification, approval, review, and artifact governance. It introduces no independent scheduler service, queue database, or general-purpose distributed workflow framework.

Authoritative facts have one owner: file entries define writable ownership, the graph defines prerequisites, results define acceptance, and derived views explain readiness and execution order. Writer instructions define development behavior; structured receipts expose independently checkable evidence.

The architecture includes no collective RED barriers, task-specific model routing, persistent paused-agent scheme, resource-lock registry, worktree pool, token measurement subsystem, or special shared-checkout path for small plans. Both serial and parallel execution use the same isolation and acceptance boundaries.

Exact metadata syntax, cap defaults, baseline capture mechanics, checkpoint representation, and receipt fields are implementation-plan choices. They must preserve this decision's observable invariants. Evidence that a boundary cannot be met requires revisiting the decision rather than quietly expanding scope or weakening verification.

## Consequences and trade-offs

| Concern | Benefit | Cost or limitation |
| --- | --- | --- |
| Human comprehension | Each task explains its outcome before file details; the graph exposes interactions. | Authors must identify meaningful boundaries and dependencies. |
| Context hygiene | Writers start with focused briefs and consult the full plan on demand. | Repository orientation and shared-contract reading repeat across writers. |
| Speed | Independent ready tasks launch without waiting for unrelated branches. | Prerequisites, serialized integration, and final gates limit achievable concurrency. |
| Attribution and recovery | Stable worktrees make task changes and evidence independently inspectable. | Worktree preparation, input reproduction, and final transfer require explicit handling. |
| Tests-first safety | Reproducible RED and GREEN checkpoints gate acceptance. | RED is independently checked after production, allowing wasted implementation work if evidence is invalid. |
| Integration correctness | Dependents consume verified integrated prerequisites. | Scoped integration checks and final aggregate verification add execution cost. |
| Simplicity | One task lifecycle and one serial/parallel execution path reduce coordination variants. | Conservative serialization dependencies can block work that a richer resource scheduler might allow. |
| Token efficiency | Meaningful tasks, progressive disclosure, and concise receipts reduce unrelated context and coordination chatter. | Setup, evidence replay, and integration consume tokens and time; net savings are unmeasured. |

The design makes no percentage claim about token or speed improvements. Its efficiency controls are task cohesion, bounded concurrency, scoped verification, concise handoffs, and omission of optional coordination machinery. Worktree setup, immutable evidence validation, and safe integration remain deliberate costs because they support independent acceptance and preservation of caller state.

## Acceptance boundaries

| Scenario | Required result |
| --- | --- |
| One coherent task | Uses the same scheduler and isolation contract without forced fragmentation. |
| Prerequisite followed by independent consumers | Consumers start only after verified integration; run concurrently within the cap. |
| More ready tasks than available slots | Deterministic plan-order admission without oversubscription. |
| Different files with a semantic dependency | Graph expresses the prerequisite; review verifies the claimed independence. |
| Same-file edits or shared output contention | One file owner; task-local resources or explicit serialization prevent races. |
| Missing, false, or setup-only RED | Acceptance fails and descendants remain blocked. |
| Result submitted from an older independent baseline | Only its owned delta integrates; current interactions are checked. |
| Writer reports completion with unresolved concerns | Concerns follow ruling policy; completion alone does not establish acceptance. |
| One task fails | Unaffected branches proceed; descendants block; overall completion remains false. |
| Interrupted writer launch or integration | Recovery reconciles identity and actual state without duplicates or double application. |
| Caller changes during execution | Unrelated changes survive; conflicting transfer is blocked and explained. |
| Final review changes production code | Affected evidence is reconciled and checks run after mutation. |
| Interrupted final delivery | Recovery determines transferred state before resuming; partial transfer is not completion. |

Protocol and scheduler tests establish observable launch, receipt, acceptance, and recovery behavior. Git, worktree, subprocess, and transfer scenarios belong in end-to-end tests. Portability claims require evidence on the corresponding hosts; untested environments remain explicitly unverified.
