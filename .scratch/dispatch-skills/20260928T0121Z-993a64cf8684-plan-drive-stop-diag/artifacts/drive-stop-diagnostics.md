---
{
  "dispatch": {
    "schemaVersion": 1,
    "kind": "plan",
    "slug": "drive-stop-diagnostics",
    "invocationId": "579799ef-9947-42ab-81e0-b7f6f0278ca3",
    "contentHash": "sha256:1882c7184b62f8887260f93638c85c55abcb3b3b37949b5f8d1a1b2c1718b503",
    "sectionHashes": {
      "__preamble__": "sha256:5d1e74ae21e8b83e604160f135c70707ef2948153d08acc15f3393564c86d784",
      "Key Decisions & Context": "sha256:beeddd0c945e47bbe7be2305f4f2f0ac52e69acbcd8208de616fdde9ac4d577a",
      "User Review Required": "sha256:605551dedac3819e07f4eb838e6978c163e59de02ea636989dfcae5e5f5540f9",
      "Open Questions & Assumptions": "sha256:c1faa8105e11878372c39e5ac1d5798b727e1d86c4aa3f2eaa7b5e0de5ff6ff4",
      "Success Criteria": "sha256:8b4dde1f3fd8609b73fea964c9d6fcde02cfdb9d45fdbe91b7d5df969d5645e8",
      "Proposed Changes": "sha256:6c45fc75b0c3ef08b91a5a1dec1d0751a34d2321c927aa5546f364505541db72",
      "Rollback & Blast Radius": "sha256:59f253492dd098b13a19b3587d98039a040e664ab1acda0151cda9b82ecfb260",
      "Verification Plan": "sha256:39e313357128b1dd00a48fab68fd5c7e1d1aeac01a92ed6d6e8d5e9c3a02eb3b",
      "Out of Scope": "sha256:fa560139b399b00ffd236f46cc527a74180809988969c92b36d460203ae0f4de"
    },
    "reviewedAt": "2026-09-28T01:32:56.700Z"
  }
}
---
# Drive Stop Diagnostics

> **TL;DR:** Driver stops and errors don't say where the run is or what to do next. Add `position` to every action, replace `error: string` with a typed `{kind, message, next}` object, and give fatal exits a structured stderr line.
> **Decide:** none
> **Risk:** med — every action schema and every caller of the `error` string changes, with no legacy form kept.
> **Scope:** `skills/dispatch/scripts/driver/*`, `skills/dispatch/references/templates/schemas/driver/adjudicate.json, skills/dispatch/references/templates/schemas/driver/apply-fixes.json, skills/dispatch/references/templates/schemas/driver/ask-user.json, skills/dispatch/references/templates/schemas/driver/author.json, skills/dispatch/references/templates/schemas/driver/delegate-write.json, skills/dispatch/references/templates/schemas/driver/done.json, skills/dispatch/references/templates/schemas/driver/launch.json, skills/dispatch/references/templates/schemas/driver/native-fallback.json, skills/dispatch/references/templates/schemas/driver/verify.json`, `skills/dispatch/SKILL.md`, driver tests and helpers

## Key Decisions & Context

Source spec: `.scratch/specs/2026-09-28-drive-stop-diagnostics-design.md`. Its decisions are settled:

- Structured JSON fields only, with no prose status banner. The host already reads stdout and stderr, so a banner would repeat facts and could drift from the JSON.
- No legacy support. `error` becomes an object and the string form is removed from every schema.
- A contract rule against reading driver source is deferred until evidence shows it is needed (see Out of Scope).
- `position` is computed once, in `position(state)` in `scripts/driver/state.mjs`, and `emitAction` calls it. Individual phase modules don't assemble it themselves.
- `DriverError(kind, message, next?)` lives in `scripts/driver/actions.mjs`, next to `emitAction`, so every phase module already imports its home.
- Error classification happens once, in `toError(err)` in `actions.mjs`:
  - `DriverError` keeps its kind.
  - `UsageError` maps to `reply`.
  - Anything else maps to `fault`.
  - Both the re-emit path (`implement-phase.mjs` catch, `index.mjs` reply checks) and the fatal path (`runDriver` catch) use it.
- Fatal exits keep stdout empty and leave the persisted `pending` action untouched. A synthetic `done` would falsely signal that the run ended.

## User Review Required

The `error` field changes shape from a string to an object, with no compatibility shim. An orchestrator that reads `error` as a string must switch to `error.message`.

