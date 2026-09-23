---
name: implement-dispatch
description: Compatibility alias for the dispatch implementation workflow.
disable-model-invocation: true
---

# Implementation alias

Forward the user's argument to `/dispatch implement: <argument>`, inserting any level and pins before `implement` and any `--phases from:<phase>` after it (`/dispatch <prefix> implement --phases from:<phase>: <argument>`).

If `dispatch` is unavailable, stop with: `implement-dispatch requires the dispatch skill; install or enable dispatch, then retry.`
