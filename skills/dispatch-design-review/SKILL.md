---
name: dispatch-design-review
description: Compatibility alias for reviewing a technical design.
disable-model-invocation: true
---

# Design review alias

Preserve any level, pins, and explicit `--fix` in the prefix, then forward the post-colon text to `/dispatch review design: <argument>`, inserting the preserved prefix before `review`.

If `dispatch` is unavailable, stop with: `dispatch-design-review requires the dispatch skill; install or enable dispatch, then retry.`

This alias is report-only unless the user explicitly supplied `--fix`.
