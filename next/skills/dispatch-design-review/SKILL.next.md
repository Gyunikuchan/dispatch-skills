---
name: dispatch-design-review
description: Compatibility alias for dispatch design review.
disable-model-invocation: true
---

# dispatch-design-review

Require sibling `dispatch`. If missing, report `Missing dependency: dispatch is required by dispatch-design-review` and stop.

Read [dispatch](../dispatch), map this invocation to `start review --kind design`, and forward the user's level, pins, model, effort, and argument through its run loop. All host-await judgment and write boundaries belong to that contract. This overlay uses `SKILL.next.md`; cutover renames it to `SKILL.md`.
