# Review rules

[Dispatch](..) owns `start review`, `send`, and eight awaits. Reviews apply fixes only with `--fix`. The driver records findings in the owning design, plan, or walkthrough's `## Review Findings & Resolutions`, preserving prior runs; reviews without an owning document use a standalone report.

Review prompt context composes two channels: semantic intent prioritizes explicit `--context` (or distilled chat intent/deviations), falling back to Git commit log (`git log --format="%s%n%b" <range>`) for commit ranges and defaulting to `Review the selected changes.`; structural baseline prioritizes explicit governing paths, discovering unique `<slug>.plan.md` and `<slug>.walkthrough.md` in active `sessionDir` and leaving ambiguous or absent deliverables as `None`.

Verify findings against source and governing outcomes. Accept demonstrated defects regardless of votes; reject unsupported claims with evidence. Recorded user decisions govern until new defects warrant reopening. Intent conflicts require `needs-user`.

Rounds policy owns threshold, cap, MUST continuation, convergence, affinity, and full/delta/disputes-only scope. Reply to every pending finding through the frame's `events` envelope. Rejection and downgrade rulings require a nonblank reason. Rejections carry reasons forward; omission closes them only after usable responsible-source or substitute coverage. Missing coverage fails by name. Below-threshold closure requires host evidence. Cap-ending fixes may be `fixedUnreviewed`; never claim another review occurred.

For `--fix`, ruling metadata names `affectedPaths`, `dependsOn`, and `verification`. Apply only accepted bounded clusters. `CONSIDER` and verified adjacent findings require opt-in; report unaccepted findings as follow-ups. One parser handles native/provider reports; refusal, truncation, empty output, missing coverage, and loose loci trigger fallback per [providers](providers.md).

Failed apply or verification attempts consume cluster budgets. Aggregate verification defects charge each applied cluster once; pending apply failures retain their remaining budgets. Mark fixes complete only after verification passes. Exhaustion stops selected fixes, including opt-in fixes, names unresolved work, and retains verified fixes.
