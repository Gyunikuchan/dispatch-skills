---
{
  "dispatch": {
    "schemaVersion": 1,
    "kind": "plan",
    "slug": "refine-flow-level-classifier-honor",
    "invocationId": "b394880f-72ce-420b-8a35-cd5c7e4e9273",
    "contentHash": "sha256:166f90706089cae0a40f9901a488fde32d2247af78e2dcf2860db2a3650a8809",
    "sectionHashes": {
      "__preamble__": "sha256:ba158a8d6796c07f191a3232381aa216b31e39ffd484d0a5d2270ac4fff0a3b6",
      "Background": "sha256:3f8ef733a6eb4b0938f172d7b6f6a0d8c7a09b147343a1f451659cb36591684c",
      "Key Decisions & Context": "sha256:43a00370e1d8ff9fcdabdc1a056d568ec272f865737162532fbb851f8e8cefcb",
      "User Review Required": "sha256:ff13ac360899fcf81a0c84655b4d2bf10e9043f70f3e5f66d400bdd0aed2178a",
      "Open Questions & Assumptions": "sha256:48aecbd18c2217977a9a3d1965ad8c607b1b937b36bf94a10089b9bfc8cdaab9",
      "Success Criteria": "sha256:60967f4902b8f209ccc75d86bb94c0eacc597dada10e8334b70dd36d41d014ea",
      "Proposed Changes": "sha256:51c080ac5d2a55640cee938a6e5f5cde34748ce54fbf7f8c6e47a20503c59017",
      "Rollback & Blast Radius": "sha256:1b3c70f3e310eeeb43f37c35394c95d1482285b3f4568ec3b3276b7201ed2e2e",
      "Verification Plan": "sha256:a007e443e5c8669a7d340ee8ed0223b31e8b73136929557993b870bddd05a19c",
      "Out of Scope": "sha256:2c3403352c53b93bc452fbfdc5a4d87b7b7ddcb119c349eb280a540483f08348"
    },
    "reviewedAt": "2026-09-29T14:21:11.831Z"
  }
}
---
# Refine Flow Level Classifier, Honor Config Skips, and Pre-Implementation Level Re-Evaluation

> **TL;DR:** Honor configured review skips for classified levels without auto-raising to high, add blast radius rubric to SKILL.md, and support pre-implementation level re-evaluation at the approval gate.
> **Parent:** user request
> **Decide:** none
> **Risk:** low — backward-compatible refinement to level resolution and approval reply parsing with no schema breakage.
> **Scope:** skills/dispatch/scripts/driver/review-policy.mjs, skills/dispatch/scripts/driver/baseline-phase.mjs, skills/dispatch/SKILL.md, skills/dispatch/references/readme/configuration.md, skills/dispatch/references/review.md, tests

## Background
In `skills/dispatch/scripts/driver/review-policy.mjs:48-61`, `resolveReviewLevel` auto-raises a `classified` level to the lowest enabled level whenever a phase is disabled at that level by config (`rounds: 0` or `targets: 0`). Consequently, runs frequently execute at `high`. Furthermore, `skills/dispatch/SKILL.md:33` lacked an operational rubric defining `low`, `medium`, and `high`, causing models to default conservatively to high.

## Key Decisions & Context
- D1 (Honor Configured Skips): When a phase policy disables a level (`phaseEnabled(policy, level) === false`), `resolveReviewLevel` emits `{ outcome: 'skipped' }` for both `classified` and `explicit` levels, removing the auto-raise mechanism.
- D2 (Option 1 Blast Radius Rubric): Define `low`, `medium`, and `high` in `SKILL.md` by runtime blast radius and protocol invariants (leaf/docs/pure tests = low; subsystem/flags/lint = medium; wire protocol/state persistence/write boundaries = high).
- D3 (Two-Gate Re-Evaluation): Level is classified at Flow Resolution (initial entry for any verb including standalone review), and re-evaluated at Pre-Implementation during the baseline approval gate via `{ decision: "approved", ..., level }`. Code review within an implementation run inherits this settled level.
- D4 (Explicit Level Invariance): When levelSource is `explicit`, `answer.level` in the approval reply is ignored so model re-evaluation at approval cannot override user-explicit levels, preserving explicit user choices and explicit-low auto-approval.
- D5 (Re-evaluation Logging & Range): Re-evaluation at approval records the effective level in the approval ledger event and `data.approval`; any classifiable level (`low`, `medium`, `high`) is permitted when `levelSource !== 'explicit'`.

