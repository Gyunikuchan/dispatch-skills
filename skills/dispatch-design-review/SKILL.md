---
name: dispatch-design-review
description: Review high-level technical designs across independent agent CLIs before implementation increments are authorized.
---

# dispatch-design-review

Review a technical design at architectural level. Reuse dispatch preparation and consensus machinery while keeping findings focused on boundaries, interfaces, dependencies, risks, migration, and rollback. A settled review is not implementation approval.

## Invocation

Use the same dispatch pins and preparation flow as `dispatch-plan-review`, with `kind: design`; resolve the canonical scratch artifact through `resolve-artifact-paths.mjs`.

## Authoring

Ask one focused question per decision-changing ambiguity. Use [design-template.md](references/design-template.md). Include every required high-level section, a deterministic increment dependency graph, and an `### I<nn>` details block per increment carrying each template field. Run `design-lint.mjs` before dispatch; invalid sections, IDs, prerequisites, cycles, or priority order block review.

## Adjudication

Parse reports with `scripts/parse-report.mjs`. Verify each finding at its cited design section. Apply accepted findings to the design and record the resolution log. Round limits and dispute handling follow `dispatch-plan-review` policy. Settlement establishes a governed revision. When review is disabled or unavailable, say so; never present it as consensus.

**Done when:** the design is structurally valid, every finding is verified and settled, and governed metadata is checkpointed.
