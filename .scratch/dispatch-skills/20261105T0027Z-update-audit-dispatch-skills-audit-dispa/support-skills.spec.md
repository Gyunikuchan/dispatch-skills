# Align Dispatch support skills with current Dispatch

> **Status:** draft

## At a Glance
- **What:** Update the maintainer skills `audit-dispatch-skills`, `audit-dispatch-skills-fix` and `optimise-tests` so they match current Dispatch, audit agent-skill authoring quality (rule contradictions, duplicate rule homes, progressive disclosure, streamlined flow), and run their subagents on the models Dispatch configures instead of the host model.
- **How it works:** Each skill starts a Dispatch session, reads `doctor run` and launches its subagents on the resolved `utility` or `writers` entry; the audit gains an authoring scope; the fix skill delivers batches through `/dispatch implement` under self-build.

| Role | Today | After |
|---|---|---|
| Audit scope auditors (6 + new authoring scope) | `general-purpose`, host model | `writers` entry at `medium` |
| Audit lead verification reading, fix triage reading | lead context | `utility` explorers returning cited claims |
| optimise-tests unit writers | `general-purpose`, host model | `utility` entry |
| Fix batch implementation | lead edits directly | `/dispatch implement` under self-build |

## Intent & Problem
- Dispatch changed heavily on `v0.8.3` (subagent routing, spec stage, grounding, toolkit actions); the three skills still describe older Dispatch.
- They launch every subagent on the expensive host model.
- The audit misses contradictory or duplicated rules and other skill-authoring defects, the main failure class of an instruction-only product.
- Outcome: current, cheaper skills that catch authoring defects.

## Background
- Scope auditors and optimise-tests writers launch as `general-purpose` agents with no model or effort (`.agents/skills/audit-dispatch-skills/SKILL.md`, `.agents/skills/optimise-tests/SKILL.md`). Dispatch routes test cleanup to a utility subagent and research to explorers (`skills/dispatch/SKILL.md` Routing; ADR 0015).
- `doctor run` reports `writers`, `explorers` and `utility` per platform but requires a session manifest (`skills/dispatch/scripts/toolkit/cli.ts`); `session init --objective <o> --host <platform>` creates one.
- The audit walkthrough brief forbids `dispatch.ts start`/`send`, which no longer exist (`.agents/skills/audit-dispatch-skills/references/walkthrough.md`).
- The scenario catalog has scopes ask, design, plan, review, implement and shared only; no scenario covers the spec stage, grounding, or explorer/utility routing.
- No scope, criterion or calibration case targets rule contradictions, duplicate rule homes or `writing-for-agents` conformance; `scripts/check-terms.ts` and `scripts/generate-hashes.ts` do not scan `.agents/`.
- The fix skill forbids `/dispatch implement` because a batch can modify the active flow; the self-build procedure (`skills/dispatch/references/self-build.md`, required by `AGENTS.md`) runs a frozen controller copy, which removes that hazard.
- Tests pin these skills: `tests/tooling/audit-*.test.ts`, `tests/tooling/optimise-tests.test.ts`, `tests/e2e/audit-*.test.ts`.

## Requirements
### REQ-1 — Resolve subagent models from Dispatch
Each of the three skills obtains subagent models and efforts from Dispatch's `doctor run` result in a Dispatch session the skill creates or reuses, not from the host default and not by parsing Dispatch config itself.
- Acceptance: each `SKILL.md` names `session init` and `doctor run` through `<skills-dir>/dispatch/scripts/dispatch.ts` and states which doctor field (`utility` or `writers` at a level) each subagent role uses.
- Acceptance: no support skill script reads `config.local.jsonc` or `config.sample.jsonc` model fields directly for subagent launch.

### REQ-2 — Role-to-tier mapping
Subagent roles use these tiers: audit scope auditors use `writers` at `medium`; optimise-tests unit writers use `utility`; heavy reading during audit lead verification and fix triage goes to `utility` explorers that return distilled, cited claims while the lead keeps rulings.
- Acceptance: each launch brief or host table names the tier, model and effort source for its role.
- Acceptance: when the host cannot launch the resolved entry, the skill treats it as a blocker as Dispatch routing does; it works inline only when no entry resolves.

### REQ-3 — Authoring-quality audit scope
The audit adds a scope that sweeps agent-facing prose (`skills/dispatch/**`, `AGENTS.md`, and the support skills) for rule contradictions, one rule kept in two homes, `writing-for-agents` violations, and other skill-authoring optimizations such as progressive disclosure and streamlined flow.
- Acceptance: `references/scenarios.json` and the scope brief define the new scope with its axes; contradictions and duplicate rule homes are defects that cite both conflicting locations; disclosure and flow improvements are opportunities.
- Acceptance: the calibration fixture gains at least one seeded-contradiction defect case and one control case, and calibration tests pass.

