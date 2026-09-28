# Artifact readability: design, plan, walkthrough

> **TL;DR:** Make dispatch's design, plan, and walkthrough markdown readable by humans while remaining sufficient context for fresh reviewer/implementer agents, so one artifact serves both and no extra summaries are generated.
> **Parent:** user request (brainstorming, 2026-09-28)
> **Risk:** med — touches parser-owned sections, resume state, and review projections.

## Context & Intent

Today's artifacts mix human prose with machine state and generated filler:

- Walkthroughs embed a ~100 KB `## Ordinary execution evidence` JSON block (`driver/implement-state.mjs:143`) that only humans see; review prep already strips it (`review/preparation.mjs:335`). It appears inconsistently (skipped after checkpoint and in plan-less review).
- Review logs render `Sources:` source maps and `application:` records as inline JSON (`review/resolution-log.mjs:226,323`); duplicate findings (same bug from several reviewers) appear as separate entries.
- Changes Made bullets carry hard-coded filler: `— Approved implementation scope.` (`driver/baseline-phase.mjs:28`), `— Included in the selected review scope.` (`review/prepare-code.mjs:253`). Plans sometimes carry `Changes: same`.
- Walkthrough title and TL;DR repeat the same objective string; nothing states the delivered behaviour.
- Verification & Validation and Outcome Traceability restate the same per-SC facts (RED matrix, manual filler, traceability row).
- Plan-less walkthroughs (`/dispatch-code-review` with no prior artifacts) carry no ask, decisions, or scope, so reviewers cannot judge intent.
- No artifact states its parent (spec, design, plan) in the summary box.

Success: a human can read any artifact top-to-bottom without skipping machine data or filler; a fresh agent has enough context to review or implement from the artifact alone; output-token cost does not rise materially.

## Decisions

- Machine state placement (user): large run evidence moves to a sidecar under `.state/`; small per-finding records (source maps, `application:`) stay in the file as parser-read HTML comments. Rejected: all-sidecar (loses self-contained review log across handoff move); all-comment (raw file stays ~100 KB for agents reading it).
- Keep the hash frontmatter as-is (user). Rejected: moving checkpoint data out (costly integrity/recovery rework).
- Changes Made lists every file changed in the session, not only planned files (user); reviewers need the full set.
- Per-file notes come from the writer, not the orchestrator (user concern: orchestrator token cost). Rejected: orchestrator-authored notes.
- Decisions made by the user are tagged `(user)` in decision sections (user). Reviewers may challenge untagged author choices but treat `(user)` entries as settled.
- Chat decisions go in each artifact's decision section, not in context/intent sections, to keep one home per fact.
- Background in plans is present when there is background to give, independent of Risk (user).
- Parent may be a design, an externally created spec, or the user request (user).
- Specs created while using dispatch live in the session folder as `<slug>.spec.md` (user).

## Shared rules (all three artifacts)

1. Summary box includes `**Parent:**` — path (design, spec, or plan) or `user request`. External specs record repo-relative path plus `sha256` content hash for drift detection; dispatch never binds or rewrites them.
2. Sections with nothing to say are omitted, except parser-required sections, which keep a single `None.`.
3. No visible JSON: machine data lives in a `.state/` sidecar or in `<!-- -->` comments.
4. Filler notes are lint errors at authoring time: empty, `same`, `see above`, `unchanged`, `Approved implementation scope`, `Included in the selected review scope`, or a note identical to another file's note.
5. Decision sections tag user-made decisions `(user)`.

## Walkthrough

```markdown
# <Goal>                                   ← plan title; plan-less: the ask
> **Delivered:** <writer envelope summary; plan-less: orchestrator 1–2 lines>
> **Parent:** <plan path | user request>  **Status:** n/m SC passing  **Deviations:** none

## Context                                 ← plan-less only; omitted when a parent plan exists
- **Ask:** <original request>
- **Decisions:** <agreed in chat, rejected alternatives; (user) tags>
- **Assumptions:** <defaults chosen without confirmation>
- **Out of scope:** <non-goals, deferred items>
- **Focus:** <areas needing scrutiny, known risks>   ← optional; empty bullets omitted

## Changes Made                            ← every session-changed file
- **[MODIFY]** `<path>` — <note>

## Verification                            ← replaces V&V + Outcome Traceability
| SC | Outcome | Evidence |
| SC1 | <observable outcome> | red→green `<cmd>` exit 0 |
Final gate: `npm test` exit 0 — 1923 pass, 6 skipped.

## Deviations & Follow-ups                 ← merged; None. when both empty
## Review Findings & Resolutions           ← shared readable renderer
```

