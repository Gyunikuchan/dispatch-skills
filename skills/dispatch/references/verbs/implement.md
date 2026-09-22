# Implement verb contract

Ledger, verification, and implementation-delegate contracts for the implement verb.

## Durable execution ledger

Use the ledger independently of walkthrough freshness. Resolve `ledgerPath` before dispatch and
fold it before trusting any completion claim.

### Identity and resume

An ordinary run uses one canonical `.scratch/plan/<date>-<slug>.md`. If branch resolution produces
a different slug, persist the filename slug explicitly before approval. Native artifacts and
non-canonical plan paths cannot use plan-path resume; stop with the resolver diagnostic and create
an explicit canonical scratch plan.

Resuming an implementation run on `<plan-path>` recomputes the plan's semantic `governingHash`, resolves its
ledger, and selects only the latest matching unterminated ordinary segment. A level-less resume
re-resolves flow, states the exact delta, and always obtains user confirmation before dispatch.
Completed or hash-mismatched segments never resume implicitly.

Before dispatch, compare each authoritative completed task's `resultState` with the current
materialized path state. Later overlapping ownership supersedes the earlier task for shared paths.
Drift, malformed/unknown events, unsupported path bytes, or strict plan-normalization failure enter
`needs-reconciliation`; they never authorize redispatch. A missing ledger is recoverable only by
explicit best-effort reconstruction from the governing artifact and working tree.

### Append points

Immediately after approval, append `run-start`, then `approval`, then any pre-approval `ruling` and
`review` records. Before each task or cluster dispatch append `task-start`. Append every
`implementation-attempt` and its host `verification`; append `task-complete` only after a
non-regression verification transitions to `complete`. Append later rulings and reviews as they
settle (settled § 4 review fixes are checkpointed with the review record). Append `run-complete`
last for complete, stable-failure, or aborted outcomes.

No ledger event may ever be appended between a prior `run-complete` and the next `run-start`;
the fold rejects any event after a terminal event that is not a new `run-start`.

Use the exact v1 event grammar enforced by `scripts/ledger-events.mjs`. Sequence numbers are
ledger-global. The writer holds one exclusive lock across tail read, sequence assignment, append,
and fsync. Repair uses the same lock. Append refuses malformed or unterminated tails.

Read-only inspection reports torn bytes without mutation. `repair-tail` reports those bytes before
truncating and fsyncing the valid prefix, then requires a resolved `reconciliation` ruling. A stale
lock is broken only through the explicit operation after proving its PID is dead; a live or
unverifiable holder requires user ruling.

### Phased (v2) events

Design-run segments use ledger version 2 with the widened `run-start` action grammar
`ordinary|design|increment|integration`. `action: "design"` keeps the exact design-foundation schema;
`increment` and `integration` actions additionally require `design:{path,revision}` (path equal
to `governingPath`, revision equal to `governingHash`) and, for `increment`,
`increment:{id,planPath,walkthroughPath,planHash}`. Increment segments derive their approval
from the design revision binding (no duplicate `approval` event; the immediate-approval rule
stays ordinary-only) and may contain `task-start`, `implementation-attempt`, `verification`, and
`task-complete` events; design and integration segments may not contain task events. Increment
segments open right after plan settlement and before the baseline; every invocation,
including a clean increment stop, ends its segment with `run-complete` (result `complete`).
`design-approved-stop` stays reserved for the approval durable stop; amendment-only design
segments also end with result `complete` and are excluded from approval-bearing design-segment
selection, which resolves to the latest design segment carrying an approved `approval` event.

The v2 grammar additionally enforces what the design foundation shipped; the four new v2 event types and their exact required data:

- `increment-state`: `incrementId` (`I<nn>`), `prior`, `next`, `cause`, `affectedDependents`
  (increment IDs); legal transitions `pending→ready→active→complete`, unfinished →
  `blocked|invalidated`, `complete→reopened`, `reopened→active`, `blocked→ready`, and
  `invalidated→pending` only after an `activated` amendment affecting that increment; a
  completed task cannot restart until its owning increment reopens.