## Open Questions & Assumptions

- The `ask` flow has one phase, so `position.phase` is `"ask"`. It has no steps, so `step` is omitted.
- Review runs take `phase` from the review state's `phase`, for example `plan-review`. Forwarded nested reviews inside implement report the implement flow, with `phase` from `state.ordinary.phase` and `wave` from `state.reviewState.wave`.
- `wave` is `{type, round}` from `state.wave` (review) or `state.adjudication.{waveType, round}` (adjudication), whichever is active. It is omitted otherwise.
- Throw sites whose message already names a recovery step (for example "resume with …" or "remove the stale lock") become `DriverError('state', message, next)`. Sites with no recovery prose stay plain `Error` and surface as `fault`. The spec lists auditing individual driver bugs as a non-goal.

## Success Criteria

- [SC1] Every action emitted across the driver test suites has `position.flow` and `position.phase`. Review and adjudication actions also carry `position.wave`.
  - Changes: skills/dispatch/scripts/driver/state.mjs, skills/dispatch/scripts/driver/actions.mjs, skills/dispatch/scripts/driver/plan-phase.mjs, skills/dispatch/scripts/driver/ask-phase.mjs, skills/dispatch/references/templates/schemas/driver/adjudicate.json, skills/dispatch/references/templates/schemas/driver/apply-fixes.json, skills/dispatch/references/templates/schemas/driver/ask-user.json, skills/dispatch/references/templates/schemas/driver/author.json, skills/dispatch/references/templates/schemas/driver/delegate-write.json, skills/dispatch/references/templates/schemas/driver/done.json, skills/dispatch/references/templates/schemas/driver/launch.json, skills/dispatch/references/templates/schemas/driver/native-fallback.json, skills/dispatch/references/templates/schemas/driver/verify.json, tests/helpers/driver-harness.mjs, tests/skills/dispatch/driver/actions.test.mjs
  - Verify: `node --test --import=./tests/helpers/isolated-temp.mjs --test-reporter=./scripts/test-reporter.mjs --test-name-pattern="position" tests/skills/dispatch/driver/actions.test.mjs`
  - Evidence: red
  - Test rationale: `emitAction` validates against the schemas. Once `position` is a required property, a missing position fails every driver test. The harness also asserts on each parsed action that `position.wave` is present when `action === 'launch'` or `action === 'adjudicate'`.
- [SC2] Every emitted `error` is an object whose `kind` is `reply`, `state`, or `fault`, and no action schema accepts a string `error`.
  - Changes: skills/dispatch/references/templates/schemas/driver/adjudicate.json, skills/dispatch/references/templates/schemas/driver/apply-fixes.json, skills/dispatch/references/templates/schemas/driver/ask-user.json, skills/dispatch/references/templates/schemas/driver/author.json, skills/dispatch/references/templates/schemas/driver/delegate-write.json, skills/dispatch/references/templates/schemas/driver/done.json, skills/dispatch/references/templates/schemas/driver/launch.json, skills/dispatch/references/templates/schemas/driver/native-fallback.json, skills/dispatch/references/templates/schemas/driver/verify.json, skills/dispatch/scripts/driver/actions.mjs, skills/dispatch/scripts/driver/index.mjs, skills/dispatch/scripts/driver/implement-phase.mjs, skills/dispatch/scripts/driver/state.mjs, skills/dispatch/scripts/driver/drive.mjs, tests/skills/dispatch/driver/actions.test.mjs
  - Verify: `node --test --import=./tests/helpers/isolated-temp.mjs --test-reporter=./scripts/test-reporter.mjs --test-name-pattern="typed error" tests/skills/dispatch/driver/actions.test.mjs`
  - Evidence: red
  - Test rationale: The test iterates over all nine schemas, asserts that a string `error` fails validation, and asserts that `{kind:'fault', message:'x'}` passes.
- [SC3] Error kinds are classified correctly:
  - An invalid reply yields `kind: "reply"` and leaves state unchanged.
  - A stale advance lock yields `kind: "state"` with `next`.
  - An injected unexpected throw yields `kind: "fault"`.
  - Changes: skills/dispatch/scripts/driver/index.mjs, skills/dispatch/scripts/driver/implement-phase.mjs, skills/dispatch/scripts/driver/actions.mjs, tests/skills/dispatch/driver/cli.test.mjs
  - Verify: `node --test --import=./tests/helpers/isolated-temp.mjs --test-reporter=./scripts/test-reporter.mjs --test-name-pattern="error kind" tests/skills/dispatch/driver/cli.test.mjs`
  - Evidence: red
  - Test rationale: The test drives the real CLI through three cases:
    - An invalid `--input` against a pending action. The test compares `state.json` bytes before and after.
    - A pre-created `<state>.advance.lock`. This reaches the fatal path, so the test asserts the stderr kind `state` and a `next:` segment.
    - A `toError(new TypeError('boom'))` unit call alongside a CLI run whose state file has corrupted phase data, so the phase module throws an untyped error.