### REQ-4 — Current Dispatch coverage
The audit scenario catalog and briefs match current Dispatch.
- Acceptance: scenarios cover the spec stage (grounding, critique, grilling, confirm) and explorer/utility routing within existing scopes.
- Acceptance: no support skill instruction or reference names a Dispatch command, file, anchor or term absent at HEAD; the `start`/`send` reference names current toolkit actions. Calibration fixture excerpts pinned to historical commits are exempt.

### REQ-5 — Fix skill delivers through Dispatch implement
`audit-dispatch-skills-fix` delivers each batch with `/dispatch implement` under the fixed-controller self-build procedure instead of direct lead implementation.
- Acceptance: the skill no longer forbids Dispatch implement; it names self-build and maps its `planned`, `plan-reviewed`, `implemented` and `code-reviewed` checkpoints to Dispatch implement evidence.
- Acceptance: `status.mjs` checkpoint handling and its tests stay consistent with the new flow.

### REQ-6 — Green verification
- Acceptance: `npm test` passes after the last change; `npm run test:e2e` passes when audit probe or subprocess behavior changes.

## Non-goals
- Changing Dispatch toolkit code, config schema or doctor behavior.
- A deterministic contradiction-detection script.
- Changing provider probe behavior beyond stale-name fixes.
- Editing vendored skills (`grilling`, `writing-for-agents`, `brainstorming`, `retro`).

## Constraints
- Support skills stay standalone maintainer skills in `.agents/skills/`; new subagent-model resolution depends on sibling `dispatch` only through its public CLI. The provider probe's existing Dispatch library imports stay unchanged (see Non-goals).
- Keep Dispatch's read-only and write-scope boundaries: auditors and explorers write only their assigned findings or map files; utility writers edit only assigned paths and run no Git write commands.
- Follow `writing-for-agents` and AGENTS.md documentation standards; keep each rule in one home and link Dispatch rules instead of restating them.
- (assumption) The authoring scope runs on the same `writers` tier as the other auditors and shares the existing finding format and budgets.
- (assumption) The Dispatch session a support skill creates lives under the default `.scratch/dispatch-skills/` root and is left for the user like other sessions.
- (assumption) Fix-batch approval gates follow Dispatch implement's own level rules; the fix skill adds none.

## Decisions
### DEC-1 — Model resolution source
- Context: support skills need Dispatch's configured models without duplicating resolution.
- Options:
  - Start a Dispatch session and read `doctor run` — public seam; one session folder per run.
  - Add a sessionless doctor mode — edits hash-tracked Dispatch code.
  - Parse Dispatch config in support scripts — duplicates resolution logic.
- Choice: start a session and read `doctor run` (user)
- User quote: "yes to all"
- Rationale: reuses the public CLI without touching Dispatch.
- Rejected: sessionless doctor (scope creep into Dispatch); direct config parsing (parallel implementation).

### DEC-2 — Role tiers
- Context: cheaper models must not degrade defect judgment.
- Options:
  - Auditors on `writers` medium, optimise writers and research explorers on `utility`.
  - Everything on `utility`.
- Choice: auditors on `writers` medium; optimise writers and research explorers on `utility` (user)
- User quote: "yes to all"
- Rationale: auditing needs judgment; test cleanup matches Dispatch routing; calibration can later measure a `utility` auditor arm.
- Rejected: all-`utility` (unmeasured quality loss on defect judgment).

### DEC-3 — Fix delivery path
- Context: the ban on Dispatch implement predates self-build.
- Options:
  - Keep direct implementation.
  - Use `/dispatch implement` under self-build.
- Choice: `/dispatch implement` under self-build (user)
- User quote: "yes to all"
- Rationale: frozen controller removes the self-modification hazard and gains configured writers and code-review voices.
- Rejected: direct implementation (host-model cost, duplicate review wiring).

### DEC-4 — Contradiction and authoring detection
- Context: scenario traces miss cross-file rule conflicts.
- Options:
  - New authoring scope plus calibration cases.
  - Contradiction axis inside existing walkthroughs only.
  - Deterministic script.
- Choice: new authoring scope with calibration cases, also auditing skill-authoring optimizations such as progressive disclosure and streamlined flow (user)
- User quote: "Q4: should also audit for other skills related optimizations (e.g. progressive disclosure, streamlined flow)"
- Rationale: semantic conflicts need judgment across files.
- Rejected: walkthrough-only axis (misses untraced files); script (noise).

### DEC-5 — Current-Dispatch scenarios
- Context: the catalog lacks spec-stage, grounding and routing coverage and names removed commands.
- Options:
  - Add scenarios to existing `shared` and `plan` scopes and fix stale names.
  - Add a dedicated scope.
- Choice: add to existing scopes and fix stale names (user)
- User quote: "yes to all"
- Rationale: smallest change; the authoring scope already adds one auditor.
- Rejected: dedicated scope (extra auditor cost).

## Discussion Record
None.

## Open Questions
- none
