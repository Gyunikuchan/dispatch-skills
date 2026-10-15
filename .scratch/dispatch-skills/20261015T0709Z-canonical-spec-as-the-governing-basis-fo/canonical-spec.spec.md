# Canonical spec as the governing basis for dispatch work

> **Status:** approved by user — "Approve, use design" (2026-10-15); REQ-12 and DEC-11 added at the user's request during design review
>
> **Level:** high — changes driver contracts, templates, review and write prompts across all verbs

## Intent & Problem

The user wants better implementations and reviews: all agents (orchestrator, design/plan authors, writers, reviewers) must stay aligned on the real objective.

Today, intent is lost or fragmented:

- A spec is optional. Design and plan `Parent:` accept `user request`, so intent often lives only in chat history.
- Reviewers receive `<Requirement>` (the verbatim ask or `--context`), not the discussed intent, decisions, or constraints.
- Design and plan both carry "why" content (Context & Intent, Goals, Alternatives & Decisions; Key Decisions & Context, Open Questions, Out of Scope), which duplicates and drifts.
- Planning skills used alongside dispatch (brainstorming, wayfinder, openspec) write their own specs elsewhere, so duplicate specs appear (example: untracked `docs/superpowers/specs/2026-10-15-publish-git-design.md` in this checkout).
- Writers and code reviewers share `quality-bar.md`; design/plan reviewers get only a host-rule precedence line, and the orchestrator that authors a design or plan never sees the criteria reviewers apply.

Desired outcome: one canonical spec per session records the user's intent, background, problem, requirements, decisions, trade-offs, and discussion. Every later document references it instead of restating it, and every agent reads it.

## Background

- Contract: `skills/dispatch/SKILL.md`; verbs: `skills/dispatch/references/verbs/{design,plan,implement,review}.md`.
- Templates: `skills/dispatch/references/templates/{design,plan,quality-bar,review-prompt*,write-brief*}.md`.
- Parent forms: `PARENT_VALUE` in `skills/dispatch/scripts/domain/plan.ts:312` — `user request`, `` `path` · sha256:<hex> ``, or `` `path` · I<nn> ``.
- Quality bar merge: `assembleTemplate` adds `quality-bar.md` to write briefs (`skills/dispatch/scripts/effects/write-brief.ts:74`) and code review prompts only (`skills/dispatch/scripts/effects/prepare-review.ts:306`).
- Review intent channel: `--context` → `<Requirement>` / `User Focus Areas` (`prepare-review.ts:133`, `:308`).
- Existing IDs: tasks `T<n>`, criteria `SC<n>`, increments `I<nn>`, review findings `R<run>-F<n>` (`FINDING_ID`, `plan.ts`).
- Session layout: deliverables at the session root; prior user preference already puts brainstorming specs in the session folder as `<slug>.spec.md`.

## Requirements

### REQ-1 — Spec is mandatory for all work verbs
`design`, `plan`, objective-driven `implement`, and `review` (all kinds) run against a spec. The `user request` Parent form is removed; a design or standalone plan Parent pins `` `<spec path>` · sha256:<hex> ``; an increment plan pins its design increment, which pins the spec.
- Acceptance: plan and design lint reject `user request` and a missing or hash-mismatched spec pin.
- Acceptance: a run without a supplied spec emits an author-spec await before any design or plan authoring.

### REQ-2 — Spec format: hybrid, lintable
The spec follows a dispatch template combining the GitHub Spec Kit core (intent, scenarios, requirements with acceptance, non-goals) with a MADR-style decision log and a discussion record. Required headings are linted; optional sections may be omitted.
- Acceptance: a spec template exists under `references/templates/`; lint reports missing required sections and malformed IDs.

### REQ-3 — Collision-free IDs
Requirements use `REQ-<n>`; decisions use `DEC-<n>`. Spec success criteria live as acceptance bullets under each REQ (no separate success-criterion ID). No spec ID may collide with `T<n>`, `SC<n>`, `I<nn>`, or `R<n>-F<n>`.
- Acceptance: lint rejects `R<n>`/`SC<n>`-style IDs in the spec; plan criteria and design increments reference `REQ-<n>`.

### REQ-4 — Depth scales with level
`low`: intent & problem, requirements, non-goals, constraints. `medium`+: add background, decision log, discussion record, open questions. The spec must preserve all material points discussed (constraints, considerations, rejected options); summarizing must not drop a decision or constraint.
- Acceptance: the template field notes state per-level required sections; lint enforces them by run level.

