---
name: dispatch-plan-review
description: Compatibility alias for reviewing an implementation plan.
disable-model-invocation: true
---

# Plan review alias

Preserve any level, pins, and explicit `--fix` in the prefix, then forward the post-colon text to `/dispatch review plan: <argument>`, inserting the preserved prefix before `review`.

If `dispatch` is unavailable, stop with: `dispatch-plan-review requires the dispatch skill; install or enable dispatch, then retry.`

This alias is report-only unless the user explicitly supplied `--fix`.