- [SC4] The exit-2 output of `runDriver` matches `^\[dispatch driver\] (reply|state|fault): .+` and includes `state: <path>` when `--state` was given.
  - Changes: skills/dispatch/scripts/driver/index.mjs, tests/skills/dispatch/driver/cli.test.mjs
  - Verify: `node --test --import=./tests/helpers/isolated-temp.mjs --test-reporter=./scripts/test-reporter.mjs --test-name-pattern="fatal line" tests/skills/dispatch/driver/cli.test.mjs`
  - Evidence: red
  - Test rationale: The test runs a usage error without `--state` (expects `reply:` and no `state:`) and the stale lock with `--state` (expects `state:` plus the path). It also asserts that stdout is empty.
- [SC5] The `SKILL.md` word count does not increase, `npm test` passes, and skill hashes are regenerated.
  - Changes: skills/dispatch/SKILL.md, skills/dispatch/skill-hashes.json
  - Verify: `npm test` [FINAL]
  - Evidence: verify
  - Test rationale: Aggregate gate only; SC1-SC4 carry the behavioral RED, and a word-count test would be low-signal.
  - Review: artifact: skills/dispatch/SKILL.md; scenario: diff Run step 3 against HEAD and compare `wc -w`; pass: the new count is ≤ the HEAD count, and step 3 says that `error.kind` `fault` means stop and report.

## Proposed Changes

### Driver envelope

#### [MODIFY] skills/dispatch/scripts/driver/state.mjs
- Changes: Add the exported `position(state)`, which returns `{flow, phase, step?, wave?}`:
  - `flow` is `state.invocation.verb`.
  - `phase` is `state.ordinary?.phase`, then `state.phase` (review), then `'ask'` for the ask verb.
  - `step` is `state.ordinary?.step` when set.
  - `wave` is `{type, round}` from `state.wave`, `state.reviewState?.wave`, or `state.adjudication` (`waveType`, `round`) when present.
  - `reemit(state, error)` normalizes `error` through `toError`, so callers that pass strings (review-phase and ask-phase native-fallback and reply checks) emit typed `reply` errors.
- Invariants: `position` is a pure read. It never writes state, and omits a key rather than emitting null.

#### [MODIFY] skills/dispatch/scripts/driver/actions.mjs
- Changes:
  - `emitAction` adds `position: position(state)` to the fixed envelope keys.
  - Add the exported `class DriverError extends Error { kind; next }`.
  - Add the exported `toError(err)`, which returns `{kind, message, next?}`. It recognizes `UsageError` by `err.name === 'UsageError'`, which avoids an import cycle with `index.mjs`.
- Invariants: Envelope schema validation is still enforced at emit.

#### [MODIFY] skills/dispatch/references/templates/schemas/driver/adjudicate.json
- Changes:
  - `error` becomes an object with required `kind` (enum `reply|state|fault`) and `message`, an optional `next`, and `additionalProperties: false`. The schema requires `next` when `kind` is `state`.
  - Add a required `position` object with required `flow` and `phase`, optional `step`, and optional `wave {type, round}`.
- Invariants: All other properties are unchanged.

#### [MODIFY] skills/dispatch/references/templates/schemas/driver/apply-fixes.json
- Changes: Same `error` and `position` schema change as `adjudicate.json`.

#### [MODIFY] skills/dispatch/references/templates/schemas/driver/ask-user.json
- Changes: Same `error` and `position` schema change as `adjudicate.json`.

#### [MODIFY] skills/dispatch/references/templates/schemas/driver/author.json
- Changes: Same `error` and `position` schema change as `adjudicate.json`.

#### [MODIFY] skills/dispatch/references/templates/schemas/driver/delegate-write.json
- Changes: Same `error` and `position` schema change as `adjudicate.json`.

#### [MODIFY] skills/dispatch/references/templates/schemas/driver/done.json
- Changes: Same `error` and `position` schema change as `adjudicate.json`.

