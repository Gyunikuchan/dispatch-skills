---
name: dispatch-code-review
description: Alias for `/dispatch review` of code. Use only when the user invokes dispatch-code-review by name.
---

# dispatch-code-review

Require sibling `dispatch`. If missing, report `Missing dependency: dispatch is required by dispatch-code-review` and stop.

Read [dispatch](../dispatch), map this invocation to `start review --kind code`, distill active chat intent and intentional deviations into `--context "<intent>"`, and forward level, pins, model, effort, explicit `--fix`, and argument through its loop. That contract owns host-await judgment and write boundaries.
