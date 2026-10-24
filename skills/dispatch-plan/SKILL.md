---
name: dispatch-plan
description: Alias for `/dispatch plan`. Use only when the user invokes dispatch-plan by name.
---

# dispatch-plan

Require sibling `dispatch`. If missing, report `Missing dependency: dispatch is required by dispatch-plan` and stop.

Read [dispatch](../dispatch/SKILL.md), map this invocation to `plan`, and forward the level and argument through its tool loop. Dispatch owns the workflow, user gates and write boundaries.
