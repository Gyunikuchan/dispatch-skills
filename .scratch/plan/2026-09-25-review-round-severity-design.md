# Review round severity gating and user-approved extensions

## Goal

Make review continuation depend on finding severity, and let the user extend a review past its round cap in cap-sized increments. Applies to every review flow (design, plan, code) through the shared driver.

## Current behavior

`nextStep` (`skills/dispatch/scripts/driver/review-phase.mjs`) starts another review wave while the artifact/code changed or live findings remain and `state.reviewWaves < policy.rounds`. At the cap, `askCap` asks the user to rule each live finding, then one final verification wave runs.

## Rules

Let `cap = policy.rounds` and `limit` = the current effective cap (initially `cap`).

1. **Within the initial cap** (rounds 1..`cap`): a round whose accepted findings include `MUST` or `SHOULD` triggers another round.
2. **Within an extension** (rounds past `cap`): only an accepted `MUST` triggers another round.
3. **Termination**: a round with no triggering finding ends the loop, at any round count. Flow then continues as today (final wave if the user ruled at a cap; otherwise opt-in, checkpoint, or settle).
4. **Cap prompt**: when `reviewWaves === limit` and a triggering `MUST` remains live, prompt the user before the next round. The prompt reports open-finding counts by severity (e.g. `2 MUST / 1 SHOULD / 3 CONSIDER`) and offers:
   - **extend** (default, listed first): `limit += cap`; continue with MUST-only rounds.
   - **stop**: rule each live key accepted/rejected (current `askCap` path), then one final verification wave.
5. **Repetition**: the prompt recurs at every `limit` (e.g. cap 3 → prompts after rounds 3, 6, 9, …) until the review settles or the user stops.
6. **Persistence**: `limit` lives in run state and survives resume.
7. **Unchanged**: consensus rebuttals for rejected/downgraded `MUST`/`SHOULD`, `CONSIDER` and adjacent findings remaining host-final, and `consensus: false` semantics.

### Example (cap 3)

| Rounds | Triggers next round | At end of range |
|---|---|---|
| 1–3 | MUST or SHOULD | MUST live → prompt; extend → limit 6 |
| 4–6 | MUST only | MUST live → prompt; extend → limit 9 |
| 7–9 | MUST only | … |

## Assumption (confirm)

At a cap, live `SHOULD`/`CONSIDER` findings without any live `MUST` end the review without a prompt; they stay recorded in the resolution log.

## Interface change

The cap `ask-user` reply accepts `{"extend": true}` in addition to `{"answer": {"<key>": "accepted"|"rejected"}}`. The action payload adds severity counts.

## Changes

- `skills/dispatch/scripts/driver/review-phase.mjs`: severity-gated continuation in `nextStep`; `askCap` counts and extend option; reply handling for `extend`.
- `skills/dispatch/scripts/driver/state.mjs`: persisted `roundLimit` (initialized to `policy.rounds`; existing resets that re-derive `reviewWaves` respect it).
- `skills/dispatch/references/review.md`: replace the round-cap and "Continue while…" sentences; word count net-neutral.
- `skills/dispatch/README.md`: update the round-cap troubleshooting row.

## Tests

`tests/skills/dispatch/driver/scripted.test.mjs`:

- SHOULD-only round within cap continues.
- SHOULD-only round in extension ends.
- CONSIDER-only round ends at any count.
- Cap prompt reports severity counts; extend twice (3 → 6 → 9), then a MUST-free round settles.
- Stop at the prompt → rulings → final wave.
- Resume after extend preserves `roundLimit`.

Verify with `npm test`; run `npm run hashes` on drift.
