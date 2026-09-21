# Technical-design contract

The design foundation treats a technical design as a governed, scratch-only artifact. Activation is evidence-based for work with multiple increments, shared boundaries, or material dependency and rollback risk. The design is reviewed with the architectural rubric, and approval is explicit, user-attributed, and bound to the normalized governed content hash.

Execution status and review history are excluded from the governed hash. Status-only or review-log edits therefore preserve approval; any governed edit clears approval and requires re-review. External review being disabled or unavailable is disclosed at approval and never represented as consensus.

Approval records the design revision, root-slug ledger identity, and the highest-priority ready increment, then appends `run-complete` with `design-approved-stop`. The invocation stops before authoring increment plans or modifying production files.

If writes occurred before promotion, the ordinary segment is closed as `aborted`; the live diff is fingerprinted and reconciled as candidate initial-increment or abandoned work, then attributed state is bound into the design baseline. Approved design artifacts remain in `.scratch/` for durable resume; ordinary successful handoff relocation remains unchanged.

## Implementation increments

An increment invocation binds to the approved design revision: its ledger segment carries
`action: "increment"`, `design:{path,revision}` (path equal to `governingPath`, revision equal to
`governingHash`), and `increment:{id,planPath,walkthroughPath,planHash}` where `planHash` is the
settled plan's governed hash (frontmatter removed, resolution log excluded). The segment opens
right after plan settlement and before the baseline, so the `baseline-red` ruling and
every later event append inside the open segment; increment segments derive their approval from
the design revision binding and carry no `approval` event. Plan-review rounds are recorded only
in the plan's resolution log; ledger `review` events record the increment's code-review rounds,
which always occur inside the open segment. No ledger event may ever be appended between a prior
`run-complete` and the next `run-start`.

Author the increment plan from the plan-review template extended with
`## Technical-Design Traceability` (parent design path, approved revision, increment ID and
inherited contract, prerequisite evidence, acceptance mapping); review it under the configured
plan-review policy with bounded approved-design context. Take the ledger identity from the
binding above, never from filenames. Ask the user only on a decision-changing ambiguity and
classify each answer as a local refinement (recorded in the plan) or design-changing (amendment
path). Keyed opt-ins render as for ordinary plans; design-changing selections enter the amendment
path instead of materialization. Update the status mirror with
`scripts/design-run.mjs --design <path> --states '<ledger states JSON>'`, which refuses
governed-hash changes. Commits and compaction remain user-owned and optional.

One increment runs per invocation. Among ready increments the highest-priority ready increment
(healthy prerequisites, not blocked/invalidated/complete) runs first. After verification, code
review, and checkpoint settlement, update the ledger and the design's `## Execution Status`
mirror — a status-only write that preserves the governed hash and approval metadata — then end
the invocation with `run-complete` result `complete` and the durable stop report (completed
increment, verification/review state, deferred items, commit state, exact `Next Action`, exact
resume command, optional compaction point). The user-selected adjacent-fix loop is the sole
one-increment-per-invocation exception: implement only the selected findings as an adjacent-fix
cluster, keep their verification and scoped review separate from the increment contract, then
stop.

## Design amendments

A design-changing discovery pauses before additional writes. Amendments are transactional: the
last approved governed design stays the only executable revision while an OS-temp candidate
records the proposed changes and affected increment IDs. The candidate's changed sections are
reviewed under the design rubric. The ledger records `proposed`, `reviewed`, `prepared` (user
approval), and `activated` — with `rejected` or `aborted` terminal from any pre-activation
state; the lifecycle starts at `proposed` and a no-op candidate (governed content identical to
its base) is refused at prepare.

Explicit user approval first appends and fsyncs the `prepared` event (deterministic `targetPath`
and `replacementPath`); only then is the byte-for-byte `.<design-file>.bak` backup copied beside
the canonical design and the `.<design-file>.tmp` candidate staged. Activation re-verifies the
prior revision and candidate hash, bakes the updated frontmatter approval metadata onto the
staged candidate (`approvedContentHash` = the candidate's governed hash, canonical `approvedAt`),
atomically renames it over the canonical design, verifies the new governed hash equals the
prepared `candidateHash`, appends `activated`, and removes the staging files. A crash between
the rename and cleanup is recovered on startup: recovery re-verifies the canonical hash and
removes orphaned staging files.

Startup recovery windows (discriminated by staging-file presence, hashes corroborating): no
prepared amendment → `none`; prepared with canonical equal to the prior revision → pre-rename
(user ruling: resume or discard); prepared with canonical equal to the candidate hash → verify
and repair frontmatter approval metadata, then append the missing `activated`; mismatch on
either side → preserve both copies and enter `needs-reconciliation`. An `activated` event with a
canonical governed-hash mismatch also enters reconciliation. Only activation invalidates
affected pending/active increments (and their downstream dependents) and reopens completed
increments whose contracts or shared invariants changed; independent completed increments remain
valid. Rejection, interruption, or abort leaves the proposed revision non-authoritative; the
prior design becomes executable again only when the live diff matches its recorded
active-increment state, otherwise the ledger stays `needs-reconciliation` and the user
classifies the attributed changes. The workflow never removes caller-owned changes
automatically.

Amendment segments: plan-authoring-time amendments (no open increment segment) run inside a
dedicated v2 design-action segment binding the design path at the base revision, carrying
amendment and increment-state events but never task events, closed with `run-complete` result
`complete` before the next increment plan is authored. Mid-execution amendments stay inside the
open increment segment; integration-time amendments stay inside the open integration segment. An
increment segment closes with `run-complete` result `complete` before an activated amendment may
invalidate or reopen its own bound increment.

## Final integration

After the last increment settles, the next `/implement-dispatch <design-path>` invocation runs
the final integration gate only. Freshly verify cross-increment behavior and, when code review
is enabled and available, run the configured final review over the union of ledger-owned paths
— completed increments, accepted adjacent-fix clusters, reopened increments, active integration
fixes — from the design-run baseline commit (code-review `baseRevision` with `allowedPaths`) through
current HEAD plus working tree, so committed
increments stay visible. Unrelated paths in the range are excluded; pre-existing or user-retained
changes on owned paths are included conservatively and disclosed. A zero-path owned intersection
is a fail-closed integration diagnostic (the gate cannot settle with nothing owned to review);
if the baseline is no longer an ancestor after a rebase, or ownership cannot be reconstructed,
enter reconciliation and require an explicit replacement baseline. When code review is disabled
or its optional companion is unavailable, disclose the skipped review and still require fresh
integration verification.

Record evidence and any enabled review under
`.scratch/plan/<yyyy-mm-dd>-<design-slug>-integration-walkthrough.md` (scratch tier, explicit
path, design slug). If integration exposes a defect inside an approved increment contract,
reopen that increment with its implementation-plan and review state; if it exposes missing
scope, a changed architecture or shared contract, or a genuinely new increment, use the
amendment path. Final completion requires all reopened or amended work to settle and the
integration gate to pass on a later invocation.

Keep the technical design and every increment plan and walkthrough under `.scratch/` through
final integration; increment stops report but do not relocate them. After final integration
settles, pass every design-run artifact to `dispatch/scripts/relocate-scratch.mjs` and report
every destination. The ledger is never relocated.
