# Documentation review after v0.7.3

Reviewed against tag `v0.7.3` and implementation `56f4718a` on 2026-10-27. This is a static contract review, not a new provider evaluation. The documentation repair preserves existing behavior except for the separately authorized MUST rejection confirmation restored below.

## Resolved decisions

**Rejected MUST confirmation — restored by user decision, 2026-10-27.** “Rejected MUST: yes”. Rejected MUST findings remain pending until explicit source-slot or configured fallback agreement. Pending requests permit post-cap review; repeated disagreement escalates. Shared closure checks block pruning, delivery and report completion. See [review rules](../skills/dispatch/references/review-rules.md), [confirmation state](../skills/dispatch/scripts/toolkit/confirmations.ts) and [review generation handling](../skills/dispatch/scripts/toolkit/review.ts).

**RED assurance — accepted by the user, 2026-10-27.** “Ok to forego red assurance, just let writers follow TDD.” Writers continue tests-first development; independent RED replay and immutable test-only checkpoints are not required. Current scope checks, host inspection and integrated verification remain. This accepts the reduced independent assurance described in historical ADR 0008.

## Other changed limits

- **Doctor has less coverage.** It checks integrity, config validity, level and configured writer models. It does not discover provider binaries or predict sandbox support. Launch failures expose these issues later. Assessment: sufficient for integrity and config validation. Execution still discovers binaries and enforces provider sandbox requirements; the loss is early diagnosis, not sandbox enforcement. Recommendation: keep Doctor lean unless setup friction justifies richer preflight reporting. Evidence: [doctorReport](../skills/dispatch/scripts/toolkit/doctor.ts).
- **Delivery requires an empty caller index.** Internal commits are retained; the caller receives unstaged changes. This preserves staged work by refusing delivery, rather than delivering alongside it as ADR 0008 described. The current implement guide already documents this condition. Evidence: [delivery contract](../skills/dispatch/references/toolkit.md#worktree-deliver).
- **Old runs need their old controller.** Toolkit recovery cannot replay v0.7.x journals. Preserve controller and session files; finish with the old version or reuse saved work in a new session. This is an explicit ADR 0013 break, not an undocumented migration promise.
- **Performance acceptance is not independently auditable here.** ADR 0013 linked a missing I08 report and claimed a correctness/token pass. The claim has been qualified. Recover the original matched-task evidence before relying on that result; smaller code or fewer tests alone does not prove equivalent assurance or lower delivery cost.

## Documentation repairs

Updated setup commands to the session-based toolkit CLI; removed obsolete rebind/send recovery and `--json` examples; corrected Doctor, RED, review-cap, diagnostics usage and internal-commit descriptions. Marked superseded test, review and writer mechanics as historical while retaining their rationale. The documentation repairs do not change test policy. The authorized confirmation implementation restores the review and completion boundary described above.