### REQ-5 — One canonical spec per session
While dispatch is active, any planning skill's spec or design output goes to `<session>/<slug>.spec.md` in dispatch's format. Discussion from brainstorming or grilling folds into it. A spec already written elsewhere is merged into the session spec and the stray file removed; removing a tracked file requires a user gate.
- Acceptance: the contract states the redirect rule; dispatch edits no `npx skills`-managed skill.

### REQ-6 — Spec approval gate
At `medium`+, the user approves the spec, bound to its sha256, before design or plan authoring. At `low` the run proceeds and the handoff shows the spec.
- Acceptance: the driver records approval with a user quote and the approved hash; authoring does not start at `medium`+ without it.

### REQ-7 — Intent-first design/plan review
Design and plan reviewers receive the spec as the governing intent and check, first, that every REQ is met and no DEC is contradicted, and that no premise is flawed. A new top-priority `intent-gap` tag reports unmet intent or spec gaps (ambiguity, contradiction, missing constraint); spec-located findings are allowed. The orchestrator rules each intent finding first: `accept`/`reject` when the spec or a DEC settles it, `needs-user` otherwise. A user answer that changes intent becomes a new DEC; the spec hash changes, the Parent pin goes stale, and the design or plan is re-authored (redesign path). No separate spec review stage.
- Acceptance: design and plan review prompts attach the spec and list `intent-gap` first; an existing `spec-gap` (test-spec) tag stays distinct.
- Acceptance: a stale spec pin blocks further review and authoring until re-authored.

### REQ-8 — Layered documents without duplication
- Spec (why/what): intent & problem, background, REQs, non-goals, constraints, DEC log (intent-level and every user-made decision), discussion record, open questions.
- Design (strategy): approach with REQ → component mapping, architecture & boundaries, architectural decisions, risks/ops, increment graph and details. Drops Context & Intent, Goals & Requirements, and user-intent decisions.
- Plan (tactics): code background, tactical decisions, Task Map, changes, criteria tagged `Satisfies: REQ-<n>`, verification, rollback. Drops Key Decisions & Context duplicates, non-local Out of Scope, and User Review Required (moves to spec open questions).
- Each layer references the layer above by ID; no layer restates another's content. Authoring a design or plan never rewrites the spec.
- Acceptance: design and plan templates and lint match this split; every plan criterion traces to at least one REQ.

### REQ-9 — Writers read the whole spec
Native writers read the whole spec plus their plan range. Reviewers of every kind read the whole spec.
- Acceptance: write briefs and review prompts attach the spec path and hash.

### REQ-10 — One quality bar, kind sections
`quality-bar.md` holds a `shared` section (host-rule precedence, simplicity order, reuse search, spec alignment) and `code`, `plan`, `design` sections. Consumers get `shared` plus their kind: writers and code reviewers get `code`; plan author and reviewers get `plan` and `code`; design author and reviewers get `design`. Criteria move out of the reviewer prompts' `against`/`tags` into the bar; prompts keep only the tag taxonomy and reference the bar. The orchestrator reads the same sections when authoring.
- Acceptance: each criterion has one home; prompt assembly merges the specified sections per consumer.

