---
name: dispatch-implement
description: Alias for `/dispatch implement`. Use only when the user invokes dispatch-implement by name.
---

# dispatch-implement

Require sibling `dispatch`. If missing, report `Missing dependency: dispatch is required by dispatch-implement` and stop.

Read [dispatch](../dispatch/SKILL.md), map this invocation to `implement`, and forward the level and argument through its tool loop. Dispatch owns the workflow, user gates and write boundaries.
