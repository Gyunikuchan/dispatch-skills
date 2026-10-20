# Inline hotfix and evidence-await investigation

## Findings

| Claim | Disposition | Verified result |
| --- | --- | --- |
| H6: evidence await took 1h 24m 45s | Measurement confirmed; continuation interval supported; performance defect unproven | Journal seq 129 completed final verification at 13:34:11.287Z; seq 130 supplied EVIDENCE at 14:58:56.794Z. Difference: 5085.507 seconds. Host transcript records command completion, then the next turn starts with user “Continue” at 14:58:26.134Z; evidence follows about 31 seconds later. |
| inline-hotfix-order | Confirmed guidance defect | The contract lists answer shapes but omits when edits occur. Current beginHotfix snapshots immediately for inline mode, whereas writer mode prepares a brief. The original journal records a zero-file inline candidate followed by unchanged failure. |

Evidence owner: `.scratch/dispatch-skills/20261020T1242Z-implement-reviewed-spec-guidance-alignme/.state/runs/001-implement/events.jsonl`. Times above are UTC. The supplied diagnostics already warns that internal activity is unknown; retain that wording. Do not turn this finding into a timing-budget or instrumentation change without activity evidence.

Host activity evidence: `C:/Users/fchei/.codex/sessions/2026/10/20/rollout-2026-10-20T20-42-21-01a15955-8a40-7142-a369-6fabfd1b8c7f.jsonl`, entries at 13:34:11.366Z and 14:58:26.096Z–14:58:54.171Z. There are no recorded host events between command completion and settings/task restart at 14:58:26Z. This supports a continuation interval rather than active reasoning across the gap. The underlying reason the turn required continuation is not recorded by these entries. The host initially said the check was still running after continuation, then read the completed result and submitted evidence. This is a run explanation, not proof of a driver timing defect.

## Verified failure sequence

- Seq 108, 13:16:36.113Z: host sends inline hotfix DECISION, naming the fixture repair.
- Seq 110 and 112: snapshots retain the same worktree fingerprint.
- Seq 114: hotfix assessment reports files=0, lines=0, no violations.
- Seq 115–116: npm test runs for 498.205 seconds and fails with the same missing spec-section fixture error.
- Seq 117: host reports the fixture corrected and sends retry.
- Seq 121: drift assessment first records `tests/unit/core/effects-brief.test.ts` changed.
- Seq 129: final checks pass. Seq 135 records the host's mistaken expectation of a write frame and single-attempt withdrawal. Withdrawal is corroborated by current runtime recovery policy; the journal's zero-delta assessment alone does not prove it.

Current source evidence: `skills/dispatch/scripts/machines/implement.ts:1846` (`beginHotfix`) branches inline to snapshot, writer to write-brief. Recovery state handling applies scope admission and verification. `skills/dispatch/references/verbs/implement.md:30` and `:31` list baseline/failure answers with no edit-order procedure. No runtime defect is demonstrated: the host used an admission event as a launch request.

## Options and recommendation

1. **Clarify existing procedure (recommended):** put one ordered hotfix procedure next to the answer shapes. Cover inline baseline and delivered failure, and contrast writer launch order. Preserve runtime, admission and attempt limits. This addresses the observed cause with the smallest change.
2. Add an inline preparation frame: makes the order explicit in protocol, but changes machine transitions, compatibility, persisted state and tests. No evidence justifies this cost now.
3. Reject empty hotfix deltas before verification: could avoid this wasted check, but changes retry/attempt semantics and needs a separate behavior decision. Defer.

For H6, record the measured interval and continuation evidence; propose no product timing fix. The plan preserves the narrower journal-only attribution limit; this report adds host evidence without changing that implementation scope.

## Verification and limits

Read current guidance and recovery source through CodeGraph; compared the retained journal sequence and timestamps. No product files changed and no implementation is claimed. The companion plan defines future implementation checks. Planning review checks traceability, path ownership, ordering, and unchanged safety boundaries. Low-level Dispatch configuration skips delegated plan review.

Planning handoff checks: Dispatch spec and plan parsing passed; the plan run completed with delegated review skipped. `npm test` exited 0: all 1653 tests passed across 175 files, one skipped, 536.77 seconds. `git diff --check` passed. No worktrees were created; the worktree inventory contains only the original checkout. These checks verify the current repository and artifact structure, not the proposed future wording's effectiveness with a host.