## User Review Required
None.

## Open Questions & Assumptions
None.

## Success Criteria
- [SC1] `resolveReviewLevel` skips when a phase is disabled by config for classified, default, or explicit levels without auto-raising to high.
  - Changes: skills/dispatch/scripts/driver/review-policy.mjs, tests/skills/dispatch/driver/review.test.mjs
  - Verify: `node --test --import=./tests/helpers/isolated-temp.mjs --test-reporter=./scripts/test-reporter.mjs tests/skills/dispatch/driver/review.test.mjs`
  - Evidence: verify
  - Test rationale: Verifies that when a phase is disabled by policy at a given level, `resolveReviewLevel` emits skipped instead of auto-raising to high.
- [SC2] Baseline approval gate accepts optional `level` in the approval reply when levelSource is not explicit, validates classifiability, rejects invalid levels, and updates `state.invocation.level` for subsequent tasks and code review.
  - Changes: skills/dispatch/scripts/driver/baseline-phase.mjs, tests/skills/dispatch/driver/ordinary-segments.test.mjs
  - Verify: `node --test --import=./tests/helpers/isolated-temp.mjs --test-reporter=./scripts/test-reporter.mjs --test-name-pattern="re-classification" tests/skills/dispatch/driver/ordinary-segments.test.mjs`
  - Evidence: verify
  - Test rationale: Confirms that an approved reply specifying `{ decision: "approved", level: "..." }` updates state invocation level when levelSource is classified, rejects invalid levels, and ignores overrides when levelSource is explicit.
- [SC3] Skill contract and documentation specify Option 1 blast radius rubric, clarify flow resolution and pre-implementation classification timing, and describe skip behavior.
  - Changes: skills/dispatch/SKILL.md, skills/dispatch/references/readme/configuration.md, skills/dispatch/references/review.md
  - Verify: `node --test --import=./tests/helpers/isolated-temp.mjs --test-reporter=./scripts/test-reporter.mjs tests/integration/skill-contracts.test.mjs`
  - Evidence: verify
  - Test rationale: Ensures `SKILL.md` and references conform to skill contract invariants and document the blast radius rubric and approval reply shape.

## Proposed Changes

### Driver Policy & Baseline

#### [MODIFY] skills/dispatch/scripts/driver/review-policy.mjs
- Changes: Update `resolveReviewLevel` to return `{ ...base, skipped: { reason: ... } }` when `phaseEnabled(policy, level)` is false, regardless of whether `levelSource` is `explicit`, `classified`, or `default`. Remove `raisedTo` search, the `raised` property, and dead `xhigh`/`max` messages.
- Invariants: Unconfigured phases (`!policy`) still return `{ configured: false }`. `levelSource` and `level` are preserved.

#### [MODIFY] skills/dispatch/scripts/driver/baseline-phase.mjs
- Changes: In `approve(state, reply)`, if `reply.answer.level` is provided: when `state.invocation.levelSource === 'explicit'`, ignore it to preserve user intent; when `levelSource !== 'explicit'`, validate with `assertClassifiableLevel(reply.answer.level, 'classified')`, update `state.invocation.level = reply.answer.level` and `state.invocation.levelSource = 'classified'`, and record `level` in `data.approval` and the ledger approval event. Update the approval ask text at `baseline-phase.mjs:L71` to document `{decision:"approved", governingHash, testPaths, reason, level?}`.
- Invariants: If `level` is omitted from `reply.answer` or `levelSource === 'explicit'`, existing `state.invocation.level` is preserved.

### Agent Contracts & Documentation

#### [MODIFY] skills/dispatch/SKILL.md
- Changes: Add Option 1 blast radius rubric to step 1. Note that pre-implementation re-classification is supported in the approval reply.
- Invariants: Word count kept net-neutral or lower by trimming redundant words.

#### [MODIFY] skills/dispatch/references/readme/configuration.md
- Changes: Document that `rounds: 0` or unpinned `targets: 0` skips the phase for both explicit and classified levels.
- Invariants: Existing sample configuration structures and table descriptions remain valid.

