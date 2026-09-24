---
name: dispatch-plan-review
description: Use only when the user explicitly invokes `/dispatch-plan-review`.
disable-model-invocation: true
---

# Plan review alias

Forward the post-colon text to `/dispatch review plan: <argument>`, inserting any level and pins before `review`; when the user supplied `--fix`, place it after `plan` (`/dispatch <prefix> review plan --fix: <argument>`).

If `dispatch` is unavailable, stop with: `dispatch-plan-review requires the dispatch skill; install or enable dispatch, then retry.`

This alias is report-only unless the user explicitly supplied `--fix`.
