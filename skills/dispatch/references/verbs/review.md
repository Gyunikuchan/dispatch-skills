# Review

Use `start review --session-dir <dir> --orchestrator <platform> [--kind code|plan|design] [--fix] [--context <text>] -- <target>`. Empty code target selects working-tree changes; a revision/range selects a diff, artifact extensions infer their kind. Explicit `--kind` wins. Pass `--context` to supply semantic intent and known deviations. Read [review rules](../review.md) before adjudicating claims or applying clusters. Follow [the contract](../..) through rule, fix, and decision boundaries.