### REQ-11 — Standalone review always has a spec
Standalone `review` reuses the governing spec (session spec, or the reviewed plan's Parent). Otherwise the orchestrator authors one from chat history and the diff, marking inferred items `(inferred)` and recording user decisions only with evidence. The spec replaces `--context` as the intent channel.
- Acceptance: `--context` is removed; review start accepts a spec path or emits the author-spec await.

### REQ-12 — ADRs match the delivered state
Existing ADRs under `docs/decisions/` that this work changes are updated or rewritten to describe the delivered state. A new ADR records the introduction of the canonical spec. An ADR may be split when that makes it clearer.
- Acceptance: a new ADR covers the spec (format, IDs, stage, approval, resolution, revision, redirect, intent-first review).
- Acceptance: each affected ADR (at least 0003 session artifacts, 0006 state machine, 0007 review context and intent, 0008 task-based plans, 0009 shared quality bar) states the delivered behavior with no contradiction of this spec; superseded decisions are marked and linked.
- Acceptance: ADR updates land after the behavior they describe.

## Non-goals

- Editing third-party skills managed by `npx skills` (`skills-lock.json`).
- Adopting OpenSpec's committed repository spec tree or any convention written into host repositories.
- A separate spec review stage by delegates.
- Backward compatibility with `user request` Parents, `--context`, or old template sections (drop legacy by default).

## Constraints

- Follow the repository guide: lean context, single-sourced rules, deterministic enforcement over prose, proportional assurance, portability across hosts.
- Agent-facing prose follows ASD-STE100 and `writing-for-agents`.
- Hash-tracked skill files require `npm run hashes`, then `npm test`.
- The `ask` verb is unchanged.

## Decisions

### DEC-1 — Hybrid spec format (user)
- Context: no single popular standard covers intent, requirements, decisions, and discussion.
- Options: Spec Kit as-is; EARS (Kiro); OpenSpec; ADR/MADR alone; free form; hybrid.
- Choice: hybrid — Spec Kit core plus MADR-style decision log plus discussion record.
- Rationale: borrows popular formats; keeps everything the user asked to record; stable IDs give traceability; required headings stay lintable.
- Rejected: Spec Kit and EARS lack a decision/discussion home; OpenSpec assumes a host-repo spec tree; ADR covers decisions only; free form gives nothing to lint or trace.

### DEC-2 — `REQ-<n>` and `DEC-<n>` IDs (user concern, orchestrator choice)
- Context: the user flagged that `R<n>` could be confused with review IDs. Findings use `R<run>-F<n>`; Spec Kit's `SC-001` would collide with plan `SC<n>`.
- Choice: `REQ-<n>`, `DEC-<n>`; acceptance bullets under each REQ instead of separate success-criterion IDs.

### DEC-3 — Spec always required; depth scales by level (user)
- Rejected: `medium`+ only (loses intent on unreviewed tasks); design only (standalone plans stay unaligned).

### DEC-4 — Redirect and adopt other skills' specs (user)
- Rejected: exception for committed host spec systems such as OpenSpec (two files split ownership); link-only (violates one canonical spec).

### DEC-5 — Spec review folded into design/plan review (user)
- Rationale: no extra round; gaps surface with a concrete design in view.
- Rejected: separate spec review at `high`+ (extra round and prompts); user confirmation only (no independent intent check).

### DEC-6 — Layered decision homes (user)
- Choice: spec holds intent-level and user-made decisions; design holds architectural decisions; plan holds tactical decisions.
- Rationale: authoring never rewrites the spec, so Parent pins do not churn.
- Rejected: one decision log in the spec (hash churn during authoring).

### DEC-7 — Writers read the whole spec (user)
- Rejected: core sections only; linked REQs only. The user preferred full alignment over context savings.

### DEC-8 — Standalone review always gets a spec (user)
- Rejected: author only with chat evidence (two review paths); never author (loses chat intent).

### DEC-9 — One quality bar file with kind sections (user tentative yes; structure by orchestrator)
- Context: the user asked whether design/plan criteria differ enough to warrant a separate document that the authoring orchestrator also reads.
- Choice: one file, `shared` plus `code`/`plan`/`design` sections; criteria move from reviewer prompts into the bar.
- Rationale: the current bar is code-centric; design/plan criteria live only in reviewer prompts, so authors never see them. One file keeps the shared core single-sourced.
- Rejected: separate artifact-bar file (duplicates the shared core).

### DEC-10 — Spec approval at `medium`+ (user)
- Rejected: always (prompt cost at `low`); never gated (intent errors surface late).

### DEC-11 — ADR updates are in scope (user)
- Context: the user added this during design review: "Update/re-write existing ADRs to be match the to-be state (can even consider splitting them up if it helps with clarity), create a new ADR on introducing spec".
- Choice: one docs increment after the behavior lands. New ADR 0010 for the spec. Plan-document layering splits out of ADR 0008 into ADR 0011 (layered spec, design, and plan documents); 0008 keeps tasks and parallel writers. ADRs 0003, 0006, 0007, and 0009 are updated in place, with superseded decisions marked. The ADR set is orchestrator choice within the user's split allowance.
- Rejected: folding the layering into ADR 0010 (one ADR would mix artifact introduction with document structure); docs before code (ADRs would describe behavior that does not exist yet).

## Discussion Record

- The user framed the goal as improving implementations and reviews by formalizing the spec as the basis of all later work; implementers and reviewers must read it to stay aligned on the real objective.
- The user stressed thoroughness: the spec must summarize everything discussed with its considerations and constraints and must not lose important details (REQ-4).
- The user asked whether a popular spec standard exists. The orchestrator surveyed Spec Kit, Kiro/EARS, OpenSpec, and ADR/MADR; none records discussion and decisions together, so the user chose the hybrid (DEC-1).
- The user proposed design = strategy, plan = tactics, with the spec beneath both; the orchestrator mapped that onto Spec Kit's spec → plan → tasks layering (REQ-8).
- The user wanted design/plan reviews to prioritize intent fit, to surface gaps and new questions, and possibly to trigger a redesign, with the orchestrator adjudicating before involving the user (REQ-7).
- For standalone code review, the user proposed that the orchestrator write the spec from earlier chat history when none exists (REQ-11).

## Open Questions

None. Resolved: delivery uses `design` (increments) at level `high` (user: "Approve, use design").
