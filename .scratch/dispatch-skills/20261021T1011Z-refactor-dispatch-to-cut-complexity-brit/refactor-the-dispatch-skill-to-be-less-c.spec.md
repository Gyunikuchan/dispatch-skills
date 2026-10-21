# Dispatch toolkit refactor: less complexity, less friction, fewer tokens

> **Status:** draft
>
> **Level:** high — restructures the driver architecture, host protocol, authority model and shipped prose across all verbs.

## Intent & Problem

The `dispatch` driver controls every workflow step through typed state machines and a frame-per-step host protocol. That control now costs more than it protects. Orchestrators spend tokens on protocol mechanics (frame shapes, hash-bound receipts, payload rejections, amendment accounting), runs stall at gates that need no human judgment, and mid-run discoveries force re-dos instead of in-place updates. Most maintenance effort goes into closing gaps in the protocol itself.

Intended outcome: `dispatch` becomes a deterministic toolkit plus a thin ledger. The orchestrator runs the workflow from lean prose and owns sequencing and technical judgment. Tools do the deterministic work (provider fan-out, verification, worktrees, integration, evidence recording) and enforce only invariants: user gates, read-only providers, recorded evidence. The result must be simpler to maintain, cheaper per verified task, and no worse in delivered correctness.

## Background

- Driver size at v0.7.3: 19.2k TS LOC under `skills/dispatch/scripts/`; 406 exported types; 37 event types; 63 decision kinds; 80 machine state tags. `machines/implement.ts` is 2.4k LOC and changed in 36 commits since 2026-09-01.
- Tests: 29.8k LOC, larger than the driver.
- Since 2026-09-01, 110 of 454 commits are fixes. Most of them close host-protocol gaps, admit previously rejected payloads, or add escape hatches to let runs complete.
- Host protocol: one `send` round trip per step; hash-bound writer receipts and brief/delta hashes; `AMEND`/`REPLACE_PLAN` with task-ID accounting; global quiescence before `SPEC_REVISED`; user-only gates for spec, design, plan, production-write authorization, level adoption, manual completion, and intent.
- Prose: `SKILL.md` about 5 KB, always loaded; `references/verbs/implement.md` 17.6 KB; `references/self-build.md` 35 KB; `change-handling.md` and `spec-stage.md` revision/recovery-owner prose exist only to serve driver mechanics.
- The hard-gate audit (`driver-hard-gates-report.md`, external maintainer note) inventories 30+ gates in five categories; several have no bypass, and several user-only gates guard technical, not intent, decisions.
- No retained session diagnostics exist at spec time; baseline token figures are `unavailable`.
- ADR 0006 chose reducer state machines over an event journal for exact recovery and testability; this spec supersedes its engine decisions (D5–D6 and dependents).

## Requirements

### REQ-1 — Toolkit and ledger architecture
The driver is a set of deterministic tools invoked by the orchestrator, plus a ledger. Per-verb state machines and the frame-per-step protocol are removed.
- Acceptance: the toolkit offers provider fan-out (`ask`, `review`), `verify`, `worktree` (create, integrate, cleanup), `ledger` (record and query), `lint`, `brief` and `report` operations, plus `status`.
- Acceptance: no shipped code implements per-verb reducer machines, checkpoint/rebind, receipt or brief hashing, write-attempt caps, spec-revision quiescence, drift gating or level-recommendation machinery.

### REQ-2 — Compact tool output
Every tool returns a result path plus a summary of at most 1 KB UTF-8; it never prints full findings, logs, briefs or state.
- Acceptance: a test asserts the stdout byte cap for each tool on a representative fixture.

### REQ-3 — Ledger-enforced user gates
User authority is enforced structurally where it matters and nowhere else.
- Acceptance: at `medium` and above, a user approval binds one tuple of spec hash, plan hash and (when a design governs) design hash with a verbatim quote.
- Acceptance: at `medium` and above, `brief` for a writer and `worktree integrate` run only when each current artifact hash equals its approved hash or chains from it through recorded orchestrator edits, each with before and after hashes and a non-intent classification; otherwise they refuse with a gate-specific exit code.
- Acceptance: an edit classified as changing intent, adding an external dependency or runtime prerequisite, or discarding work breaks the chain until a new user approval binds the new tuple.
- Acceptance: criterion waivers and manual completion require a recorded user quote; the ledger rejects them with `by:"orchestrator"`.
- Acceptance: no separate production-write authorization gate and no level-adoption gate exist.
- Acceptance: at `low`, no approval gate applies; the report shows the spec and plan.

