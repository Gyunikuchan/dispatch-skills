# Dispatch driver authority and durable continuation

> **Outcome:** Preserve work when plans or repository content change. Let the orchestrator judge relevance and evidence sufficiency. Retain deterministic execution, concrete write safeguards, and recoverable state.
>
> **Status:** Conversational design approved on 2026-10-13; written spec awaits user review.
>
> **Planning handoff:** Use the requested `dispatch-plan` after written-spec approval. This document authorizes design work, not implementation.

## Intent and agreed decisions

The user reports that Dispatch is restrictive and error prone: plan changes can lead to proposed work disposal, and repository changes unrelated to the task can block progress. Success means fewer coordination turns and recovery failures while preserving caller files, accepted work, and accurate verification claims.

The user approved the recommendations for Q1-Q8, then approved the consolidated design. These decisions govern implementation:

1. Retain scheduling and durable execution; the orchestrator judges the meaning of changes.
2. Permit reasoned evidence reuse with incomplete dependency coverage. Failed required checks remain unresolved.
3. Support explicit continuation after a local driver fix through validated checkpoints and rebind.
4. Attach ordinary change observations to an existing frame without a separate drift acknowledgement.
5. Preserve candidates, commits, writer handles, attempts, and history across plan changes. Retire removed obligations separately from discarding work.
6. Accept a complete replacement plan bound to its previous revision. Use one reconciliation path for replacement and any retained exact-text amendments.
7. Retain revision-bound review findings. The orchestrator chooses reuse, targeted review, full review, or escalation.
8. Inspect uncertain effects before retrying. Reconcile completion automatically only when evidence proves it.

## Alternatives and scope

The selected approach separates execution from judgment within the existing driver. Adding override flags to the current drift gate would retain competing policies and recovery paths. Replacing the scheduler with host-managed execution would enlarge the change and lose useful durable identities.

The implementation covers change observations, evidence obligations, task reconciliation, review reuse, interpreter durability, checkpoint/rebind, and their public contracts. Remove superseded states, tests, and instructions as each replacement becomes authoritative. Add no external dependency or runtime prerequisite.

Excluded work: provider model selection changes, concurrency or timing-budget changes, mandatory extra writer stages, a telemetry subsystem, general migration of historical journals, and unrelated audit findings.

The inspected runtime baseline is commit `1070d7c`. Current evidence is in [change resolution](../../../skills/dispatch/scripts/machines/change-resolution.ts), [task reconciliation](../../../skills/dispatch/scripts/machines/implement-tasks.ts), [amendments](../../../skills/dispatch/scripts/machines/revision.ts), [review transitions](../../../skills/dispatch/scripts/machines/review.ts), and [interpreter replay and rollback](../../../skills/dispatch/scripts/core/interpreter.ts). These are source pointers, not copies of the runtime contract. Recheck them when authoring the implementation plan.

## Authority and execution boundaries

| Concern | Owner | Required behavior |
| --- | --- | --- |
| Relevance of repository and plan changes | Orchestrator | Record a rationale and select affected obligations; dependency analysis supplies evidence, not permission. |
| Evidence and review reuse | Orchestrator | Identify the evidence retained and its actual coverage, or request new verification/review. |
| Intent change, new dependency, actual work disposal | User under existing approval rules | The orchestrator identifies the material decision and obtains the required approval. File names and prose differences are advisory signals. |
| Scheduling, attempts, launch handles, counters | Driver | Retain stable identities and enforce the settled execution policy. |
| Receipt identity, path containment, actual write admission | Driver | Reject malformed or unauthorized operations before acceptance or mutation. |
| Immutable reference integrity | Driver | Validate schema, digest, length, containment, and repository ownership before use. |
| Live delivery/restore collision | Driver and orchestrator | Preserve caller and candidate bytes; stop the affected mutation until a concrete conflict resolution passes preflight. |
| Required failed checks | Driver | Report the unresolved failure; evidence reuse cannot relabel it as passing. |

