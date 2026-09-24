---
name: dispatch-design-review
description: Use only when the user explicitly invokes `/dispatch-design-review`.
---

# Design review alias

Forward the post-colon text to `/dispatch review design: <argument>`, inserting any level and pins before `review`; when the user supplied `--fix`, place it after `design` (`/dispatch <prefix> review design --fix: <argument>`).

If `dispatch` is unavailable, stop with: `dispatch-design-review requires the dispatch skill; install or enable dispatch, then retry.`

This alias is report-only unless the user explicitly supplied `--fix`.
