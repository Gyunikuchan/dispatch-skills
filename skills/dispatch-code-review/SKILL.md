---
name: dispatch-code-review
description: Use only when the user explicitly invokes `/dispatch-code-review`.
disable-model-invocation: true
---

# Code review alias

Forward the post-colon text to `/dispatch review code: <argument>`, inserting any level and pins before `review`; place `--fix` after `code` (`/dispatch <prefix> review code --fix: <argument>`) only when it appears in the user's invocation; otherwise the review is report-only.

If `dispatch` is unavailable, stop with: `dispatch-code-review requires the dispatch skill; install or enable dispatch, then retry.`