#### [MODIFY] skills/dispatch/references/templates/schemas/driver/launch.json
- Changes: Same `error` and `position` schema change as `adjudicate.json`.

#### [MODIFY] skills/dispatch/references/templates/schemas/driver/native-fallback.json
- Changes: Same `error` and `position` schema change as `adjudicate.json`.

#### [MODIFY] skills/dispatch/references/templates/schemas/driver/verify.json
- Changes: Same `error` and `position` schema change as `adjudicate.json`.

#### [MODIFY] skills/dispatch/scripts/driver/plan-phase.mjs
- Changes: `forwardReview` re-stamps `position: position(state)`, so forwarded nested-review actions report the parent implement flow.
- Invariants: Apply-fixes path restriction is unchanged.

#### [MODIFY] skills/dispatch/scripts/driver/ask-phase.mjs
- Changes: `state.wave` gains `type: 'ask', round: 1`, matching `launchAction`, so `position.wave` is well formed on ask launches.
- Invariants: `launchAction` output is otherwise unchanged.

### Error paths

#### [MODIFY] skills/dispatch/scripts/driver/index.mjs
- Changes:
  - Invalid-reply and round-cap re-emits return `error: {kind:'reply', message}`.
  - The stale-lock and unreadable-state throws become `DriverError('state', message, next)`.
  - The `runDriver` catch writes `[dispatch driver] <kind>: <message>[ | next: <next>][ | state: <parsed.state>]` and returns 2. The parsed args are hoisted so `state` is known in the catch.
- Invariants: stdout is empty on exit 2, and the persisted `pending` action is never rewritten on a fatal path.

#### [MODIFY] skills/dispatch/scripts/driver/implement-phase.mjs
- Changes: The advance catch returns `{ ...state.pending, error: toError(error) }`. Reply-shape checks in the `*-phase.mjs` modules that reject a host reply throw `DriverError('reply', …)`, and recovery-prose throws use `'state'`.
- Invariants: `restoreArtifacts` still runs before the re-emit.

#### [MODIFY] skills/dispatch/scripts/driver/drive.mjs
- Changes: The repeat-failure guard compares `next.action === action.action && next.error?.kind === action.error?.kind`.
- Invariants: Launch and verify stderr banners are unchanged.

#### [MODIFY] skills/dispatch/scripts/driver/review-phase.mjs
- Changes: Any `error` placed on an emitted action becomes a typed object. Internal `{ error }` return values that never reach an envelope (mapping checks, recorded report failures) stay strings.
- Invariants: Recorded failure data is unchanged.

### Contract

#### [MODIFY] skills/dispatch/SKILL.md
- Changes: Reword Run step 3 to say that an `error` names its `kind` and that `fault` means stop and report `stateFile`. The word count must stay net-neutral or lower, and the edit applies `writing-for-agents`.

### Tests

#### [MODIFY] tests/helpers/driver-harness.mjs
- Changes: Every parsed action asserts that `position.flow` and `position.phase` are present, and that `position.wave` is present for `launch` and `adjudicate`.

#### [MODIFY] tests/skills/dispatch/driver/actions.test.mjs
- Changes: Add the `position` and `typed error` schema tests.

#### [MODIFY] tests/skills/dispatch/driver/cli.test.mjs
- Changes: Add the `error kind` and `fatal line` CLI tests.

#### [MODIFY] tests/skills/dispatch/driver/*.test.mjs
- Changes: Update existing assertions that match `error` as a string (for example `assert.match(action.error, …)`) to `action.error.message`, and assert `kind` where the case is classified.

#### [GENERATED] skills/dispatch/skill-hashes.json
- Command: `npm run hashes`

## Rollback & Blast Radius

The orchestrator contract (`SKILL.md`) and every driver test consume the envelope. Rollback is a single revert, because the driver, schemas, and contract ship together. There are no persisted-state migrations: `position` is derived at emit time, and a `pending` action cached by an older driver is only re-emitted, never re-validated.

## Verification Plan
### Automated Tests
- `npm test`
### Manual Verification
- Drive a `review plan` run to its first `launch` and confirm that `position.wave` matches `launch.wave`.
- Create `<state>.advance.lock` by hand and confirm the one-line `state:` diagnostic with `next`.

## Review Findings & Resolutions
<!-- Populated during plan review cycles -->
<!-- Rounds use the source-map and entry format in dispatch references/review.md § Resolution log. -->

