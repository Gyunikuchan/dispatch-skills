# Review

Resolve and read the [governing spec](../spec-stage.md#readers-and-document-layers). Use [review run](../toolkit.md#review-run) with kinds `plan`, `design` or `code`; artifact extensions infer plan or design, and an explicit kind wins. Supply `--spec <path>` or use the bound spec. Standalone review needs no bound plan and adds no approval gate.

Code targets are `integration`, a bound-plan task ID, `worktree`, `<a>..<b>` or `<rev>`; see [toolkit contract](../toolkit.md#review-run) for target resolution semantics. Integration reviews the accumulated integration candidate; a task reviews its finished launch. Revision ranges resolve exact commits; a single revision compares merge-base with HEAD. Session state is excluded.

At adjudication apply [shared](../templates/quality-bar.md#shared) and: for plan, [spec](../templates/quality-bar.md#spec), [plan](../templates/quality-bar.md#plan) and [testing](../templates/quality-bar.md#testing); for design, [spec](../templates/quality-bar.md#spec) and [design](../templates/quality-bar.md#design); for code, [code](../templates/quality-bar.md#code) and [testing](../templates/quality-bar.md#testing). Adjudicate under [review rules](../review-rules.md) from the full findings at the result path; record ledger [rulings](../toolkit.md#ruling) and apply accepted bounded fixes directly. Rerun review for continuation or native replies and rerun verification after code changes. A missing finding is not proof of a successful review. Handle failed code-review slots under [failed-slot coverage](../review-coverage.md#failed-slot-coverage).

## Step reads

| Step | Reads |
| --- | --- |
| Resolve the governing spec and target | [spec stage](../spec-stage.md) |
| Run the review | [review run](../toolkit.md#review-run) |
| Adjudicate under the quality bar and review rules | [review rules](../review-rules.md) |
| Load coverage rules only on a slot failure | [failed-slot coverage](../review-coverage.md#failed-slot-coverage) |
| Load the repository-change procedure only on a repository change | [repository changes](../review-coverage.md#repository-changes-from-native-voices) |
| Rerun review and verification after fixes | [rulings and fix scope](../review-rules.md#rulings-and-fix-scope) |
