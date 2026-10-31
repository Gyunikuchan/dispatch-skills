# Review

Resolve and read the whole [governing spec](../spec-stage.md). Use `review run` with kinds `plan`, `design` or `code`; artifact extensions infer plan or design, and an explicit kind wins. Supply `--spec <path>` or use the bound spec. Standalone review needs no bound plan and adds no approval gate.

Code targets are `integration`, a bound-plan task ID, `worktree`, `<a>..<b>` or `<rev>`; see [toolkit contract](../toolkit.md#review-run) for target resolution semantics. Integration reviews the accumulated integration candidate; a task reviews its finished launch; worktree captures tracked and untracked changes against HEAD without changing the caller index or branch. Revision ranges resolve exact commits; a single revision compares merge-base with HEAD. Session state is excluded.

Read full findings from the result path and adjudicate under [review rules](../review-rules.md). Verify claims against intent and current source; record ledger rulings and apply accepted bounded fixes directly. Rerun review for continuation or native replies and rerun verification after code changes. Preserve prior findings, rulings, reviewed revision and actual coverage; a missing finding is not proof of a successful review.

When checking a finding requires reading many files, consider a [follow-up explorer](../grounding.md#follow-up-explorers) to gather the evidence.
