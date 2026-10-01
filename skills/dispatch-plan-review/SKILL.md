---
name: dispatch-plan-review
description: Compatibility alias for dispatch plan review.
disable-model-invocation: true
---

# dispatch-plan-review

Require sibling `dispatch`. If missing, report `Missing dependency: dispatch is required by dispatch-plan-review` and stop.

Read [dispatch](../dispatch), map this invocation to `start review --kind plan`, and forward level, pins, model, effort, explicit `--fix`, and argument through its loop. That contract owns host-await judgment and write boundaries.