- `amendment`: `amendmentId`, `state` (`proposed|reviewed|prepared|activated|rejected|aborted`),
  `affectedIncrements` always; `baseRevision`+`candidateHash` required on `prepared` (which also
  requires `targetPath`/`replacementPath`) and `activated`; rejected on `proposed`/`reviewed`/
  `rejected`/`aborted`; optional `reconciliationState`.
- `adjacent-fix`: `findingIds`, `clusterId` (`C-<12 hex>`), `attempts`, `result`
  (`complete|failed|aborted`); legal only after its cluster's task events.
- `integration`: `scopeId`, `verificationRefs`, `reviewRefs`, `result`
  (`pass|accepted-baseline-equivalent|regression`); only in integration segments after their
  verification/review evidence.

Ordering: an `amendment` is legal after the design binding exists and must follow the affected
increment's latest task event across the folded run when the increment has task history;
plan-authoring-time amendments run inside a dedicated design-action segment binding the design
path at the base revision. An amendment precedes the `increment-state` transitions it causes.
`foldDesignRun(events)` folds every valid segment for the matching design identity (normalized
design path + root slug) across revisions, merging increment states, amendments, adjacent-fixes,
integration results, and rulings; `nextDesignAction(fold)` derives exactly one of
`resolve-reconciliation`, `resolve-amendment:<id>`, `resolve-ruling:<key>`, `resume-increment`, `implement:I<nn>`,
`final-integration`, `complete` — in that precedence order, with final integration requiring
every folded increment to be `complete` and reopened increments remaining implementable. Phased
resume is authoritative over
the design-only `selectDesignSegment` path, which remains for design-review-only runs.

### Interruption and handoff

Interruption reports include the canonical resume command and exact ledger path. At ordinary
handoff print the same command and warn that OS temp, including Windows Storage Sense, may purge
the ledger. The ledger remains in its per-user temp namespace and is never relocated with scratch
artifacts.

Emit one `Rulings made` list combining latest keyed ledger rulings with review resolution-log
rulings. Review-log rulings are authoritative on a key collision. Preserve unresolved rulings and
reconciliation state in the handoff.

## Verification evidence contract

### Baseline scope and evidence

Extract every command from the settled plan's `Verification Plan / Automated Tests`; `- None:
<reason>` is unavailable, not passing. Extract approved paths from `[NEW]`, `[MODIFY]`, and
`[DELETE]` H4 headings under `## Proposed Changes` with
`scripts/verification-evidence.mjs --approved-paths <plan>`. If none parse, use every tracked and
non-ignored untracked path outside `.scratch/` and record the fallback. Map selected commands with
`scripts/verification-evidence.mjs --map-commands <plan> '<commands-json-array>'`. Its deterministic
JSON object maps each command, using an exact trimmed-string match to `Verify:`, to the sorted union of
referenced `Changes:` paths only when every criterion referencing that command has `Changes:`;
otherwise it maps to the full approved path set.

At baseline, classify approved paths as test/test support or production using host conventions and
record the split under walkthrough `## Verification & Validation`; classify later-created paths
with the same recorded rule. Record every command, exit status, stable failing identifiers, and a
bounded normalized diagnostic.

Capture Git porcelain plus dirty-path object IDs before and after every baseline command. Any
tracked mutation or new non-ignored file inside approved scope enters side-effect reconciliation:
stop for caller removal or an amended, re-reviewed plan. Prove outside-scope files irrelevant or
reconcile them. Preserve caller-owned changes. Outside Git, record `side-effect capture
unavailable` and obtain a ruling before approval: `proceed without side-effect capture`
(recorded under `## Verification & Validation`) or `abort`.

### Result identity and freshness

A red or unavailable baseline is never green. Ask whether to proceed with the known-red baseline
or fix first; fixing amends and re-reviews the plan but remains approval-gated. Record the ruling
as the keyed `baseline-red` ledger ruling.
A later nonzero result is `known red — unchanged` only when exit status and stable identifiers
match the accepted baseline, or exact normalized diagnostics match when identifiers are absent.
Anything else is a regression.

