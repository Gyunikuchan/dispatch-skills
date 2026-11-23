# ADR 0017: Per-actor context packs with byte budgets

- **Status**: Accepted
- **Date**: 2026-11-08
- **Updated**: 2026-11-23
- **Audience**: Maintainers

## Context

Each actor needs a focused context pack containing only the rules for its task. Fragile exact-string replacements, unchecked template placeholders, and reviewers re-reading the rendered `Review Findings & Resolutions` section alongside `### Settled in earlier rounds` risked silent drift and duplicate context.

## Decision

- **Audience-tagged quality bar:** Each normative rule has one canonical home in [`quality-bar.md`](../../skills/dispatch/references/templates/quality-bar.md) and declares its audience via `<!-- for: ... -->` tags (`code`, `plan`, `design`, `writer`, `cleanup`, `explorer`, `all`, plus `author` for human/orchestrator file readers). Selection validates expected tag counts fail-closed so an unknown consumer, unknown tag, or count mismatch throws rather than emitting unfiltered text.
- **Single-source review tags and stripped inputs:** Review tags come from one per-kind allowlist (`REVIEW_TAGS_BY_KIND` in `domain/report.ts`), checked against rendered quality families plus `standards` and `adjacent`. Plan and design reviewers read governed text from `.state/reviews/<review>/round-<n>.input.md` with `Review Findings & Resolutions` stripped so `### Settled in earlier rounds` is the single source of prior rulings.
- **Self-contained rendered briefs:** The toolkit renders writer, explorer, `fix-review-lite`, `test-cleanup`, and [runtime verifier](../../skills/dispatch/references/templates/verifier-brief.md) briefs under `.state/briefs/` after validating all required placeholders, with no unresolved relative links.
- **Step reads and byte budgets:** Each verb guide declares a `| Step | Reads |` table with one relative link per step so the orchestrator loads only the current step's reference (e.g., [review-fixes.md](../../skills/dispatch/references/review-fixes.md) loads only when accepted fixes run). The [structural targets test](../../tests/integration/structural-targets.test.ts) enforces per-step, `SKILL.md`, and per-actor pack byte budgets, and [`path-bytes.ts`](../../scripts/path-bytes.ts) tracks representative must-load reads and link declarations across verbs.
- **Ceilings as consolidation hints:** Structural ceilings require cutting or consolidating first; a genuine new behavior or rule that every branch needs may raise a ceiling without user authorization when the reason is recorded beside the ceiling and reported in the handoff (duplicates never justify a raise).

## Consequences

Delegate and subagent packs render deterministically from one canonical rule source under fail-closed byte budgets, and reviewers never re-read duplicate findings history.