#### [MODIFY] skills/dispatch/references/review.md
- Changes: Document the baseline approval reply shape under § Baseline Gate, noting the optional `level` field for pre-implementation re-classification when `levelSource !== 'explicit'`.
- Invariants: Wave and artifact lifecycle rules remain unchanged.

### Tests

#### [MODIFY] tests/skills/dispatch/driver/review.test.mjs
- Changes: Rewrite existing raise assertions (lines 70–112) to assert that disabled levels skip rather than raise for classified and default levels, and verify the `raised` field is removed.
- Invariants: Review kind inference and explicit skip tests pass.

#### [MODIFY] tests/skills/dispatch/driver/ordinary-segments.test.mjs
- Changes: Add tests for pre-implementation approval-level re-classification: `updates state invocation level when reply provides valid classified level re-classification`, `rejects invalid level on reply re-classification with DriverError`, and `ignores reply level re-classification when invocation levelSource is explicit`.
- Invariants: Existing segment relaunch and termination tests pass.

## Rollback & Blast Radius
Classified runs at `low` will now skip review phases where config sets `low: 0` (such as `config.sample.jsonc`), rather than auto-raising to `medium`. This aligns review execution with user configuration. The `raised` field is removed from `resolveReviewLevel`'s return object; consumers and tests are audited to verify no broken callers.

## Verification Plan
### Automated Tests
- `npm test`
### Manual Verification
- Verify `npm run hashes` confirms integrity or recomputes hashes if required.

## Review Findings & Resolutions
<!-- dispatch-review-budget {"schemaVersion":1,"phase":"plan-review","budgetId":"001-plan:plan-review","reviewWaves":2,"roundLimit":2} -->

### Round 1 — 2026-09-29
<!-- dispatch-sources {"plan-review:R1:claude:0":{"candidateIndex":0,"effort":"low","model":"claude-opus-5-5","provider":"claude","session":null,"status":"target","substitutesFor":null}} -->
- Reviewers: claude claude-opus-5-5 (low)
- **[Accepted]** [R1-F001] [MUST] [sources=plan-review:R1:claude:0] § Proposed Changes — state-machine: The approval-time level override always sets levelSource = 'classified', even when the user chose the level explicitly with /dispatch high .... A model-chosen reclassification at the gate can then silently overwrite the user's explicit level. It also changes behaviour that depends on levelSource: the explicit-low auto-approve check at skills/dispatch/scripts/driver/baseline-phase.mjs:L86 and the explicit-level skip wording at review-policy.mjs:L48-50. → Explicit user levels take precedence over model re-evaluation at approval. Clarify that answer.level is honored only when levelSource !== 'explicit', preserving explicit choices and explicit-low auto-approval.
  <!-- dispatch-application {"v":1,"findingId":"R1-F001","state":"applied","scope":"in-scope","affectedPaths":[".scratch/dispatch-skills/20260929T1416Z-94e66de53e04-refine-flow-level-cl/refine-flow-level-classifier-honor.plan.md"],"dependsOn":[],"verification":["node --test --import=./tests/helpers/isolated-temp.mjs --test-reporter=./scripts/test-reporter.mjs tests/skills/dispatch/plan/lint.test.mjs"],"reason":"pending --fix"} -->
  Applied → `.scratch/dispatch-skills/20260929T1416Z-94e66de53e04-refine-flow-level-cl/refine-flow-level-classifier-honor.plan.md` · verified by `node --test --import=./tests/helpers/isolated-temp.mjs --test-reporter=./scripts/test-reporter.mjs tests/skills/dispatch/plan/lint.test.mjs`
- **[Accepted]** [R1-F002] [SHOULD] [sources=plan-review:R1:claude:0] § Tests — verification: The Invariant 'All existing inference and explicit skip tests pass' contradicts SC1. The existing tests at tests/skills/dispatch/driver/review.test.mjs:L70-81 and L112 assert raised: true and level: 'high' for classified or default levels, so SC1 must rewrite them. The file also has no approve harness. Baseline approval tests live in ordinary-segments, ordinary-baseline-red, and ordinary-red-admission, so SC2's Verify command points at the wrong suite. → Rewrite existing raise tests in review.test.mjs to assert configured skip, and place baseline approval level reclassification test in ordinary-segments.test.mjs with invalid-level rejection.
  <!-- dispatch-application {"v":1,"findingId":"R1-F002","state":"applied","scope":"in-scope","affectedPaths":[".scratch/dispatch-skills/20260929T1416Z-94e66de53e04-refine-flow-level-cl/refine-flow-level-classifier-honor.plan.md"],"dependsOn":[],"verification":["node --test --import=./tests/helpers/isolated-temp.mjs --test-reporter=./scripts/test-reporter.mjs tests/skills/dispatch/plan/lint.test.mjs"],"reason":"pending --fix"} -->
  Applied → `.scratch/dispatch-skills/20260929T1416Z-94e66de53e04-refine-flow-level-cl/refine-flow-level-classifier-honor.plan.md` · verified by `node --test --import=./tests/helpers/isolated-temp.mjs --test-reporter=./scripts/test-reporter.mjs tests/skills/dispatch/plan/lint.test.mjs`
