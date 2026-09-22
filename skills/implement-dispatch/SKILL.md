---
name: implement-dispatch
description: Compatibility alias for the dispatch implementation workflow.
disable-model-invocation: true
---

# Implementation alias

Forward the user's complete argument text to `/dispatch implement: <arguments>`, preserving any level, pins, and `--phases from:<phase>` prefix before the colon.

If `dispatch` is unavailable, stop with: `implement-dispatch requires the dispatch skill; install or enable dispatch, then retry.`
