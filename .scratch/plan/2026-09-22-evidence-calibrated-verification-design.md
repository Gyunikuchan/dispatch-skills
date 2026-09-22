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

Intent: choose the cheapest durable evidence that can falsify each delivery claim. **Tests are
diagnostic signals, not the delivery goal:** use them to expose misunderstandings, prompt deeper
investigation, and detect regressions. Red identifies evidence to investigate; green removes one
source of doubt but does not prove completeness or correctness. Require RED only when a retained
test demonstrates the targeted behavioral gap and will provide useful future regression signal.
Give changes without a high-signal test explicit non-RED evidence requirements rather than
exemptions with no proof. Prose is one example, not a special case.

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
- **G7 — Outcomes drive implementation.** The write subagent implements the governing ask/design
  outcome and settled scope; tests remain evidence and constraints, never a substitute objective.

### Non-goals

- No removal of the RED-quality gate for executable behavior.
- No general-purpose natural-language evaluation framework.
- No claim that prose review proves downstream model behavior deterministically.
- No automatic inference of evidence class from file extension, change type, or implementation
  language alone.
- No relaxation of baseline, freshness, side-effect, approval, review, or failure-disposition rules.
- No instruction to maximize test passage independently of the requested outcome.

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

**R10 — Outcome-first implementation packet.** Every full implementation launch receives one
ordered, bounded packet:

1. governing goal/outcome from the ask, ticket, or approved design increment;
2. settled scope, non-scope, invariants, and rollback boundary;
3. observable success criteria and evidence classes;
4. relevant repository constraints and prior failure evidence;
5. tests and verification commands, explicitly labeled **evidence, not specification**.

The launch instruction is `implement the smallest complete behavior satisfying the outcome and
scope`, never `make the tests pass`. Raw test files are included only when needed to execute or
understand mapped evidence; their incidental structure does not expand or narrow scope.

**R11 — Authority and conflict handling.** The governing outcome and settled plan are authoritative;
criteria refine them and tests provide evidence. If a test conflicts with, omits, or demands behavior
outside those sources, the implementer returns `NEEDS_CONTEXT` or `BLOCKED` with the exact conflict.
It must not change production behavior merely to satisfy that test. The orchestrator repairs or
reclassifies the evidence through the existing reviewed scope-change path before redispatch.

**R12 — Outcome-based completion.** Passing mapped high-signal tests remains a mandatory gate, but
is never sufficient. Treat unexpected red as diagnostic evidence requiring investigation, not an
obstacle to suppress; treat green as one resolved uncertainty, not proof of completeness. Before
`task-complete`, the implementation outcome and walkthrough map every success criterion to:

- the delivered observable behavior and production path that owns it;
- fresh evidence appropriate to its class;
- any limitation or deviation requiring a ruling.

A completion claim based only on command exit status, snapshots, mocks, action ordering, or test
names is invalid. For critical criteria, verification includes one goal-level scenario that
exercises the production path rather than a test-only seam. Code review checks outcome/scope
traceability before considering test results.

**R13 — Anti-gaming review.** Review explicitly looks for hard-coded fixtures, test-environment
branches, no-op implementations, simulated state, bypassed production paths, weakened assertions,
and behavior implemented outside approved scope. A suspicious green result triggers a bounded
counterexample or production-path scenario, not additional assertions for their own sake.

## Architecture & Boundaries

The plan is the classification source of truth. Plan parsing exposes each criterion's evidence
class and optional review instruction. The implementation driver derives one of two branches:

1. one or more `red` criteria: run the existing tests-only and RED-quality flow over that subset;
2. no `red` criteria: record `RED gate: not applicable — no red-class criteria` and continue after
   approval.

Verification evidence owns post-change `verify` records and freshness. Walkthrough evidence owns
structured `review` records and criterion-to-delivered-behavior traceability. The driver assembles
the outcome-first packet and consumes these results; it does not infer semantic quality from prose,
filenames, or green commands. Tests remain downstream evidence of the governing outcome.

## Alternatives & Decisions

### Decision: outcome hierarchy

The ask/ticket/design outcome governs, the settled plan bounds, criteria refine, and evidence checks.
Tests are diagnostic signals that prompt deeper consideration, not the end state. They cannot
silently become the specification because they are necessarily incomplete and may be wrong.
Conflicts stop for investigation and repair rather than encouraging test-driven scope drift.

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
- **Green-goal divergence:** an implementer can satisfy weak tests while bypassing the requested
  production behavior, as I04 demonstrated. Mitigate with the outcome-first packet, authority order,
  criterion-to-production traceability, goal-level scenarios, and anti-gaming review.
- **Prompt bloat:** repeating the entire ticket, plan, and tests can dilute attention. Assemble one
  bounded packet containing only governing outcome, settled boundaries, criteria, mapped evidence,
  and relevant failure history; link workspace files instead of restating them.

Rollback is contract-level: restore mandatory RED for all new/corrected behavior and remove evidence
classification. Plans authored with `Evidence:` remain readable as extra mappings during rollback.

