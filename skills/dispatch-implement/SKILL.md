---
name: dispatch-implement
description: Compatibility alias for dispatch implementation.
disable-model-invocation: true
---

# dispatch-implement

Require sibling `dispatch`. If missing, report `Missing dependency: dispatch is required by dispatch-implement` and stop.

Read [dispatch](../dispatch), map this invocation to `start implement`, and forward the user's level, pins, model, effort, and argument through its run loop. All host-await judgment and write boundaries belong to that contract.
