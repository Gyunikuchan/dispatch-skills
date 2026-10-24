---
name: dispatch-code-review
description: Alias for `/dispatch review --kind code`. Use only when the user invokes dispatch-code-review by name.
---

# dispatch-code-review

Require sibling `dispatch`. If missing, report `Missing dependency: dispatch is required by dispatch-code-review` and stop.

Read [dispatch](../dispatch/SKILL.md), map this invocation to `review --kind code`, and forward the level and argument through its tool loop. Take the target from the argument; use worktree when empty. Resolve the governing spec via `--spec` or the bound spec. Dispatch owns the workflow, user gates and write boundaries.
