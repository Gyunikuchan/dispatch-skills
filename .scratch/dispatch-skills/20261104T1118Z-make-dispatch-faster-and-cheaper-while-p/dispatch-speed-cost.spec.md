# Dispatch speed and cost streamlining

> **Status:** confirmed by user — "Confirm" (2026-11-04); revised by user — "Agree to both" (2026-11-04)

## At a Glance
- **What:** Cut Dispatch token use, launches and user round trips without lowering outcome quality.
- **How it works:** Remove duplicate prose, redundant reads and one avoidable launch and exchange; keep every quality lever.

## Intent & Problem
The user runs Dispatch for planning, review and implementation and wants it faster and cheaper while keeping current outcome quality. Important rules and behaviour must not be lost silently; the user rules on any removal or change through the Decision Frame.

## Background
Grounding (`dispatch-speed-cost.spec.context.md`) measured these cost sources at commit `8c9729a`:

| Source | Current cost | Evidence |
| --- | --- | --- |
| Rules restated in 2–4 references (round cap and ceiling, test-cleanup commit rules, whole-spec read, writer and Git write limits) | Orchestrator rereads each copy per run | `references/review-rules.md`, `references/decision-frame.md`, `references/toolkit.md`, `references/verbs/implement.md` |
| Review prompts inline selected quality-bar sections and also link the whole `quality-bar.md` (13,130 B) | A possible second 13 KB read per reviewer per round | `references/templates/review-prompt-code.md:35`, `review-prompt-plan.md:25`, `review-prompt-design.md:25` |
| Diagnostics retro merge launches a utility subagent to merge orchestrator notes into `retro.json` | One cold launch per verb handoff | `references/diagnostics.md:3` |
| Grilling ends with a shared-understanding check, then the spec Confirm repeats it | One extra user round trip per spec | `references/spec-stage.md` step 4 |

Tool refusals already enforce several restated gates (`scripts/toolkit/integrate.ts:68`, `scripts/toolkit/review.ts:243-249`, `scripts/toolkit/report.ts:343-353`). No recorded per-stage token or timing data exists.

## Requirements
### REQ-1 — One canonical home per rule
Each rule restated across Dispatch references keeps exactly one canonical home; other copies become links. Prose that restates a tool-enforced gate keeps the refusal name and a link, not the full rule.
- Acceptance: the plan lists every deleted or merged sentence with its surviving canonical home or enforcing code, and plan review checks that list.
- Acceptance: no rule without another home and without enforcing code is deleted unless the user rules on it individually.

### REQ-2 — One exchange for grilling end and spec confirmation
WHEN grilling has no open decision, the orchestrator SHALL author and lint the spec, then present it in the final shared-understanding exchange with its path, stated and assumed intent, and the `plan` or `design` recommendation; the user's reply is the `confirm` record with the actual quote and spec hash.
- Acceptance: `references/spec-stage.md` describes one combined exchange when grilling runs, and no separate Confirm exchange after it.
- Acceptance: a reply that opens or changes a decision resumes grilling for that branch and revises the spec under the revision protocol before confirmation.
- Acceptance: the fallback without `grilling` keeps its current single Confirm exchange.

### REQ-3 — Inline diagnostics merge
The orchestrator merges its own retro notes into `<session>/.state/retro.json` without a utility launch.
- Acceptance: `references/diagnostics.md` no longer launches a utility subagent to merge notes; item schema, limits, exclusions and the non-gate rule stay.
- Acceptance: investigation of logs, chat history or other raw sources for retro evidence still follows the context guard, which delegates it to an explorer above its threshold.

### REQ-4 — No duplicate quality-bar read in review prompts
Review prompts direct reviewers to the inlined Quality section, not to the whole `quality-bar.md`.
- Acceptance: rendered code, plan and design review prompts contain no link to `quality-bar.md` for judging criteria, and still inline the same selected sections.

### REQ-5 — Measured byte evidence
The walkthrough reports before and after UTF-8 sizes for each changed reference loaded by the orchestrator, rendered golden review prompts and a rendered writer brief, plus mandated launch and exchange counts per verb.
- Acceptance: the walkthrough carries a before/after table from `scripts/brief-size.ts` or `wc -c` output stored in `.scratch/`.

## Non-goals
- Changing the scope-round explorer (DEC-2).
- Self-grounding new specs without an explorer (DEC-3).
- Changing review voices, rounds, narrowing, the writer quality payload, whole-spec reads, test cleanup, plan review or approval gates (DEC-8).
- Compacting the Visual-aid bar in reviewer prompts (DEC-10).
- Fixing the per-file test timing budget failure (DEC-9).
- Live end-to-end benchmark runs (DEC-1).

## Constraints
- Self-build: run Dispatch tool calls through the frozen controller at `8c9729a`; verify the candidate with its own `npm test`, `npm run test:e2e` and plan checks.
- `skills/dispatch/SKILL.md` stays within its 7,424-byte budget; the driver TypeScript stays within its 12,039-line budget (`tests/integration/structural-targets.test.ts:16-28`).
- Hash-tracked skill edits regenerate `skills/dispatch/skill-hashes.json` with `npm run hashes`; changed golden fixtures in `tests/fixtures/review-prompt-golden/` are updated to the rendered output, which the exact-equality golden test verifies.
- Update ADRs whose recorded decision changes; ADRs record current state only.
- Follow AGENTS.md documentation standards and `.agents/skills/writing-for-agents/SKILL.md` for agent-facing prose; vendored `.agents/skills/` stay unedited.
- (assumption) Byte size is the cost proxy; the active `config.local.jsonc` keeps diagnostics on so later runs measure tokens.