Evidence is fresh only when produced after the last mutation or accepted fix in the command's
mapped scope. Completion reruns every settled command. Delegate success reports do not establish
verification.

### RED quality and failure disposition

A tests-only launch receives an authoritative compact OS-temp prompt (its action carries `promptPath` and SHA-256 `promptHash`) containing the exact red-criterion manifest, approved test paths, mapped commands, expected RED, boundaries, and envelope contract; the native launcher reads it fully. Its envelope carries exactly one parseable `RED-MATRIX <SC#> | <test path/name> | <expected failure>` entry per expected SC in `evidence[]`, with no extras. Immediately admit only a valid `RED_READY` transition whose rows use mapped approved paths and stable exit/identifier shapes. Before production delegation, run `red-quality.mjs --plan <path> --evidence <json-file|-> --red <json-file|->`; every mapped criterion needs one primary row, mapped test scope, and a stable failure identity, with interruption/resume and adversarial rows where applicable. `N/A` requires a non-empty class reason. Exit 0 is valid, exit 1 is a quality defect, and exit 2 is invalid input. Dispatch records an attempted launch but charges/admit it only after immediate admission. One failed admission—including malformed output—permits one compact continuation on the same model/effort and existing test changes, exposing only the original manifest and precise defects; re-run full admission. A failed repair opens failure disposition without a canonical implementation-attempt. Host RED failure after admission is consumed and opens failure disposition without repair.

Risk-heavy durability, recovery, concurrency, security, or protocol work receives one bounded independent `dispatch` read-delegate over changed tests and matrix before production delegation. Routine work receives no extra reviewer; unavailable review degrades to an explicit orchestrator-only gate and consumes no review, checkpoint, or ledger accounting.

Implementation failure preserves the working tree, captures Git state, and opens `failure-disposition` before asking the user to `keep-for-repair`, `revert-attributable`, or `inspect-first`. Resume checks a matching captured failure snapshot before completed-task drift; later drift requires reconciliation. Reversion is explicit and only attributable paths are eligible: baseline caller-dirty, mixed/non-separable, or post-snapshot-drift paths remain preserved. Resolve the ruling with post-choice state and walkthrough evidence before appending `run-complete: stable-failure`; `inspect-first` remains open and unterminated; a resolved ruling precedes `stable-failure`.

### Evidence classes and RED boundary

Each criterion declares exactly one `Evidence: red|verify|review` and a concrete `Test rationale:`.
Choose existing checks first, then retained RED only when discriminating, stable, regression-bearing,
proportionate, and behavioral; otherwise use deterministic `verify` or bounded `review`. Review
names artifact, scenario, observable pass condition, inspected revision, result, and limitations.
Critical correctness, safety, recovery, durability, or protocol guarantees use review only with a
recorded deterministic-enforcement infeasibility rationale.

