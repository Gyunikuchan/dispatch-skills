# Complete the development loop and reduce skill overhead

Audience: implementation planners and reviewers.

## Intent and approval

Improve implementation quality with a small post-GREEN refactor inspection inside the existing continuous writer invocation. Reduce duplicated development instructions without adding coordination machinery. The user approved the initial bounded design, requested `/dispatch plan` plus this spec, then requested thorough inclusion of everything discussed. This revision includes the additional proposals as planning scope; implementation is not requested in this turn.

## Requirements

1. The task brief owns the development sequence: inspect, author discriminating tests and record applicable RED, implement, verify GREEN, inspect for useful refactoring, apply warranted simplifications, verify affected behavior after mutation, submit.
2. Refactor inspection is required; refactor edits are conditional. Inspect task-changed code for duplication, unclear names, unnecessary branches, and abstractions introduced by the task. Stop when no warranted in-scope simplification remains. A clean implementation proceeds without forced changes or a mandatory refactor report.
3. Refactoring preserves behavior and remains within authorized task paths and the governing outcome. Adjacent improvements go into existing concerns; scope expansion follows existing rules.
4. Preserve checkpoint replay and submitted-test identity. Production-only cleanup retains the existing RED checkpoint. Necessary test changes after capture follow the existing recheckpoint-and-justify contract and independent baseline replay; refactoring never weakens tests to obtain GREEN. Recapture does not establish historical capture-before-production or a mechanically verified new per-slice cycle.
5. Rerun affected checks after refactor edits: start with criterion-mapped commands and include impacted consumers, broadening when impact is uncertain. Local selection never replaces any required task submission, independent acceptance, integration, final review, or aggregate check. No additional full-suite run is required solely for a no-change inspection.
6. Replace the duplicated development sequence in `skills/dispatch/references/verbs/implement.md` with its existing pointer to the task brief. Retain unique operational facts about continuous invocation, acceptance, integration, and dependent release.
7. Keep total agent-contract wording across the two edited documents net-neutral or lower through pruning and concise wording, measured by whitespace-delimited counts. Regenerate the shipped hash manifest. Preserve the template's section/slot markers and existing source-level isolation/RED obligations checked by retained template guards.

## Small behavioral cycles and verification cadence

Prefer coherent behavioral slices over implementing a large outcome against a large undifferentiated test batch. Preserve meaningful task boundaries: combine tightly coupled changes and avoid creating an agent per test. Writers retain one continuous invocation per task, focused briefs, and full-plan access on demand.

The writer contract requires a test-only checkpoint before production changes; the driver replays it at the task input revision and compares whole submitted test-file blobs. Replay establishes baseline RED and test identity, not historical capture-before-production or a separate pre-production baseline for every internal cycle. Therefore establish required task RED evidence before production, then implement and verify coherent slices using checkpointed tests, with local refactor checks after GREEN. Later test changes retain existing recheckpoint/concerns and baseline replay rules. A true per-cycle checkpoint protocol remains a separate architectural proposal if evidence shows it is needed.

Use affected test commands during development and after cleanup. Run aggregate gates at their existing required completion boundaries, including after review mutations. Preserve driver-owned independent RED/GREEN admission, accumulated integration checks, and revision-bound final evidence; prior writer logs do not replace acceptance. A no-change refactor inspection does not stale evidence or justify a new full-suite run. New defects or scope changes can justify broader checks.

## Brainstorming compression

Compress `.agents/skills/brainstorming/SKILL.md` while preserving its behavioral contract. Make the selected-path checklist authoritative; retain shared-understanding reflection, classification before questions, human approval boundaries, path-specific artifact requirements, architectural written-spec review and plan handoff, escalation on hidden complexity, focused questions, and spec self-review.

Remove the redundant DOT flowchart and repeated red-flag/anti-pattern formulations when their guardrails are already explicit in the authoritative checklist or hard gate. Disclose architectural-only process depth into one local reference if it earns the pointer and preserves conditions for reading it. Keep visual-companion startup instructions in the existing disclosed guide, with the just-in-time offer and explicit acceptance gate retained in the router. Aim for a strictly shorter main contract and no increase in total operational prose across modified/new brainstorming documents; record before/after counts rather than promising a percentage.

Preserve the semantic distinction between recognizing intent and authorizing an artifact. Preserve the architectural terminal handoff to writing-plans; record that skill's absence from this session's available skill catalog as integration friction, not permission to silently substitute another implementation workflow. User-invoked dispatch planning remains authorized for this request.

Before deleting repeated sections, map every unique rule to its surviving owner. Explicitly preserve existing-flow classification, one-way escalation, throwaway spike code requiring a newly classified follow-up before retention, decomposition, stage-specific approvals, the default spec location with user override, the spec commit instruction, written-spec review, writing-plans handoff, and the visual offer as its own message plus per-question decisions. Reading the architectural reference is a prerequisite to architecture-specific work. Resolve links relative to their final owning document, including the existing visual guide. The shipped portable-link test scans only `skills/`; it does not cover this `.agents/skills/` reference, so verify those targets explicitly.

