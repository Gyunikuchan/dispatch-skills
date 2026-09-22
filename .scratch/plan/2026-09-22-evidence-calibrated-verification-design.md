# Evidence-calibrated verification

## Context & Intent

`implement-dispatch` currently requires a tests-only launch and host-observed RED whenever an
increment introduces "new or corrected behavior." That boundary treats executable behavior,
agent-consumed prose, and human documentation alike. Recent implementation sessions showed two
failure modes:

- prose-only criteria encouraged shallow string-presence tests whose failure proved missing wording,
  not the intended agent behavior;
- workflow guarantees described in prose remained vulnerable to agent variance until moved into a
  script or schema and covered by behavioral tests.

Intent: choose the cheapest durable evidence that can falsify each delivery claim. Require RED only
when a retained test demonstrates the targeted behavioral gap and will provide useful future
regression signal. Give changes without a high-signal test explicit non-RED evidence requirements
rather than exemptions with no proof. Prose is one example, not a special case.

## Goals & Requirements

### Goals

- **G1 — Evidence matches the claim.** Each success criterion declares how its outcome can be
  demonstrated before implementation.
- **G2 — RED remains strict.** New or corrected executable behavior still requires a tests-only
  launch, a quality matrix, and host-observed failure for the expected reason.
- **G3 — Tests earn their maintenance cost.** Add a test only when its failure discriminates the
  targeted defect and retaining it protects against a plausible regression.
- **G4 — Critical guarantees become executable.** A correctness, safety, recovery, durability, or
  protocol guarantee cannot use prose evidence when deterministic enforcement is feasible.
- **G5 — Mixed changes work.** One plan may contain RED-gated and non-RED criteria without weakening
  either class.
- **G6 — Regression safety remains universal.** Every shipped change still receives its mapped
  verification commands and the repository's final test suite.

### Non-goals

- No removal of the RED-quality gate for executable behavior.
- No general-purpose natural-language evaluation framework.
- No claim that prose review proves downstream model behavior deterministically.
- No automatic inference of evidence class from file extension, change type, or implementation
  language alone.
- No relaxation of baseline, freshness, side-effect, approval, review, or failure-disposition rules.

### Requirements

**R1 — Criterion evidence class.** Every success criterion has exactly one `Evidence:` mapping:

- `red` — a retained pre-production failing test demonstrates the missing behavior and supplies
  durable regression value;
- `verify` — an existing or newly added post-change check demonstrates the outcome, but a meaningful
  retained regression test or pre-change failure is not expected;
- `review` — correctness requires bounded human/agent inspection or a scenario evaluation because
  no deterministic executable oracle exists.

`Changes:` and `Verify:` remain required according to the existing plan contract. `review` also
requires a concrete `Review:` instruction naming the artifact, scenario, and observable pass
condition. A bare statement such as "review the prose" is invalid.

**R2 — Evidence ladder.** Select evidence in this order, stopping at the first option that can
reliably falsify the criterion without disproportionate maintenance cost:

1. reuse an existing mapped test or check;
2. add a retained `red` test when it passes the signal threshold in R3;
3. use a deterministic post-change `verify` check;
4. use bounded `review` with a concrete scenario and observable pass condition.

This applies to every change type. Executable code does not automatically require a new test;
prose does not automatically avoid one. Exact machine-consumed text, examples, schemas, generated
artifacts, and configuration may justify tests. Refactors, wiring, one-time migrations, cosmetic UI,
non-deterministic integration behavior, and prose may be better served by existing checks,
type/build validation, scenario execution, or review.

A critical correctness, safety, recovery, durability, or protocol guarantee may use `review` only
when the plan records why executable enforcement is infeasible. Otherwise move enforcement into
code/schema and classify that enforcing criterion as `red` or `verify`.

**R3 — Test signal threshold.** A new test is warranted only when all are true:

- **Discriminating:** failure identifies the targeted behavioral defect, not merely changed text,
  call order, implementation structure, or a broad unrelated failure;
- **Stable:** the oracle and failure identity are deterministic enough for CI;
- **Regression-bearing:** the protected behavior is plausible to break again and important enough
  to detect automatically;
- **Proportionate:** expected defect-detection value exceeds test runtime, brittleness, fixture,
  and maintenance cost;
- **Behavioral:** the assertion targets an observable contract; implementation-detail assertions
  require an explicit rationale.