## Decisions
### DEC-1 — Byte-based evidence, no live benchmark
- Context: No per-stage token or timing data exists.
- Options:
  - Byte and launch-count evidence plus test suites; cheap and deterministic.
  - Live Dispatch benchmark runs; measured tokens but several full runs.
- Choice: byte and launch-count evidence (user).
- User quote: "Yes to all except"
- Rationale: Deterministic; diagnostics stay on for later measurement.
- Rejected: live benchmark, because its cost exceeds the change.

### DEC-2 — Keep the scope-round explorer
- Context: The scope round launches a second map explorer before each plan or design.
- Options:
  - Make it conditional on the context guard; saves about one launch and 6 minutes per plan.
  - Keep it mandatory; a second grounding pass for correctness and quality.
- Choice: keep it mandatory (user).
- User quote: "Q2: no, i want a 2nd round for correctness and quality"
- Rationale: The second pass protects plan correctness.
- Rejected: conditional scope round.

### DEC-3 — Keep explorer grounding for every new spec
- Context: Proposal to self-ground small requests inline under the context guard.
- Options:
  - Self-ground below the context-guard threshold.
  - Keep explorer grounding for every new spec.
- Choice: keep explorer grounding (user).
- User quote: "Q3: without the exploration, would the orchestrator even know the true problem space and what could be missed? does it even have the information to make that judgement?"
- Rationale: Before grounding the orchestrator cannot know the problem size, so the threshold judgement itself needs grounding.
- Rejected: inline self-grounding for small requests.

### DEC-4 — Merge the shared-understanding check and spec Confirm
- Context: Grilling ends with a shared-understanding check, and spec Confirm repeats it.
- Options:
  - Keep two exchanges.
  - Author the spec only after the grilling frontier is empty and confirm it in one exchange.
- Choice: one exchange after the frontier is empty (user).
- User quote: "Yes"
- Rationale: Saves one user round trip; grilling depth is unchanged.
- Rejected: two exchanges; authoring the spec before grilling settles decisions.

### DEC-5 — Consolidate duplicated and tool-enforced prose
- Context: Rules are restated in 2–4 references; tools enforce several.
- Options:
  - Keep copies.
  - One canonical home per rule; copies become links; individual user rulings for rules with no other home.
- Choice: consolidate (user).
- User quote: "Yes to all except"
- Rationale: Fewer orchestrator bytes with every rule kept once.
- Rejected: keeping copies.

### DEC-6 — Inline diagnostics merge when it is only writing
- Context: A utility subagent merges orchestrator notes into `retro.json`.
- Options:
  - Keep the utility launch.
  - Merge inline; keep investigation delegated.
- Choice: merge inline because the subagent only writes; investigation stays delegated (user).
- User quote: "Q6: if it's just about writing then yes; but if the subagent was being used to investigate e.g. the logs and chat history, then no"
- Rationale: `references/diagnostics.md:3` gives the subagent orchestrator notes only. Cost is about neutral (host output tokens against a cheap cold start); inline is faster with one fewer launch (DEC-11).
- Rejected: keeping a launch for a write-only merge.

### DEC-7 — Trim reviewer prompt payload
- Context: Prompts inline selected criteria and also link the whole bar.
- Options:
  - Keep current payload.
  - Point to the inline Quality section.
- Choice: point to the inline section (user); the visual-aid part is withdrawn under DEC-10.
- User quote: "Yes to all except"
- Rationale: Removes a possible 13 KB second read per reviewer per round with no rule lost.
- Rejected: current payload.

### DEC-8 — Keep quality levers unchanged
- Context: Review roster and rounds, writer payload, whole-spec reads, test cleanup, plan review and approval carry quality.
- Options:
  - Trim them for cost.
  - Keep them; users tune config per repository.
- Choice: keep them (user).
- User quote: "Yes to all except"
- Rationale: Trimming trades quality for cost directly.
- Rejected: trimming quality levers.

### DEC-9 — Known baseline timing failure
- Context: On the unchanged checkout all 762 tests pass, but `npm test` exits 1 because 6 files exceed the 1.00 s per-file budget.
- Options:
  - Fix the timing budget in scope.
  - Retain it as a known baseline failure and judge final `npm test` against it.
- Choice: retain as known baseline failure (user).
- User quote: "Yes to all except"
- Rationale: Likely container load; outside this objective.
- Rejected: in-scope timing fix.

### DEC-10 — Keep the full Visual-aid bar in reviewer prompts
- Context: Scope grounding measured the bar at 1,691 B in the plan golden prompt (`tests/fixtures/review-prompt-golden/plan.md:56-73`), not about 5.6 KB; ADR 0009 forbids separate criteria copies.
- Options:
  - Compact reviewer checklist; about 1 KB saved per reviewer per round, with an ADR 0009 exception.
  - Keep the full bar.
- Choice: keep the full bar (user).
- User quote: "Agree to both"
- Rationale: The saving does not justify an ADR exception and readability risk.
- Rejected: compact checklist.

### DEC-11 — Retro merge rationale and ADR 0015
- Context: ADR 0015 records the utility merge as moving formatting cost off the host model.
- Options:
  - Keep the utility merge.
  - Merge inline and update ADR 0015 to the speed and launch-count rationale.
- Choice: merge inline and update ADR 0015 (user).
- User quote: "Agree to both"
- Rationale: Cost is about neutral; inline is faster with one fewer launch.
- Rejected: keeping the utility merge.

## Discussion Record
- 2026-11-04: The user asked whether the spec would be written before grilling settles intent; the orchestrator clarified that the spec is authored only after the frontier is empty (DEC-4).

## Open Questions
- none