- **[Accepted]** [R1-F003] [SHOULD] [sources=plan-review:R1:claude:0] § Rollback & Blast Radius — blast-radius: 'None' understates the impact. With skills/dispatch/config.sample.jsonc:L107-110 (low: 0), every classified-low run that currently gets raised to medium review will silently skip that review phase. That is a user-visible loss of review coverage, not a strictly additive change. The raised field and the xhigh/max 'requires explicit selection' message (review-policy.mjs:L54-56) also become dead, and callers or tests reading raised are not audited. → Document the user-visible review coverage change in Rollback & Blast Radius and clarify that resolveReviewLevel removes the dead raised field while ensuring skip reasons reach the user.
  <!-- dispatch-application {"v":1,"findingId":"R1-F003","state":"applied","scope":"in-scope","affectedPaths":[".scratch/dispatch-skills/20260929T1416Z-94e66de53e04-refine-flow-level-cl/refine-flow-level-classifier-honor.plan.md"],"dependsOn":[],"verification":["node --test --import=./tests/helpers/isolated-temp.mjs --test-reporter=./scripts/test-reporter.mjs tests/skills/dispatch/plan/lint.test.mjs"],"reason":"pending --fix"} -->
  Applied → `.scratch/dispatch-skills/20260929T1416Z-94e66de53e04-refine-flow-level-cl/refine-flow-level-classifier-honor.plan.md` · verified by `node --test --import=./tests/helpers/isolated-temp.mjs --test-reporter=./scripts/test-reporter.mjs tests/skills/dispatch/plan/lint.test.mjs`
- **[Accepted]** [R1-F004] [SHOULD] [sources=plan-review:R1:claude:0] § Proposed Changes — coherence: The plan changes approve() but does not update the approval ask text that tells the orchestrator the reply shape (baseline-phase.mjs:L71). It also leaves the documented ask/reply schema unchanged (references/templates/schemas/driver/ask-user.json is already modified on this branch). Without those updates, orchestrators will never send level. → Update the approval ask text in baseline-phase.mjs:L71 to mention optional level in reply, and document the reply structure in references.
  <!-- dispatch-application {"v":1,"findingId":"R1-F004","state":"applied","scope":"in-scope","affectedPaths":[".scratch/dispatch-skills/20260929T1416Z-94e66de53e04-refine-flow-level-cl/refine-flow-level-classifier-honor.plan.md"],"dependsOn":[],"verification":["node --test --import=./tests/helpers/isolated-temp.mjs --test-reporter=./scripts/test-reporter.mjs tests/skills/dispatch/plan/lint.test.mjs"],"reason":"pending --fix"} -->
  Applied → `.scratch/dispatch-skills/20260929T1416Z-94e66de53e04-refine-flow-level-cl/refine-flow-level-classifier-honor.plan.md` · verified by `node --test --import=./tests/helpers/isolated-temp.mjs --test-reporter=./scripts/test-reporter.mjs tests/skills/dispatch/plan/lint.test.mjs`
