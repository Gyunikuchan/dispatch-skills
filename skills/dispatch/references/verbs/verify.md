# Verify

Resolve the target: session integration when present, else the working tree, unless the argument names a revision. For a revision other than checked-out HEAD, create a temporary detached checkout under `<session>/.state/`, report-only: apply no fixes; remove the checkout after verification. Reuse the bound or session spec. If absent, author a spec from the full discussion and diff as for standalone code review, label inferred requirements, and add no authoring approval gate.

Choose cycle one above the highest verification record, or 1; an interrupted run retains its cycle. Every new cycle launches fresh. When nothing runnable can be proved, skip launch and record a no-op reason. Otherwise render [brief verifier](../toolkit.md#brief-verifier) with `checkoutPath`, `base`, `specPath` and `focus`. Start `focus` with `Cycle <n>` using the chosen ledger cycle. Include `no test edits` for a named revision other than HEAD or a post-review re-check, and `test edits permitted` for initial implement verification and standalone verification on the current checkout. Launch the utility subagent on its returned values; if the host has no launch tool, run verification inline under the same boundaries. Inspect its delta.

The verifier finishes unblocked checks before returning `NEEDS_APPROVAL` with a batched request. Use the [Decision Frame](../decision-frame.md) to obtain and record the user's approval quote before risky actions; continue the same subagent. A declined check is `not proved` and is a limit, not an issue. Read-only calls, local servers and disposable resources created and removed by the verifier need no approval. Persistent or shared state changes, external messages, paid calls and non-local actions require approval.

The report and artifacts live under `<session>/verification/` and stay outside the delivered diff. Store artifacts in the cycle's subdirectory. A continuation may assign new artifact paths there; the verifier writes those artifacts and returns results inline, never rewriting `report.md`. When the host refuses the report write, the verifier returns the full report text and the orchestrator persists it under `<session>/verification/` with its evidence; a refused write needs no user ruling. Append each continuation result to the report under a follow-up heading with its approval quote or issue IDs. New cycles append a cycle heading and preserve earlier content.

Verify each issue claim against intent and evidence; record a ruling with subject `verification:<cycle>:V<n>` and key `ruling:verification:<cycle>:V<n>` as accepted, rejected, duplicate or deferred. On resume rule any reported issue without a ruling before continuing. Fix accepted issues on the verified tree and continue the same verifier to re-check only those issues. Escalate recurrence through the Decision Frame; escalate when three fix rounds per issue finish with an accepted issue still open. Standalone on the working tree leaves fixes there, with no delivery step.

After settlement append an `integrate` verification record with cycle, outcome `proved`, `partial` or `no-op`, full tested `head`, nonblank reason and open accepted unfixed issues. `proved` and `no-op` require empty open; report is required for `proved` and `partial`. Record the no-op reason even when the verifier chose it. Include report and artifacts as session-relative paths or HTTPS links. Set `dirty: true` when the standalone tested tree has uncommitted changes.

## Step reads

| Step | Reads |
| --- | --- |
| Resolve intent | [spec stage](../spec-stage.md) |
| Launch verifier | [brief verifier](../toolkit.md#brief-verifier) |
| Rule issues and record outcome | [ledger append](../toolkit.md#ledger-append) |
| Escalate approvals and recurrence | [Decision Frame](../decision-frame.md) |