Ordinary observations cannot grant write scope or permission to overwrite caller changes. Existing approval rules for production writes, changed intent, external dependencies, and actual disposal remain in force. The driver validates recorded approvals structurally; the orchestrator determines their semantic trigger.

## Change observations and evidence obligations

Use the existing Git observation scope and immutable delta artifacts. Keep ignored content rules and live destination preflight; this change concerns how observations affect progress.

At existing acceptance boundaries, capture relevant changes and attach a concise observation to the next frame: identity, baseline/current revision, changed paths or linked delta, and suggested affected evidence. Coalesce repeated unchanged observations. Ordinary drift introduces no extra host await and consumes the parked receipt once.

Treat path overlap, incomplete dependency coverage, and HEAD/index/ignore-rule changes as signals. They cannot automatically revoke evidence or reset task state. Complete dependency declarations remain optional evidence; remove the requirement to prove transitive disjointness before reuse.

The orchestrator records disposition through the normal event path: retain identified evidence with rationale, request named checks/reviews, reconcile the plan, or escalate changed intent. It can acknowledge an observation alongside its normal reply. An observation does not require an acknowledgement merely to progress; current evidence keeps its recorded provenance until a disposition changes its use. At completion, the orchestrator's evidence acceptance accounts for observations that could affect required criteria.

Keep three distinct facts:

- Work exists: writer draft, submitted candidate, or integrated commit.
- Work was accepted: immutable acceptance history against its then-current contract.
- Current obligations are satisfied: the evidence currently relied on for the current plan.

When the orchestrator requests fresh evidence, mark those obligations pending while retaining work and prior results. Re-verification operates on the retained candidate or integration. Launch repair work only when the orchestrator selects a concrete implementation change. Mandatory final gates still run against the selected delivery candidate after accepted changes.

## Plan replacement and reconciliation

A replacement request supplies the new plan artifact, the expected previous governed revision, a rationale, affected writer notifications, and a reconciliation summary. Parse the plan and validate its task graph and write boundaries. A stale previous revision rejects the replacement with the current revision; it leaves all work intact.

Use one reconciliation operation for replacement and retained exact-text amendment input. The summary accounts for retained, changed, added, and retired obligations, retained work references, requested evidence/review, and any approval-requiring decision. Validate structural completeness; do not infer semantic intent from title, summary, or dependency-manifest edits.

Retain running writers and attempt identities. Notify affected writers and regenerate their briefs. Scope changes take effect through the established admission boundary; a notification is not authority for unspecified writes. Retain the prior brief and submission provenance for admission and review.

For an accepted task gaining an unfinished prerequisite, retain its implementation and add a pending validation/delivery obligation. Run the new prerequisite, then assess the retained consumer on the combined candidate. Future writes follow the revised dependency graph. The graph must remain acyclic, but historical execution order alone does not force disposal.

Removing a task retires its requirement and archives its work reference. Explicitly account for already integrated changes: retirement does not silently remove bytes from the delivery candidate. If those bytes need removal, obtain the applicable approval and produce a scoped compensating change. Preserve the old candidate and history. Retire running tasks through an explicit handle disposition; do not orphan the writer or free its slot while it remains active.

## Review provenance and reuse

Retain findings and rulings with the actual reviewed target revision and scope. A target change adds an observation about current coverage. It does not supersede findings, refresh a review automatically, spend a round, or invalidate accepted fixes.

The orchestrator records whether to reuse findings for the current target, request a targeted review, request a full review, or escalate. Record the rationale and scope of any reuse. A reused review remains evidence about its original revision plus an explicit host assessment of applicability; render that distinction in the governing artifact.

Count review work actually launched. Retain the configured cap and existing escalation policy; reaching the cap reports the available evidence and unresolved coverage instead of creating an automatic drift-refresh loop. In-flight reviewer results remain bound to their launch revision, even if the live target changes before receipt.

