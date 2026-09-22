# dispatch-code-review

User-invoked compatibility alias for `/dispatch review code:`. It requires `dispatch` in the same installation scope.

```text
/dispatch-code-review: main..HEAD
/dispatch-code-review high (all) --fix: main..HEAD
```

The default is report-only. The alias forwards `--fix` only when the user supplied it; accepted fixes then run through host verification. With no range, the driver resolves current reviewable changes. New automation should invoke `dispatch` directly.