- Title/Delivered differ by construction: goal vs outcome.
- Change note precedence: writer envelope `files[].note` → plan Proposed Changes line for that path → bare path with `+N −M`. Files touched by review fixes: `fixes R2-F001`. Never filler.
- Writer envelope gains optional `files: [{path, note}]`; writer brief asks for one short note per changed file.
- Removed: RED matrix table (folded into Evidence as `red→green`), manual-verification filler, `## Ordinary execution evidence` block.
- Status semantics unchanged; plan-less Status `n/a` and Verification shows the final gate only.

## Plan

```markdown
# <Goal>
> **TL;DR:** <problem and outcome>
> **Parent:** <design path · I<nn> | spec path | user request>  **Decide:** …  **Risk:** …  **Scope:** …

## Background                    ← optional; current behaviour with file:line pointers
## Key Decisions & Context       ← (user) tags
## User Review Required | Open Questions & Assumptions
## Technical-Design Traceability ← increment plans only; path moves to Parent; revision/contract stay
## Success Criteria              ← unchanged (driver-parsed)
## Proposed Changes              ← unchanged shape; filler lint
## Rollback & Blast Radius
## Verification Plan             ← Automated Tests excludes commands already in SC Verify
## Review Findings & Resolutions ← shared readable renderer
## Out of Scope
```

## Design

```markdown
# <Technical design>
> **TL;DR:** …
> **Parent:** <spec path | user request>  **Decide:** …  **Risk:** …  **Increments:** N
## Context & Intent | Goals & Requirements | Architecture & Boundaries
## Alternatives & Decisions      ← (user) tags
## Risks, Security & Operations | Increment Dependency Graph | Increment Details   ← filler lint on detail fields
## Final Integration | Execution Status
## Review Findings & Resolutions ← shared readable renderer
```

## Readable review log

Per round:

```markdown
### Round 2 — 2026-09-28
<!-- dispatch-sources {…source map JSON…} -->
Reviewers: agy gemini-3.7-flash (medium), codex gpt-6-sol (medium), opencode muse-spark-1.3 (xhigh)
Failed: <only when non-empty>
- **[Accepted] [MUST]** R2-F001 (+R2-F002, R2-F003) `plan-phase.mjs:54` — correctness: <claim> → <resolution>
  Applied → plan-phase.mjs, ordinary-resume-bound.test.mjs · verified by `<cmd>`
  <!-- dispatch-application {…} -->
```

- A round with no findings renders `Clean — no findings.`
- Grouping: findings with the same path/line and resolution collapse under the first ID; all IDs and sources stay listed. Settlement and consensus still operate per finding ID.
- Parser reads source maps and application records from the comments; visible lines are derived and never parsed.

## Machine-state sidecar

- `persistEvidence` writes `<sessionDir>/.state/runs/<run>/evidence.json`; `restoreEvidence` reads it, with the same binding checks (governing hash, plan path, design identity, increment ID).
- Sidecar moves with the session folder at handoff (already whole-folder).
- `preparation.mjs` reads the sidecar for the host-verification table instead of stripping a block.
- Walkthrough Verification renders from the same record.

## Affected components

- Templates: `references/templates/{walkthrough,plan,design}.md`, `write-brief*.md` (envelope `files`).
- Contracts: `references/review.md` (minimum walkthrough contract, resolution log format).
- Renderers/parsers: `review/resolution-log.mjs`, `review/preparation.mjs`, `review/prepare-code.mjs`, `driver/baseline-phase.mjs`, `driver/implement-state.mjs`, `walkthrough/traceability.mjs`, `walkthrough/lint.mjs`.
- Linters: `plan/lint.mjs`, `design/lint.mjs`.
- Envelope schema under `references/templates/schemas/`.

## Risks

- Resolution-log format change breaks consensus/settlement parsing → roundtrip tests (`tests/integration/application-record-roundtrip.test.mjs`) cover comment-embedded records; no legacy format support (repo policy: remove legacy by default).
- Resume after upgrade finds an in-file evidence block and no sidecar → treated as no evidence (restart), per default no-legacy policy.
- Finding grouping hides a distinct finding → group only on identical path, line, and resolution text; IDs remain individually settled.
- Writer omits `files` notes → fallback chain; no failure.

## Out of Scope

- Frontmatter/checkpoint format.
- Success Criteria sub-field structure.
- Antigravity doc alignment beyond current section shapes (not fetched; current templates already follow their structure).