If any condition fails, use `verify` or `review` and record a one-line `Test rationale:` explaining
why a new retained test would be low-signal. If `red` is selected, record why the test passes the
threshold. Plan lint requires the rationale but does not attempt to score value mechanically;
plan review adjudicates it.

**R4 — Plan validation.** Plan lint rejects missing/unknown evidence classes, missing test
rationales, `review` without a concrete `Review:` instruction, and critical guarantees assigned to
`review` without an infeasibility rationale. Classification is explicit and stable; paths and
change types may inform lint messages but never silently choose the class.

**R5 — Selective RED gate.** The tests-only launch and `RED-MATRIX` cover only `red` criteria.
`red-quality` rejects matrix rows for other classes and succeeds without a RED invocation when a
plan contains no `red` criteria. A mixed plan enters production only after every `red` criterion has
valid host-observed RED evidence.

**R6 — Non-RED evidence.** `verify` criteria run their mapped checks after the relevant mutation and
again at final verification. `review` criteria record the reviewer/scenario, inspected revision,
observable result, and limitations in the walkthrough. Review evidence must be fresh after the last
mapped prose mutation.

**R7 — Universal regression verification.** Evidence classification changes the pre-production gate,
not completion standards. All settled automated commands still run after mapped mutations, and
`npm test` remains required by repository policy. Existing known-red equivalence and freshness rules
remain unchanged.

**R8 — Delegation boundaries.** A no-`red` plan skips the tests-only write-subagent launch and proceeds
to the approved implementation launch. A mixed plan gives the tests-only subagent only the paths and
criteria classified `red`. Implementation envelopes and attempt accounting remain unchanged except
that `RED_READY` is required only when at least one `red` criterion exists.

**R9 — Compatibility.** Existing plans without `Evidence:` fail with an actionable migration
diagnostic rather than defaulting to `red` or bypassing the gate. The diagnostic lists each missing
criterion and the three accepted classes.

## Architecture & Boundaries

The plan is the classification source of truth. Plan parsing exposes each criterion's evidence
class and optional review instruction. The implementation driver derives one of two branches:

1. one or more `red` criteria: run the existing tests-only and RED-quality flow over that subset;
2. no `red` criteria: record `RED gate: not applicable — no red-class criteria` and continue after
   approval.

Verification evidence owns post-change `verify` records and freshness. Walkthrough evidence owns
structured `review` records. The driver consumes these results; it does not infer semantic quality
from prose or filenames.

## Alternatives & Decisions

### Decision: evidence value, not change category

The governing question is not "is this prose?" or "is this code?" but "what evidence can falsify
this claim, and will retaining it provide signal worth its cost?" This avoids both synthetic prose
tests and low-value implementation-detail tests for code.

### Decision: explicit three-class evidence mapping

Chosen over a prose-only exception because an exception answers only whether RED is skipped, not
how the criterion will be proven. Chosen over binary `red/not-red` because deterministic post-change
checks and judgment-based review have different completion evidence.

### Decision: classify criteria, not files or whole plans

Mixed increments are common. Plan-level classification would either force synthetic RED for prose
or allow executable behavior to bypass RED.

### Decision: move enforceable guarantees out of prose

A model instruction may clarify behavior, but it is not reliable enforcement for critical
invariants. Script/schema enforcement plus RED tests is the preferred implementation whenever
feasible.

### Rejected: automatically treating Markdown as review-only

Markdown can contain machine-consumed contracts, templates, fixtures, or generated content. File
extension is insufficient evidence.

### Rejected: preserving RED through snapshot/string tests

A test that only fails because expected wording is absent proves textual shape, not the semantic
outcome. Such a test remains valid only when exact text is itself a public or machine-consumed
contract; that criterion is then `red` or `verify` based on whether pre-change failure is meaningful.

## Risks, Security & Operations

- **Under-classification:** agents may label behavior `review` to avoid RED. Mitigate with explicit
  rationale, critical-guarantee checks, and plan review.
- **Over-classification:** agents may retain `red` for every change because it appears safer.
  Mitigate with the five-part signal threshold and reviewer rejection of tests whose failure proves
  wording, structure, mocks, or incidental ordering rather than behavior.
- **Value theater:** rationales may become boilerplate. Review prompts must challenge the weakest of
  discriminating, stable, regression-bearing, proportionate, and behavioral, rather than accepting
  the presence of a rationale.