### REQ-4 — Orchestrator authority and living documents
The orchestrator owns sequencing and technical decisions, and edits plans and designs in place as details emerge.
- Acceptance: the orchestrator may edit the plan or design during implementation; the ledger records each change with a diff reference and rationale, and the walkthrough lists them as deviations.
- Acceptance: a plan or design edit does not require re-approval unless it changes intent, adds an external dependency or runtime prerequisite, or discards work (the user gate in `decision-frame.md`).
- Acceptance: a spec edit that changes intent requires a recorded user quote; a clarification is an orchestrator edit, recorded in the ledger. Approval binds the new hash after an intent change.
- Acceptance: no global quiescence is required to change spec, design or plan; the orchestrator notifies only writers whose paths or criteria change.
- Acceptance: scope overrun, writer concerns, merge conflicts, drift and red baselines reach the orchestrator as information with options, never as hard rejections.

### REQ-5 — Outcome-based writer verification
The driver verifies results, not ceremony.
- Acceptance: writer briefs instruct TDD and a short result report; no envelope row format, RED evidence row or brief hash is validated at admission.
- Acceptance: `verify` runs the plan's criterion and contract commands on the integrated tree and records per-criterion evidence; a task completes when its criteria pass there.
- Acceptance: missing RED evidence surfaces as a code-review finding, not an admission failure.

### REQ-6 — Lean artifact lint
- Acceptance: `lint` blocks only on defects the tools need to parse: spec REQ IDs, plan criterion IDs, criterion `Verify` commands, task file paths. All other defects are warnings shown to reviewers.

### REQ-7 — Review loop
- Acceptance: multi-provider review keeps level-based roster and round caps; the orchestrator records rulings in the ledger and applies accepted fixes directly, with no native/rule/fix/evidence frames.
- Acceptance: a finding that recurs after its accepted fix escalates through the Decision Frame, as today.

### REQ-8 — Recovery from status
- Acceptance: tools are idempotent or detect completed effects; `status` summarizes ledger, worktrees and live writers in at most 1 KB, and the orchestrator resumes from it after interruption.

### REQ-9 — Levels as selectors
- Acceptance: `low`…`max` select roster size, review rounds and approval need only. The orchestrator picks and reports the level; `xhigh` and `max` still require user selection.

### REQ-10 — Prose ownership and size
- Acceptance: `SKILL.md` is at most 4 KB and holds invocation, the loop, invariants and links.
- Acceptance: each phase (ask, design, plan, implement, review) has one canonical reference; `decision-frame.md` and `review-rules.md` remain canonical for their topics; each rule has one home.
- Acceptance: prose that exists only for removed mechanics (`change-handling.md`, spec revision quiescence and recovery-owner tables, `implement.md` receipt/amendment contract) is deleted; `self-build.md` keeps only the fixed-controller essentials.

### REQ-11 — Measured success
- Acceptance: driver TS LOC at most 9.6k (−50% from 19.2k); host-facing decision kinds at most 12; zero user gates between plan approval and final report other than waivers, manual completion and intent/dependency/discard escalations.
- Acceptance: a before/after comparison per `docs/dispatch-efficiency-evaluation.md` on 1–2 representative tasks shows correctness no worse (final verification, accepted review findings) and host tokens per verified task not higher. Unavailable fields are reported as `unavailable`.

## Non-goals

- Changing provider adapters' CLI handling beyond what the new tool interface requires.
- Changing the quality bar, review prompt content, or Decision Frame format.
- Compatibility with sessions, journals or frames created by v0.7.x.
- Changing the compatibility aliases beyond pointing at the new contract.
- Making provider delegates writable.

## Constraints

- Provider delegates stay read-only; native writers edit only scoped paths and run no git write commands.
- Zero runtime dependencies; Node type-stripped `.ts`; stack-neutral host behavior from plan-declared commands.
- Cross-platform: macOS, Windows, Linux; Claude Code, Codex, Copilot, OpenCode, Antigravity orchestrators.
- Delivery uses ordered, individually shippable increments; no big-bang rewrite.
- All increments ship together in one release, v0.8.0; no intermediate version.
- Increments run under the fixed-controller self-build procedure: the v0.7.3 controller implements the current-driver gate loosening; later increments use a controller captured from the committed revision that contains it; the new toolkit controls self-build runs only after v0.8.0 is released.
- Repository user-gate boundaries (intent, external dependency or runtime prerequisite, discarded work) remain.
- (assumption) Current frontier models follow lean phase prose reliably enough that removing step-level driver control does not lower delivered correctness; REQ-11's comparison tests this.

## Decisions

