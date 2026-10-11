# Dispatch diagnostics fixes — spec

## Objective

Fix the verified findings from the thin-driver plan run (session `91a618c3`, report `.scratch/dispatch-skills/20261011T0428Z-thin-driver-orchestrator-owned-conflicts/diagnostics.md`). Cut wasted provider time, user round trips, false diagnostics, and host read cost in review runs.

## Verified findings and decisions

| # | Finding | Verdict | Evidence | Decision |
|---|---|---|---|---|
| F1 | agy timeout, 10 m lost | Real | `machines/review.ts:21` fixed `DEFAULT_TIMEOUT_MS = 600_000` at every level; successful agy `medium` reviews took 5 m 35 s, 8 m 43 s, 8 m 26 s (87% of cap). Only an undocumented run override `timeout` changes it. | Scale the review delegate default by level: `low`/`medium` 10 m, `high` 20 m, `xhigh`/`max` 30 m (user). Run override still wins. Provider session resume on timeout: out of scope (larger change, no evidence it would finish sooner). |
| F2 | Minor intent findings need a user quote | Real | `machines/review.ts:316-328` rejects an intent `accept`/`reject` without `quote`; `review-rules.md` L13 and frame hint `core/frame.ts:21` say the same. User stated: "if it's not a major decision that needs me, I'd prefer if the orchestrator can make the call". | Allow intent `accept`/`reject` with `by:"orchestrator"` and a nonblank `reason` that cites the settled decision. Keep `needs-user` (or user `quote`) for changed intent, a new external dependency or runtime prerequisite, or discarded work. Record resolution `orchestrator: <reason>`. |
| F3 | H2 "cap reached (3), raise the cap" | False alarm | `policy/rounds.ts:46-54`: past the cap, a `delta` round runs only for fixed MUST findings (designed MUST continuation). Round 4 was that round. Raising the cap would add rounds, not remove them. | H2 must not flag rounds past the cap when they are MUST-continuation delta rounds with no re-raised findings and no escalation. When it does flag over-cap continuation, the proposed fix names MUST-continuation, not "raise the cap". |
| F4 | Verify filters must match existing test names | Real, already planned | Thin-driver plan T5 (`thin-driver-spec-md.plan.md` L195) changes `review-prompt-plan.md` to accept plan-named titles. | Deferred (user). |
| F5 | Rule frame inlines every finding body | Real | `core/frame.ts:55` builds a `RULINGS` example per finding and `data.findings` carries full bodies; one JSON line. A truncated host read lost findings. | Driver writes the round's full findings to a run-relative file; `rule` frame `data` carries `findingsPath` plus per-finding `id`, `severity`, `category`, `locus` only. The suggested `RULINGS` event stays. |

## Session follow-ups (not in scope)

- Merge of the 16 internal event types: deferred by the thin-driver plan; track separately.
- Round-4 thin-driver plan fixes are `fixedUnreviewed`: review them when that plan is implemented.

## Constraints

- Sequencing: thin-driver plan T1 also edits `core/frame.ts` and `SKILL.md`. Implement this plan after thin-driver T1, or rebase over it.
- No new dependency. No config schema change.
- Hash-tracked skill files: run `npm run hashes`, then `npm test`.

## Success criteria

1. Review roster timeout defaults to 10/10/20/30/30 m for low/medium/high/xhigh/max; a positive run override `timeout` wins. Unit test.
2. `validateRulings` accepts an intent `accept`/`reject` with `by:"orchestrator"` and nonblank `reason`; rejects it with blank reason; still accepts user `quote` and `needs-user`. Unit tests.
3. `review-rules.md`, `SKILL.md` Await rule, and the frame intent hint state the orchestrator path and the three user-gate triggers.
4. H2 emits no finding for a phase whose rounds past the cap were MUST-continuation delta rounds without re-raises or escalation; existing H2 cases still pass. Unit test.
5. `rule` frame `data` holds `findingsPath` (file exists, holds full findings) and summaries without bodies. Protocol test.
6. `npm test` passes.
