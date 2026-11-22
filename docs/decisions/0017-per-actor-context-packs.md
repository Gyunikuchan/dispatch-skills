# ADR 0017: Per-actor context packs with byte budgets

- **Status**: Accepted
- **Date**: 2026-11-08
- **Updated**: 2026-11-19
- **Audience**: Maintainers

## Context

Each actor needs a focused context pack so it can read the rules relevant to its task without carrying unrelated instructions into every turn. Exact-string replacements could silently stop applying when rule wording changed. Explorer and test-cleanup templates had unchecked placeholders, and repeated budget references could drift. Rendering from canonical sources with fill checks addresses these risks. Reviewers need the current artifact and settled rulings, so the brief supplies each once.

## Decision

Each normative rule has one canonical home and declares its audience with an `<!-- for: ... -->` tag on its own line in `quality-bar.md` (consumers `code`, `plan`, `design`, `writer`, `cleanup`, `explorer`, plus `all` for every render consumer and `author` for file readers only, which no renderer selects). `qualitySections` gains `cleanup: ['shared','testing']` and `explorer: ['shared']`; untagged bullets reach every consumer except `explorer`. Tag counts are fail-closed per `REQUIRED_TAGGED` (code 5, writer 6, plan 5, design 4, cleanup 6, explorer 3): an unknown consumer, unknown tag, empty selection or count mismatch throws instead of emitting unmodified text.

Review tags come from one per-kind allow-list (`REVIEW_TAGS_BY_KIND`) in `domain/report.ts`, checked by `reviewPrompt` against the rendered quality families plus `standards` and `adjacent`; the rendered prompt names them in one line under `### Tags` without a per-tag bullet list.

The toolkit renders explorer, fix-review-lite, test-cleanup and verifier briefs from their templates. The [runtime verifier template](../../skills/dispatch/references/templates/verifier-brief.md) scopes proof to the checkout, spec and assigned focus. The renderer checks required values before writing briefs under `.state/briefs/`. Rendered briefs contain no relative links.

Plan and design reviewers read governed text from `.state/reviews/<review>/round-<n>.input.md`, which holds the artifact without its `Review Findings & Resolutions` section; `### Settled in earlier rounds` stays the only source of prior rulings. Hashes, review identity and the findings refresh are unchanged.

The orchestrator loads only the current step's references: each verb guide carries a `| Step | Reads |` table with one relative link per step. The [structural targets test](../../tests/integration/structural-targets.test.ts) enforces byte budgets. The [path workload measure](../../scripts/path-bytes.ts) tracks representative must-load reads across verbs. The maintainer command checks each guide and `SKILL.md` against its declared relative links and resolves their targets and anchors. Maintainers classify added or changed links in the declarations so the workload model retains its editorial conditions.

Structural ceilings are a hint, not a gate needing user authorization: cut or consolidate first; a genuine new behaviour or rule may raise a ceiling with the reason recorded beside it and reported in the handoff; duplicates never justify a raise. Dead exports are removed only on index or reference evidence, and duplicate helpers merge to one owner with error handling and validation kept; files split by responsibility, never by length.

The structural test enforces pack totals plus standalone component ceilings (explorer brief template, verifier brief, test-cleanup brief template, and test-cleanup rendered quality) while allowing shared quality-bar edits inside pack totals. Branch-specific review-fix assignment and handle-recovery detail lives in [review-fixes.md](../../skills/dispatch/references/review-fixes.md) and loads only when accepted fixes run.

Canonical homes hold one copy per rule across `SKILL.md`, `quality-bar.md`, `spec-authoring.md`, `spec-stage.md`, `grounding.md`, `review-rules.md`, `review-coverage.md`, `decision-frame.md`, `providers.md`, `worktree-cleanup.md`, `toolkit.md`, and the actor templates; other references link to the canonical home or keep only their reader-specific action.

The advisory per-actor context pack pilot is pending. It measures delegate tokens, review rounds and duplicate-finding rate. Delivery can proceed while the pilot is pending.

## Consequences

Delegate and subagent packs render from one source per rule with byte budgets that fail the build on regression. Reviewers stop re-reading findings history. Writer and native token capture stays a follow-up; telemetry gaps stand.
