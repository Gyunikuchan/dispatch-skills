---
name: dispatch-code-review
description: Compatibility alias for reviewing code changes.
disable-model-invocation: true
---

# Code review alias

Preserve any level and pins in the prefix, then forward the post-colon text to `/dispatch review code: <argument>`, inserting the preserved prefix before `review`. Put `--fix` before the colon only when it appears in the user's invocation; otherwise the review is report-only.

If `dispatch` is unavailable, stop with: `dispatch-code-review requires the dispatch skill; install or enable dispatch, then retry.`