## Durable checkpoints and explicit rebind

Checkpoints contain full private machine state, not the projected host frame. Each immutable checkpoint includes:

- Checkpoint schema and compatible machine-state version, run/repository identity, runtime identity, journal sequence, and journal-prefix digest.
- Full machine state and counters, exact queued effect descriptors, open effect attempts, and execution configuration.
- Native launch handles and receipt identities, candidate/integration references, plan/review bindings, and evidence artifact references.

Publish a checkpoint after each accepted result and at host-await boundaries before starting the next effect. Publish its bytes durably before its journal reference. The checkpoint state, queue, and reference describe the same committed prefix. A crash between publication steps leaves an unreferenced artifact or recoverable result tail; it cannot manufacture an accepted checkpoint.

Normal recovery loads a verified compatible checkpoint and folds only its continuation tail. Preserve the full journal for audit and diagnostics. Older checkpoint schemas require an explicit supported adapter; incompatible state produces a precise preserved-state limitation rather than an inferred migration.

After a local runtime fix, an explicit rebind operation validates the checkpoint, immutable references, repository ownership, and unresolved effect status. It records old/new runtime identity, rationale, checkpoint binding, and continuation epoch. It does not re-run earlier reducer decisions, repeat accepted tasks, repeat baseline/setup, or repeat plan review solely because the runtime changed.

For an open effect, inspect handler-specific completion evidence. Existing immutable identities, receipts, commit trailers, or live process handles may prove completion or continued execution. Reattach or admit a proved result. If completion remains uncertain, expose the exact effect and evidence to the orchestrator. Require a recorded disposition before retrying a potentially duplicated command or writer. Do not fabricate a successful result from missing journal data.

An engine fault preserves earlier durably accepted events and effects from that send. Limit rollback to the unaccepted tail; avoid the current whole-send truncation hazard after successful disk effects. If a result append or checkpoint publication fails after an external effect succeeds, recovery must reconcile that effect before advancing.

Introduce the simpler current protocol as needed. Preserve historical folders. This release guarantees continuation for supported checkpoints created under the new contract; it does not promise repair of arbitrary older journals. A historic run without a usable checkpoint can retain its artifacts for a new, explicitly reconciled run.

## Diagnostics findings

The supplied v0.7.1 findings are claims; the original incidents were not reproduced.

| Finding | Current evidence | Design disposition |
| --- | --- | --- |
| Suffixed scoped criterion ID | Evidence parsing accepts numeric IDs only. Current live widening uses parsed amendments; retained implementation-overlay consumers have no current producer for those definitions. | Remove unused overlay support when confirmed redundant. For retained paths, use one shared criterion-ID grammar across admission and evidence, with an end-to-end regression. Do not introduce suffix support without a requirement. |
| 32m 22s write await | Diagnostics measures an interval between journal entries, not activities within the host turn. The brief already names work stages. | Retain as an attribution question. No mandatory split or claimed speed fix. Use available original-run evidence before proposing additional observations. |
| Replay changed after local parser fix | Current replay regenerates effect decisions with the current reducer; changes can make recorded effects incompatible. | Address through durable checkpoints, tail continuation, and explicit rebind. Test the failure trigger through public execution/recovery entrypoints. |
| RULINGS rejection shape/example | Live rejection already returns detailed validation errors and validated frame examples. Invalid dry-run returns only an error. | Preserve existing live examples. Include the applicable validated example in invalid dry-run guidance using the same generator; retain privacy-safe diagnostic summaries. |

## Implementation boundaries and removal inventory

The plan must name precise paths and dependencies after checking the current checkout. Expected areas are `skills/dispatch/scripts/{core,machines,policy,effects,domain,lib}`, the affected operational references/templates and human manuals, `docs/state-diagrams.md`, generated hashes, and matching unit/integration/E2E tests.