- **[Accepted]** [R1-F005] [CONSIDER] [sources=plan-review:R1:claude:0] § Key Decisions & Context — domain-logic: Re-evaluation at the approval gate happens after plan-review has already run at the initial level. A downgrade can therefore skip code-review for work whose plan was reviewed at high, and the plan does not say whether a reclassification is logged to the ledger. → Record level reclassification in approval record and confirm that reclassification to any valid classifiable level (low, medium, high) is permitted when levelSource !== 'explicit'.
  <!-- dispatch-application {"v":1,"findingId":"R1-F005","state":"applied","scope":"in-scope","affectedPaths":[".scratch/dispatch-skills/20260929T1416Z-94e66de53e04-refine-flow-level-cl/refine-flow-level-classifier-honor.plan.md"],"dependsOn":[],"verification":["node --test --import=./tests/helpers/isolated-temp.mjs --test-reporter=./scripts/test-reporter.mjs tests/skills/dispatch/plan/lint.test.mjs"],"reason":"pending --fix"} -->
  Applied → `.scratch/dispatch-skills/20260929T1416Z-94e66de53e04-refine-flow-level-cl/refine-flow-level-classifier-honor.plan.md` · verified by `node --test --import=./tests/helpers/isolated-temp.mjs --test-reporter=./scripts/test-reporter.mjs tests/skills/dispatch/plan/lint.test.mjs`

### Round 2 — 2026-09-29
<!-- dispatch-sources {"plan-review:R2:claude:0":{"candidateIndex":0,"effort":"low","model":"claude-opus-5-5","provider":"claude","session":null,"status":"target","substitutesFor":null}} -->
- Reviewers: claude claude-opus-5-5 (low)
- **[Accepted]** [R2-F001] [SHOULD] [sources=plan-review:R2:claude:0] § Proposed Changes — coherence: R1-F004 was marked Applied, but its required change was only partly carried out. The plan updates the ask text at baseline-phase.mjs:L71. The resolution also said to document the reply structure in references, and no Proposed Changes entry, Scope line, or SC3 Changes list touches a reference or schema for this. The ask-user.json schema (skills/dispatch/references/templates/schemas/driver/ask-user.json) says nothing about governingHash, testPaths, or level. The optional level reply field therefore exists only in the driver's prompt string, and nothing in references or tests checks it. → Add skills/dispatch/references/review.md to Scope, Proposed Changes, and SC3 Changes to document the approval reply shape with optional level, aligned with the emitted ask prompt in baseline-phase.mjs.
  <!-- dispatch-application {"v":1,"findingId":"R2-F001","state":"applied","scope":"in-scope","affectedPaths":[".scratch/dispatch-skills/20260929T1416Z-94e66de53e04-refine-flow-level-cl/refine-flow-level-classifier-honor.plan.md"],"dependsOn":[],"verification":["node --test --import=./tests/helpers/isolated-temp.mjs --test-reporter=./scripts/test-reporter.mjs tests/skills/dispatch/plan/lint.test.mjs"],"reason":"verified"} -->
  Applied → `.scratch/dispatch-skills/20260929T1416Z-94e66de53e04-refine-flow-level-cl/refine-flow-level-classifier-honor.plan.md` · verified by `node --test --import=./tests/helpers/isolated-temp.mjs --test-reporter=./scripts/test-reporter.mjs tests/skills/dispatch/plan/lint.test.mjs`
- **[Accepted]** [R2-F002] [CONSIDER] [sources=plan-review:R2:claude:0] § Success Criteria — verification: SC2's Verify filter --test-name-pattern="re-classification" only works if all three new tests have that exact word in their names. The Tests section describes them as 'approval-level re-classification' tests but never gives exact test names, so the filter could match zero or only some of them. → Explicitly list the exact test titles containing 're-classification' in the ordinary-segments.test.mjs entry.
  <!-- dispatch-application {"v":1,"findingId":"R2-F002","state":"applied","scope":"in-scope","affectedPaths":[".scratch/dispatch-skills/20260929T1416Z-94e66de53e04-refine-flow-level-cl/refine-flow-level-classifier-honor.plan.md"],"dependsOn":[],"verification":["node --test --import=./tests/helpers/isolated-temp.mjs --test-reporter=./scripts/test-reporter.mjs tests/skills/dispatch/plan/lint.test.mjs"],"reason":"verified"} -->
  Applied → `.scratch/dispatch-skills/20260929T1416Z-94e66de53e04-refine-flow-level-cl/refine-flow-level-classifier-honor.plan.md` · verified by `node --test --import=./tests/helpers/isolated-temp.mjs --test-reporter=./scripts/test-reporter.mjs tests/skills/dispatch/plan/lint.test.mjs`

## Out of Scope
- Dynamic diff re-evaluation immediately before code review (deferred to keep token costs and turn counts low).
