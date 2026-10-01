---
name: dispatch-code-review
description: Compatibility alias for dispatch code review.
disable-model-invocation: true
---

# dispatch-code-review

Require sibling `dispatch`. If missing, report `Missing dependency: dispatch is required by dispatch-code-review` and stop.

Read [dispatch](../dispatch), map this invocation to `start review --kind code`, distill active chat intent and intentional deviations into `--context "<intent>"`, and forward level, pins, model, effort, explicit `--fix`, and argument through its loop. That contract owns host-await judgment and write boundaries.
