---
name: dispatch-plan-review
description: Compatibility alias for dispatch plan review.
disable-model-invocation: true
---

# dispatch-plan-review

Require sibling `dispatch`. If missing, report `Missing dependency: dispatch is required by dispatch-plan-review` and stop.

Read [dispatch](../dispatch), map this invocation to `start review --kind plan`, and forward the user's level, pins, model, effort, and argument through its run loop. All host-await judgment and write boundaries belong to that contract.