- **Subjective review evidence:** scenario review may vary by model. Record the exact scenario,
  revision, result, and limitation; never represent it as deterministic proof.
- **Migration disruption:** old plans become invalid. Provide criterion-specific diagnostics and a
  documented migration example.
- **Mixed-scope leakage:** the tests-only subagent could edit non-RED paths. Preserve path mutation
  checks and treat leakage as invalid RED under existing failure disposition.

Rollback is contract-level: restore mandatory RED for all new/corrected behavior and remove evidence
classification. Plans authored with `Evidence:` remain readable as extra mappings during rollback.

## Increment Dependency Graph

| ID | Priority | Summary | Prerequisites | Paths |
| --- | ---: | --- | --- | --- |
| I01 | 1 | Define and parse criterion evidence classes | none | plan template, plan parser/lint, tests |
| I02 | 2 | Make RED-quality and implementation branching criterion-selective | I01 | RED-quality, driver, tests |
| I03 | 3 | Capture verify/review evidence and update agent contracts | I02 | verification evidence, walkthrough, contracts, docs, tests |

## Increment Details

### I01
- Outcome: plans require a validated evidence class for every success criterion.
- Scope: grammar, parsing, lint diagnostics, compatibility diagnostics, and representative fixtures.
- Non-scope: changing implementation control flow.
- Observable behavior: old or ambiguous plans fail with criterion-specific remediation; valid mixed
  plans expose stable parsed classes and test-value rationales.
- Affected contracts: plan schema/template and plan-lint output.
- Validation: parser/lint tests cover all classes, missing rationales, malformed mappings, review
  instructions, critical guarantees, and mixed plans.
- Rollback boundary: restores the previous success-criterion grammar.
- Parallel safety: unsafe beside I02; safe beside unrelated provider-runner work.

### I02
- Outcome: RED is required exactly when at least one criterion is classified `red`.
- Scope: subset matrix validation, no-RED branching, delegated path bounds, attempt transitions, and
  mixed-plan behavior.
- Non-scope: changing post-implementation evidence formatting.
- Observable behavior: prose-only plans skip tests-only delegation with an explicit reason; mixed
  plans gate only their RED criteria; executable behavior remains blocked without valid RED.
- Affected contracts: RED-quality input/output and implementation driver actions.
- Validation: red-green tests prove no-RED, all-RED, mixed, leakage, malformed matrix, and resume
  behavior.
- Rollback boundary: restores universal new/corrected-behavior RED branching.
- Parallel safety: depends on I01 and is unsafe beside implementation-driver changes.

### I03
- Outcome: non-RED criteria have fresh, auditable completion evidence and all user/agent guidance
  reflects the new policy.
- Scope: structured walkthrough records, freshness checks, agent execution contracts, human manual,
  examples, and migration guidance.
- Non-scope: generalized model benchmarking.
- Observable behavior: completion fails when a `verify` command or required `review` record is
  missing/stale; final handoff distinguishes deterministic verification from review evidence.
- Affected contracts: verification evidence, walkthrough minimum contract, implementation guidance,
  and README behavior.
- Validation: behavioral tests cover evidence freshness and missing records; documentation examples
  pass repository validation; full `npm test` passes or matches an accepted unchanged baseline.
- Rollback boundary: removes structured non-RED records while leaving I01/I02 classification usable.
- Parallel safety: begins after I02; documentation work may proceed in parallel only after output
  shapes settle.

## Final Integration

Run one ordinary implementation flow for each representative plan shape: all-RED, no-RED
low-signal code change, no-RED agent prose, no-RED human documentation, and mixed. Confirm tests-only launch counts, path bounds,
ledger transitions, walkthrough evidence, resume behavior, known-red handling, and final freshness.
Run the complete repository test suite and regenerate shipped skill hashes.

## Execution Status

| ID | State | Summary | Next Action |
| --- | --- | --- | --- |
| I01 | ready | Define and parse criterion evidence classes | implement:I01 |
| I02 | blocked | Make RED-quality and implementation branching criterion-selective | blocked by I01 |
| I03 | blocked | Capture verify/review evidence and update agent contracts | blocked by I02 |

Next Action: implement:I01

## Review Findings & Resolutions

None; this specification has not undergone design review.
