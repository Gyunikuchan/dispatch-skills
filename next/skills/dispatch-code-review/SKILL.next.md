---
name: dispatch-code-review
description: Compatibility alias for dispatch code review.
disable-model-invocation: true
---

# dispatch-code-review

Require sibling `dispatch`. If missing, report `Missing dependency: dispatch is required by dispatch-code-review` and stop.

Read [dispatch](../dispatch), map this invocation to `start review --kind code`, and forward the user's level, pins, model, effort, and argument through its run loop. All host-await judgment and write boundaries belong to that contract. This overlay uses `SKILL.next.md`; cutover renames it to `SKILL.md`.