<!-- dispatch-review-budget {"schemaVersion":1,"phase":"plan-review","budgetId":"762813ec-fb26-4088-9332-bd8fc90ea1ef:plan-review","reviewWaves":1,"roundLimit":2} -->

### Round 1 — 2026-09-28
- **Sources:** {"plan-review:R1:agy:0":{"candidateIndex":0,"effort":"medium","model":"gemini-3.7-flash","provider":"agy","session":null,"status":"target","substitutesFor":null}}
- failed-targets: []
- **[Accepted]** [R1-F001] [MUST] [sources=plan-review:R1:agy:0] § Proposed Changes — correctness: In skills/dispatch/scripts/driver/state.mjs:L318-L322, reemit(state, error) assigns error directly to state.pending. Callers across skills/dispatch/scripts/driver/review-phase.mjs:L861 and skills/dispatch/scripts/driver/ask-phase.mjs:L177 pass string error messages into reemit. If reemit is not updated to normalize errors via toError(error), re-emitted actions will retain string errors, violating SC2 and failing schema validation across the updated action schemas. → Verified: reemit stores raw string errors from review/ask callers. Plan adds reemit normalization via toError.
  - application: {"v":1,"findingId":"R1-F001","state":"applied","scope":"in-scope","affectedPaths":[".scratch/dispatch-skills/20260928T0121Z-993a64cf8684-plan-drive-stop-diag/artifacts/drive-stop-diagnostics.md"],"dependsOn":[],"verification":[],"reason":"applied; no verification commands"}
- **[Accepted]** [R1-F002] [SHOULD] [sources=plan-review:R1:agy:0] § Proposed Changes — architecture: In nested review executions during implement (e.g. plan review or code review), forwardReview in skills/dispatch/scripts/driver/plan-phase.mjs:L83-L90 forwards child review actions via { ...action, stateFile: state.stateFile } without updating action.position. Because action was emitted by the child review state where state.invocation.verb is 'review', action.position.flow will remain 'review' instead of reporting the parent implement flow as required by Open Questions & Assumptions. → Verified: forwardReview spreads the child action unchanged. Plan re-stamps position in forwardReview.
  - application: {"v":1,"findingId":"R1-F002","state":"applied","scope":"in-scope","affectedPaths":[".scratch/dispatch-skills/20260928T0121Z-993a64cf8684-plan-drive-stop-diag/artifacts/drive-stop-diagnostics.md"],"dependsOn":[],"verification":[],"reason":"applied; no verification commands"}
- **[Accepted]** [R1-F003] [SHOULD] [sources=plan-review:R1:agy:0] § Proposed Changes — edge-case: In skills/dispatch/scripts/driver/ask-phase.mjs:L88-L92, state.wave is initialized without type or round properties ({ argv, outputPath, promptPath, selectedTargets }), unlike skills/dispatch/scripts/driver/review-phase.mjs:L420-L432. When launchAction is emitted during startAsk, position(state) reading { type, round } from state.wave will produce undefined fields, violating the schema for wave or failing the SC1 harness assertion that position.wave is present on launch. → Verified: ask state.wave lacks type/round. Plan sets type 'ask', round 1 in state.wave.
  - application: {"v":1,"findingId":"R1-F003","state":"applied","scope":"in-scope","affectedPaths":[".scratch/dispatch-skills/20260928T0121Z-993a64cf8684-plan-drive-stop-diag/artifacts/drive-stop-diagnostics.md"],"dependsOn":[],"verification":[],"reason":"applied; no verification commands"}

<!-- dispatch-review-budget {"schemaVersion":1,"phase":"plan-review","budgetId":"762813ec-fb26-4088-9332-bd8fc90ea1ef:plan-review","reviewWaves":2,"roundLimit":2} -->

### Round 2 — 2026-09-28
- **Sources:** {"plan-review:R2:agy:0":{"candidateIndex":0,"effort":"medium","model":"gemini-3.7-flash","provider":"agy","session":null,"status":"target","substitutesFor":null}}
- failed-targets: []

## Out of Scope
- A prose status banner, output on unchanged polls, and changes to the existing `launch`/`verify` stderr banners.
- Fixing individual driver bugs. This plan only makes them surface as `fault`.
- The evidence-gated follow-up: after shipping, run an implement flow that hits a concerns stop and a failure-disposition stop. If the orchestrator still opens `skills/dispatch/scripts/driver/**` without a `fault`, add a `SKILL.md` rule.