### DEC-1 — Architecture
- Context: the frame-per-step state-machine driver dominates tokens, defects and friction.
- Options: A prune in place; B toolkit + ledger; C prose only.
- Choice: B (user).
- Rationale: keeps determinism where it pays (checks, fan-out, worktrees, integration, evidence) and returns sequencing and judgment to the orchestrator; expected net token decrease from fewer round trips and no protocol waste, offset only by a small cached prose prefix.
- Rejected: A keeps the protocol that causes the cost; C loses deterministic verification and audit.

### DEC-2 — Success targets
- Choice: numeric targets plus a before/after comparison run (user).
- Rationale: numbers keep the refactor honest; the comparison checks outcomes did not regress.

### DEC-3 — User gates
- Choice: one approval before code (spec + plan, plus design when present) at medium+; waivers/manual completion and intent/dependency/discard escalations stay user-only; drop production-write authorization and level adoption (user).

### DEC-4 — Mid-run pivots
- Choice: plan and design are orchestrator-owned living documents edited in place with ledger records; spec intent changes need a user quote; no global quiescence (user).
- Rejected: `AMEND`/`REPLACE_PLAN` delta protocol with task accounting.

### DEC-5 — Writer discipline
- Choice: the brief instructs TDD; the driver verifies outcomes; scope overrun is information; missing RED is a review finding (user).
- Rejected: hard admission gates (cause re-dos); dropping TDD guidance (lowers quality).

### DEC-6 — Deliverable shape
- Choice: spec, then design with ordered increments, then increment plans (user).

### DEC-7 — Toolkit scope
- Choice: keep `ask`/`review` fan-out, `verify`, `worktree`, `ledger`, `lint`, `brief`, `report`, `status`; drop machines, hashing, checkpoint/rebind, attempt caps, quiescence, drift gating, level-recommendation machinery (user).

### DEC-8 — Gate enforcement
- Choice: ledger-enforced approvals checked by `brief` and `worktree integrate` (user).
- Rejected: prose-only gates (no structural least privilege).

### DEC-9 — Lint strictness
- Choice: block only parse-critical defects; warn on the rest (user).

### DEC-10 — Review loop
- Choice: keep multi-provider review and round caps; orchestrator rules and fixes directly; recurrence escalates (user).

### DEC-11 — Recovery
- Choice: idempotent tools plus `status`; drop exact journal replay (user).
- Rejected: checkpoint/rebind recovery (high code cost for rare cases).

### DEC-12 — Levels
- Choice: levels select roster, rounds and approval need; orchestrator picks; `xhigh`/`max` need the user (user).

### DEC-13 — Migration
- Choice: increments (1) prose and authority loosening on the current driver, (2) toolkit and ledger built beside it, (3) cutover and deletion; no v0.7.x session compatibility (user).
- Rejected: big-bang rewrite.

### DEC-14 — Prose ownership
- Choice: `SKILL.md` router at most 4 KB; one reference per phase; delete mechanics-only prose; trim `self-build.md` (user).

### DEC-15 — Self-build controller
- Choice: v0.7.3 controller implements the current-driver gate loosening; later increments use a controller captured from the committed revision containing it; everything ships as v0.8.0 with no intermediate version; the new toolkit controls self-build only after v0.8.0 (user, revised 2026-10-21).
- Rejected: v0.7.3 for every increment (the loosening would never run before cutover); an intermediate v0.7.4 release (user: one v0.8.0 release); dropping the loosening increment (later increments keep today's friction).

### DEC-16 — Approval chain for living documents
- Context: REQ-3 gates on approved hashes while REQ-4 allows non-intent edits without re-approval.
- Options: approval chain; re-approval on every hash change.
- Choice: approval chain — one approved hash tuple; recorded non-intent orchestrator edits extend it; intent, dependency or discard edits require new approval (user).
- Rejected: re-approval on every edit (re-creates the stalls DEC-4 removes).

## Discussion Record

- 2026-10-21: User asked how to refactor dispatch for less complexity, brittleness and tokens, and whether the implementation driver is too restrictive for current models.
- 2026-10-21: Round 1 settled DEC-1 (B), DEC-2 (c), DEC-3, DEC-4, DEC-5 (b), DEC-6 (a). User asked whether B raises or lowers tokens; answer: net decrease expected from fewer host round trips and no protocol waste, small increase from cached workflow prose; guarded by REQ-2 and REQ-11.
- 2026-10-21: Round 2 settled DEC-7 through DEC-15 as recommended; migration option (b).
- 2026-10-21: Spec approved ("Approve the spec."). Design review round 1 found REQ-3 conflicting with REQ-4 and the loosening increment unreleased under DEC-15. User chose "Approval chain" (DEC-16) and "Release as v0.7.4" (DEC-15 revised), then: "All these commit/increment will be part of v0.8.0, no version change in between". Controllers after the loosening increment are captured from its committed revision.

## Open Questions

- none
