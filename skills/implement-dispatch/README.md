# implement-dispatch

User-invoked compatibility alias for `/dispatch implement:`. It requires `dispatch` and preserves levels, pins, artifact paths, and `--phases from:<phase>`.

```text
/implement-dispatch: Add CSV export
/implement-dispatch high (all): Refactor webhook idempotency
/implement-dispatch --phases from:code-review: .scratch/plan/2026-09-22-webhooks.md
```

The dispatch driver performs planning, plan review, baseline verification, approval, implementation, code review, and handoff. Technical designs run one ledger-ready increment per invocation and finish with a separate integration phase. Canonical artifacts and ledger state support recovery; production writes remain approval-gated. New automation should invoke `dispatch` directly.

On implementation failure, the driver preserves the tree and asks whether to keep it for repair, revert only attributable paths, or inspect first. It records the ruling before closing a stable failure.
