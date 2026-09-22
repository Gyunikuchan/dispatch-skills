# dispatch-plan-review

User-invoked compatibility alias for `/dispatch review plan:`. It requires `dispatch` in the same installation scope and forwards level, pins, path, focus, and an explicit `--fix` unchanged.

```text
/dispatch-plan-review: .scratch/plan/2026-09-22-api.md
/dispatch-plan-review high (all): focus on migration safety
```

Standalone review is report-only unless the user supplies `--fix`. Missing `dispatch` produces a named installation diagnostic. New automation should invoke `dispatch` directly.