## Increment Dependency Graph

| ID | Priority | Summary | Prerequisites | Paths |
| --- | ---: | --- | --- | --- |
| I01 | 1 | Implement outcome-first, evidence-calibrated verification atomically | none | plan grammar/lint, implementation packet, RED-quality, driver, verification evidence, walkthrough, contracts, docs, tests |

## Increment Details

### I01
- Outcome: implementation remains fixed on the governing goal and settled scope while each criterion
  selects evidence by falsifiability and durable signal; RED is mandatory only for criteria whose
  retained tests satisfy the signal threshold, and green tests never independently establish
  completion.
- Scope: deliver the complete contract and control-flow change in one atomic increment:
  1. extend criterion parsing, the plan template, and plan lint with `Evidence`, `Test rationale`,
     and conditional `Review` mappings;
  2. assemble and validate the outcome-first implementation packet and authority ordering;
  3. make RED-quality and the implementation driver operate on only `red` criteria, including the
     explicit no-RED branch and mixed-plan path bounds;
  4. capture and freshness-check structured evidence plus criterion-to-production traceability;
  5. update implementation envelopes, walkthrough records, agent contracts, human documentation,
     migration diagnostics, representative fixtures, and shipped hashes.
- Non-scope: generalized model benchmarking, automatic evidence classification, test-value scoring,
  weakening final regression verification, or changing unrelated review/provider behavior.
- Atomicity: parser, driver, evidence capture, contracts, and migration diagnostics ship together.
  No intermediate state may require the new plan grammar while retaining universal RED, or permit
  no-RED execution without enforceable post-change evidence. Internal implementation checkpoints
  are development order only, not separately releasable increments.
- Observable behavior: plans branch by declared evidence class while preserving auditable completion.
  - old or ambiguous plans fail before approval with criterion-specific migration guidance;
  - all-RED plans preserve the current tests-only launch and host-observed RED gate;
  - no-RED plans skip tests-only delegation with `RED gate: not applicable — no red-class criteria`;
  - mixed plans expose only `red` criteria and their bounded paths to the tests-only subagent;
  - completion refuses missing or stale `verify`/`review` evidence;
  - green commands without criterion-to-delivered-behavior traceability cannot complete a task;
  - conflicting or out-of-scope tests stop for evidence repair rather than drive implementation;
  - handoff distinguishes delivered outcomes, retained regression tests, deterministic checks, and
    bounded review.
- Affected contracts: plan template/parser/lint, implementation launch packet and outcome envelope,
  RED-quality input/output, driver actions and transitions, verification evidence, minimum walkthrough contract,
  `implement-dispatch` execution contract, human manual, and migration behavior.
- Validation: focused contract, driver, evidence, and end-to-end checks prove the atomic change.
  - parser/lint tests cover all evidence classes, missing or boilerplate-inadequate mappings,
    malformed rationales, review instructions, critical guarantees, mixed plans, and old-plan
    diagnostics;
  - behavioral driver tests cover packet authority/order, all-RED, no-RED low-signal code, no-RED
    agent prose, no-RED human documentation, mixed criteria, path leakage, malformed matrices,
    conflicting/out-of-scope tests, failure disposition, and interruption/resume;
  - evidence tests prove missing/stale `verify` and `review` records block completion;
  - anti-gaming fixtures prove hard-coded outputs, test-only branches, simulated state, and weakened
    assertions cannot satisfy criterion-to-production traceability;
  - representative end-to-end runs confirm goal-level behavior, launch counts, ledger transitions,
    known-red handling, final freshness, and unchanged all-RED behavior;
  - run the complete repository test suite and regenerate shipped skill hashes.
- Rollback boundary: revert I01 as one unit to restore universal RED for new/corrected behavior and
  the prior plan/evidence grammar. Plans authored with `Evidence:` remain readable as extra prose,
  but are not relied on after rollback.
- Parallel safety: unsafe beside implementation-driver, plan-grammar, RED-quality, walkthrough, or
  verification-evidence changes; implement only after the current I04 work settles. Safe beside
  unrelated provider-runner work with disjoint paths.

## Final Integration

I01 includes integration; there is no separately delivered follow-up increment. Before completion,
run representative all-RED, no-RED low-signal code, no-RED agent-prose, no-RED human-documentation,
and mixed flows, plus an I04-shaped fixture where shallow green tests omit recovery and production
state behavior. Confirm the fixture remains incomplete until the governing outcome is delivered,
then confirm tests-only launch counts, delegated path bounds, ledger transitions, walkthrough
evidence, interruption/resume, known-red handling, and final freshness. Run the complete
repository test suite and regenerate shipped skill hashes.

## Execution Status

| ID | State | Summary | Next Action |
| --- | --- | --- | --- |
| I01 | ready | Implement outcome-first, evidence-calibrated verification atomically | implement:I01 |

Next Action: implement:I01

## Review Findings & Resolutions

None; this specification has not undergone design review.