Remove ordinary drift's parked-event decision loop, machine-proven-irrelevance requirement, blanket evidence invalidation from Git identity changes, task re-pending caused only by evidence refresh, and automatic integration rewind caused only by plan/evidence changes. Replace automatic review refresh/supersession with explicit reuse/review choices. Remove obsolete overlay branches and contracts only after checking their remaining consumers. Keep destination preflight, immutable artifacts, and concrete write admission.

Operational rules belong in the shipped skill and its references. This spec records agreed intent and rationale; it is not a second runtime instruction source. Update state diagrams and hashes when their governed sources change. Use the repository's manual implementation flow when the later plan changes driver code.

## Acceptance and verification

Each scenario must assert retained work references and stable identities as well as its visible frame/event outcome. Use public protocol entrypoints for frame/journal behavior, machine entrypoints for transitions, and E2E tests for real Git or process effects.

| ID | Scenario and required proof |
| --- | --- |
| A1 | An unrelated tracked edit, untracked membership change, or HEAD/index/ignore-rule change produces an advisory observation; it introduces no drift await, resets no task, and duplicates no receipt consumption. |
| A2 | The orchestrator retains evidence with incomplete dependencies and a rationale. A requested recheck retains candidate/acceptance history; a failed required check remains unresolved. |
| A3 | A complete replacement is accepted against the expected prior revision. Stale binding, malformed graph, or missing scope admission is rejected without altering work. Exact-text input, if retained, reaches the same reconciliation path. |
| A4 | Removing an accepted task retires its obligation and preserves integrated bytes/history. Removing those bytes is explicit. An added prerequisite completes before renewed validation of the retained consumer; no automatic rewrite or baseline reset occurs. |
| A5 | An active writer receives its amended brief while retaining handle/attempt identity. A retired writer has a recorded handle disposition and cannot become an orphan or exceed slot accounting. |
| A6 | A changed review target retains revision-bound findings and rulings. Host-selected reuse or re-review is recorded; notices spend no rounds. In-flight results and cap exhaustion report their actual coverage. |
| A7 | A local parser/reducer fix permits explicit rebind from a compatible checkpoint without replaying old decisions or repeating accepted work, baseline/setup, or plan review. |
| A8 | Interruption after a completed side effect, before its result/checkpoint publication, reconciles or exposes that effect. Uncertain effects cannot launch twice merely because a terminal record is absent. |
| A9 | A later engine fault in one send retains its earlier durably accepted effects. Checkpoint publication failure and an unaccepted/torn tail preserve a recoverable committed prefix. |
| A10 | Corrupt checkpoint/reference, unsupported state schema, wrong repository, and stale receipt identity fail with preserved artifacts. Delivery/restore collisions preserve caller and candidate bytes before any partial overwrite. |
| A11 | Every retained criterion-admission route and evidence parser uses the same ID grammar; valid admitted scoped criteria have matching evidence accepted. Invalid dry-run guidance contains the applicable validated example. |

Run the plan's focused verification, hash/diagram generation where affected, `npm test`, and `git diff --check` after implementation. Passing this document's checks establishes only spec integrity and an unchanged runtime baseline. It does not establish any proposed behavior.

## Risks and handoff

Host judgment can reuse insufficient evidence. Mitigate with visible provenance, explicit rationale, completion accounting, and mandatory failed-check reporting, rather than restoring machine relevance vetoes.

Checkpoint persistence increases state/storage and creates a versioned machine-state contract. Keep one checkpoint/continuation mechanism, validate every reference, and measure its overhead against existing journal recovery. General garbage collection and historical migration remain separate work.

Plan reconciliation and delivery must account for retained bytes even after obligations retire. Test that distinction and all-path collision preflight together. Recovery rollback and diagnostics must consume the same committed execution history.

Next step: user reviews this written spec. On approval, `dispatch-plan` produces the concrete task graph, path ownership, criterion mapping, removal list, and executable verification commands. Implementation requires the user's later execution-method selection.