Read the architectural reference immediately after selecting the architectural path, before approach exploration or any other architectural action. Use whitespace-delimited counting for both the main-contract decrease and total operational non-increase across modified/new brainstorming documents.

Apply writing-for-agents when authoring the task instructions and brainstorming documents. Preserve semantics rather than requiring old wording verbatim.

## Measurement and efficiency evaluation

Create a maintainer evaluation note using existing opt-in diagnostics. Collect measured phase/writer and verification durations where available, invocation counts, review/fix rounds, admission retries, scope breaches, and final correctness outcomes. Token usage is provider-scoped covered subtotals; unsupported/native/resumed/truncated usage stays unavailable, never estimated as zero. Distinguish elapsed duration from summed overlapping invocation work. Leave diagnostics default-off and avoid changing local config automatically.

Use matched representative tasks or retained comparable runs, record task size/graph, providers/models/effort, warm/cold tooling, and concurrency as confounders, and state sample size and coverage. Compare instruction word counts immediately; compare tokens/time/repair rates only with adequate actual evidence. No telemetry subsystem, automatic benchmark service, cache warming, adaptive scheduler, or model-routing change is part of this plan. The deliverable is a reproducible evaluation protocol; executing agent workloads and reporting measured savings is a later explicitly scoped exercise.

Each observation records its source artifact, instruction revision/hash, collection method, and coverage. Supplement diagnostic summaries with retained verification/admission journals and adjudicated correctness/scope outcomes where available; other fields remain unavailable. Separate approval wait, active work, elapsed duration, and overlapping invocation work; report comparison uncertainty. Word reduction is a prose-load measurement, not demonstrated token savings.

## Discussion and alternatives

The linked discussion is https://x.com/johncrickett/status/2105769564214890781. Crickett questions agent TDD efficiency; visible replies from Martin emphasize risk reduction, Pocock emphasizes agent attention to tests, and Olson emphasizes feedback signals. These positions motivate measuring total delivery cost, including repairs, rather than treating the number of TDD steps as cost evidence. Only the original post and three publicly visible replies were inspected; no benchmark evidence was present in that view.

Final review alone leaves local simplification implicit. A separate refactor agent/stage adds context setup and coordination and is reserved for explicitly planned structural work. Retain tests with discriminating behavioral signal; skip artificial RED for behavior-preserving work under existing evidence rules. Mandatory cleanup, mandatory prose reports, per-task review waves, and additional barriers are rejected as steady-state overhead without demonstrated value.

## Boundaries and alternatives

The approved approach is a local writer check. Final review alone leaves simplification implicit; a separate stage or agent adds orientation and coordination costs. Neither alternative is selected. No driver state, schema, receipt field, runtime logic, dependency, or mandatory report is introduced.

Runtime task sizing, new diagnostics instrumentation, test-cycle/checkpoint redesign, and unrelated refactoring remain outside scope. Brainstorming compression and measurement protocol documentation are now included by the user's request to cover the full discussion. No savings percentage is claimed.

## Completion and verification

Review the resulting instructions against four scenarios: GREEN with useful cleanup; GREEN with no useful cleanup; an adjacent improvement outside scope; a test requiring changes after RED capture. Each must have a clear outcome under the existing contract.

Include a later behavioral test introduced after production work, a shared helper affecting consumers beyond its immediate criterion, and uncertain impact requiring broader checks. Distinguish allowed checkpoint recapture from proof of a new cycle. Preserve every required submission command independently of local affected-check selection.

Run existing prompt/skill contract tests relevant to the edited templates, `npm run hashes`, `npm test`, and `git diff --check` during implementation. Do not add tests that merely assert prose fragments or claim automated checks prove writer compliance. The implementation plan must identify concrete existing tests and review evidence.

Map focused automated checks to the instruction task's acceptance criteria so its modified test file is checked before admission, rather than relying only on an optional verification section or final aggregate gate. Use separate literal-title selections for the existing task-execution contract test, isolated-worktree/pre-production checkpoint template guard, and rendered brief hash/envelope assembly test. Keep semantic instruction scenarios as review evidence, and final aggregate `npm test` as a final gate.

Also inspect planning/reflection with already-supplied requirements, each of spike/bounded/architectural approval boundaries, hidden-complexity escalation, architectural reference disclosure, and visual-companion acceptance. Confirm the measurement note handles overlapping time and unavailable token usage and requires correctness/repair outcomes before efficiency claims.

## Rollback

Revert edited instruction documents, the adjusted existing test, any newly disclosed brainstorming reference, and the maintainer note; regenerate the hash manifest. Runtime protocol and saved journals remain compatible.
