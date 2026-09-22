# dispatch-design-review

User-invoked compatibility alias for `/dispatch review design:`. It requires `dispatch` and forwards arguments unchanged.

```text
/dispatch-design-review: .scratch/plan/2026-09-22-storage-design.md
```

The review governs the design revision but does not approve implementation. It is report-only unless the user explicitly supplies `--fix`. New automation should invoke `dispatch` directly.
