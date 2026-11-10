---
name: dispatch-verify
description: Alias for `/dispatch verify`. Use only when the user invokes dispatch-verify by name.
---

# dispatch-verify

Require sibling `dispatch`. If missing, report `Missing dependency: dispatch is required by dispatch-verify` and stop.

Read [dispatch](../dispatch/SKILL.md), map this invocation to `verify`, and forward the level and argument through its tool loop. Dispatch owns the workflow, user gates and write boundaries.
