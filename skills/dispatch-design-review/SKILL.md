---
name: dispatch-design-review
description: Review high-level technical designs across independent agent CLIs before implementation increments are authorized.
---

# dispatch-design-review

Review a technical design at architectural level. Reuse dispatch preparation and consensus machinery while keeping findings focused on boundaries, interfaces, dependencies, risks, migration, and rollback. A settled review is not implementation approval.

## Invocation

Use the same dispatch pins and preparation flow as `dispatch-plan-review`, with `kind: design`; resolve the canonical scratch artifact through `resolve-artifact-paths.mjs`.

## Authoring

Use [design-template.md](references/design-template.md). Include required high-level sections and a deterministic increment dependency graph. Run `design-lint.mjs` before dispatch; invalid sections, IDs, prerequisites, cycles, or priority order block review.

## Adjudication

Parse reports with `scripts/parse-report.mjs`. Verify each finding at its cited design section. Apply accepted findings to the design and record the resolution log. Review settlement establishes a governed revision; it does not authorize implementation.

**Done when:** the design is structurally valid, every finding is verified and settled, and governed metadata is checkpointed.