When one or more criteria use `red`, allow at most one tests-only launch in addition to the
run's implementation attempt budget. Give it only red criteria and their mapped test/test-support
paths. It returns the typed `RED_READY` stage defined in
[Implementation delegate contract](#implementation-delegate-contract); the host runs the
mapped command and production work begins only after failure for the expected reason.
Characterization, test-only repair, and generated/snapshot exceptions require evidence and a
recorded ruling. A late test is a missed gate requiring user acceptance.

A plan without red criteria records `RED gate: not applicable — no red-class criteria` and launches
production directly after approval. Mixed plans require matrix rows only for red criteria. Verify
checks run after relevant mutation and again at completion; review evidence must postdate its last
mapped mutation. All mapped commands remain mandatory final regression evidence.

An unrelated failure or production-path mutation is invalid RED and consumes the current bounded
implementation attempt. A regression after implementation consumes its current attempt under the
same transition contract.

## Implementation delegate contract

This contract governs delegated implementation tasks (initial approved scope implementation and
task clusters), whereas accepted post-review fixes in § 4 are applied directly by the orchestrator.

Every full implementation launch receives one ordered packet: governing outcome; settled scope,
non-scope, invariants, and rollback boundary; observable criteria and evidence classes; repository
constraints and prior failures; then tests/checks labeled **evidence, not specification**. Instruct
`implement the smallest complete behavior satisfying the outcome and scope`. A conflicting,
incomplete, or out-of-scope test yields `NEEDS_CONTEXT` or `BLOCKED` with the exact conflict; repair
or reclassify evidence through reviewed scope change before redispatch.

### Launch cascade

A resolved model array is one ordered **launch cascade** inside one implementation attempt:

1. Invoke the native subagent with the first model and the resolved effort.
2. If the native tool rejects that launch because the model is unavailable, authentication fails,
   or quota is exhausted, invoke the next model with the identical brief, attachments, attempt
   number, and effort. Continue until one starts or the array is exhausted.
3. Once a subagent starts, stop the cascade. Any later timeout, malformed envelope, `BLOCKED`, test
   failure, or defective implementation is an implementation outcome handled by attempt recovery;
   it does not authorize another array model.
4. Record each invocation before outcome handling as
   `model <index>/<count> <name>; effort <value>; <launch-rejected: reason|started>`.

The cascade is complete only when one entry is recorded as `started` or every configured model has
a recorded eligible launch rejection. Thus `model: ["gpt-5.6-luna", "bedrock.gpt-5.6-luna"]` with
`effort: "max"` means a rejected first native call is followed immediately by a second native call
using `bedrock.gpt-5.6-luna` and `max`; it does not mean the orchestrator may implement inline.

Attempt 2 receives the instruction to identify root cause before modifying code. A native launcher
receives only fields its host tool schema supports; flow resolution reports applied and ignored
configured fields.

The final message contains exactly one raw or fenced JSON envelope:

```json
{
  "schemaVersion": 1,
  "status": "DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED",
  "stage": "RED_READY|COMPLETE",
  "summary": "non-empty string",
  "evidence": ["bounded path, command, or diagnostic"]
}
```

No additional fields are permitted. A fenced envelope must use the `json` language tag.
`DONE_WITH_CONCERNS` also requires non-empty `concerns`; `NEEDS_CONTEXT` requires
`missingContext`; a second request, or one materially identical to context already supplied, consumes the attempt; `BLOCKED` requires `blockers`. Other status-specific arrays are omitted or empty.
Evidence is non-empty for both `DONE` statuses and may be empty otherwise. `RED_READY` is legal
only with `DONE` or `DONE_WITH_CONCERNS` from a tests-only launch or its context continuation. A full launch and
its continuation use `COMPLETE`; a tests-only launch unable to reach RED returns `COMPLETE` with
`NEEDS_CONTEXT` or `BLOCKED`.

A `DONE_WITH_CONCERNS` transition obtains and records the concern ruling first. After resolution,
run the envelope's pending action: the RED gate for `RED_READY`, or independent verification for
`COMPLETE`.

`RED_READY` asks the host to run the RED gate; it is not verification. The authoritative
tests-only evidence and invalid-RED accounting rules are in
[Verification evidence contract](#verification-evidence-contract).

Current native implementation launches are non-resumable unless
`dispatch/references/providers.md` documents and tests a continuation operation for that launch
kind. Without one, `NEEDS_CONTEXT` consumes the attempt and replacement uses the next attempt.
At most one context-only continuation is legal in a resumable attempt.

Delegated failures use at most three attempts: primary, same-platform/same-model root-cause-first
replacement, then the next distinct configured native tier when available. No higher distinct tier
stops after Attempt 2; any Attempt 3 failure stops for user ruling. Host-platform execution allows
two attempts and no model escalation. `BLOCKED` requires changing the blocking condition; it never
authorizes an identical retry. Failed delegated work never transfers silently to the host platform.

Validate a captured final message with
`node scripts/implementation-outcome.mjs --parse <file|->`. Compute the next action with
`node scripts/implementation-outcome.mjs --transition <json-file|->`; its input is the validated
envelope plus launch kind, attempt, target kind, resumability, context-continuation state,
escalation result, continuation origin, and any host verification result. Target kind is `delegate`
for a separate CLI process or `self` for a native subagent on the host platform; `self` never means
the orchestrator implementing inline.
