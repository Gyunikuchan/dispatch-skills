# High-Value Durable Tests & Transient Test Lifecycle Design

- **Date:** 2026-10-25
- **Status:** Approved
- **Scope:** Shipped skill contracts (`skills/dispatch/`) and test optimization tooling (`.agents/skills/optimise-tests/`). `AGENTS.md` remains untouched so that these standards apply to all users of `dispatch`.

---

## 1. Context & Origin

This design originated from an evaluation of how Dispatch writers practice Test-Driven Development (TDD) and manage test lifecycle:

1. **Red-Green vs. Refactor:**
   - Dispatch task writers follow a strict **Red-Green** protocol (writing failing tests first to capture observed `RED:` failures, then implementing code until `Verify` passes).
   - An explicit, unconstrained "Refactor" phase is intentionally omitted from the writer brief to avoid known LLM failure modes: scope creep beyond assigned task paths, speculative over-engineering (violating YAGNI/KISS), and diff churn.
   - Post-integration cleanup is driven by multi-agent code reviews (`/dispatch review --kind code`) rather than an unreviewed post-task refactor step.

2. **The Test Bloat Problem:**
   - Without a clear distinction between ephemeral TDD checks and permanent regression tests, test suites accumulate low-value tests: fine-grained branch permutations, mirror assertions of trivial pass-through logic, and tests written solely to satisfy line/branch coverage metrics.
   - While Dispatch supports `Retain: transient` in planning, transient tests previously relied on manual post-review trimming guidance, allowing intermediate test scaffolding to leak into permanent test suites.
   - Furthermore, `.agents/skills/optimise-tests` historically treated line-coverage preservation as a gating barrier, preventing agents from deleting low-signal tests.

---

## 2. User Intent & Governing Decisions

Through collaborative design, the following binding decisions were established:

1. **High-Value Durability Bar:**
   - Tests are retained as durable if and only if they defend against plausible high-severity defects: consumer-facing contract breakage, state corruption, data loss, security boundaries, or broken protocol transitions.
2. **No 1:1 REQ-to-Test Mapping (Forego Trivial Specs):**
   - Not every requirement or specification item warrants a dedicated test. Simple, mechanical, or self-evident requirements (e.g., cosmetic formatting, pass-through wrappers, default fallback constants) should be foregone rather than bloating the regression suite.
3. **Coverage Demoted from Retention:**
   - Code coverage percentage is explicitly rejected as a heuristic or gate for durable test quality.
   - Dropping coverage percentage is recognized as an acceptable—and often intentional—consequence of pruning low-signal, high-maintenance tests.
4. **Coverage Bounded to Implementation TDD:**
   - Coverage remains a useful local feedback tool for the writer *during TDD implementation* to discover missed branches while working through RED/GREEN.
   - However, any tests written primarily to satisfy implementation branch coverage must be classified as `Retain: transient` rather than retained permanently.
5. **Universal Application (Shipped Skills, Not AGENTS.md):**
   - Standards must be integrated into shipped product skill files (`skills/dispatch/references/templates/quality-bar.md`, `plan.md`, `verbs/implement.md`) and `.agents/skills/optimise-tests/`, rather than local repo rules (`AGENTS.md`), ensuring all users of `dispatch` benefit.
6. **Deterministic Pruning in Dispatch:**
   - Transient test files (`*.transient.test.ts`) must be deterministically deleted by Dispatch after review passes and before caller delivery.
7. **Overhaul of `/optimise-tests`:**
   - Decouple `/optimise-tests` from coverage gating, empowering it to prune low-value and leaked transient tests across existing test suites.

---

## 3. Detailed Architecture & Workflow

### Section A: Quality Bar & Plan Conventions (`skills/dispatch/references/templates/`)

#### 1. Code Quality Bar (`quality-bar.md#code`)
The `testing` section of `quality-bar.md` is updated to define the strict durability bar:
- **Durable Retention Criteria:**
  - *High Consequence:* Defends against plausible, severe failure modes: consumer-facing contract breakage, state corruption, data loss, security boundaries, or broken protocol transitions.
  - *Non-Triviality:* Simple, mechanical, or self-evident requirements do not receive durable tests.
  - *Non-Redundant with Static Analysis:* Logic guaranteed by TypeScript compiler types, schema validators, or syntax linters must not be replicated with runtime tests.
- **Coverage Policy:**
  - Line and branch coverage are not indicators of test suite quality.
  - Coverage drop is an acceptable and intended consequence of eliminating low-value tests.
  - During TDD implementation, writers may use coverage locally to verify branch execution, but tests written to satisfy branch coverage must be isolated as `transient`.
  - Rewrite weak tests, delete hollow or redundant tests, and mark step/branch checks `transient`.

#### 2. Plan Guidance (`plan.md#field-notes`)
- Emphasize defaulting to `Retain: transient` for intermediate step verifications, internal helper checks, and fine-grained branch permutations.
- Reinforce that every transient criterion must specify `Covered by: <SC#|FINAL>`, ensuring that overall feature behavior is protected by an overarching contract test or the final test suite.

---

### Section B: Deterministic Transient Test Lifecycle in Dispatch (`skills/dispatch/`)

#### 1. Lifecycle Stages
1. **Creation & RED/GREEN:**
   - Tasks write transient tests in isolated files following runner naming conventions (e.g., `*.transient.test.ts`).
   - Writers run transient tests to capture observed RED failures and achieve GREEN status.
2. **Integration Verification & Code Review:**
   - The integration worktree runs criterion and contract checks (`verify run`) with transient test files present to verify all plan criteria held.
   - Code review (`review run --kind code`) inspects the integrated tree, verifying that the implementation meets quality standards and that durable tests adequately cover required behavior.
   - Accepted review findings are fixed directly in the integration worktree.
3. **Deterministic Pruning Gate:**
   - In `skills/dispatch/references/verbs/implement.md` (Step 6), after all review findings are resolved:
     - Dispatch deletes all declared transient test files (`*.transient.test.ts`) from the integration worktree.
     - Dispatch executes the final verification suite (`FINAL` commands / full test suite) against the pruned worktree.
     - If the suite fails because critical behavior was only covered by a deleted transient test, the gate fails and blocks delivery.
     - On green verification, the pruned worktree is committed and delivered to the caller checkout.

---

### Section C: Overhauling `/optimise-tests` (`.agents/skills/optimise-tests/`)

#### 1. Objective and Contract Changes (`SKILL.md`)
- Remove the objective of "no unapproved covered-line loss".
- Redefine the objective: a green test suite with reduced leaf-test count and reduced suite wall-clock execution time, where all retained tests satisfy the High-Value Durability Bar.
- Remove all requirements for:
  - Ledger `coverage` disposition records.
  - SHA-256 canonical digest bindings over covered-line counts.
  - User quote approvals for files reduced to zero coverage.
- Retain before/after coverage numbers solely as informational output in `compare.md`.

#### 2. Writer Criteria Updates (`references/criteria.md`)
- Expand `delete` categories to include:
  - `trivial-spec`: The test verifies simple, mechanical, or self-evident behavior that does not warrant a durable regression test.
  - `coverage-padding`: The test was written solely to exercise branches/lines without defending against plausible high-severity defects.
  - `transient-leak`: An intermediate TDD step check, internal mock exercise, or white-box detail that should have been discarded after implementation.
- Preserve existing valid deletion categories (`redundant-behavior`, `implementation-coupled-assertion`, `self-derived-assertion`).
- Positive retention (`kind: "retain"`) requires justifying the test against the High-Value Durability Bar (naming the non-trivial contract, plausible high-severity defect, and distinct contribution).

#### 3. Comparison Script Simplification (`scripts/compare.ts`)
- Remove exit failure conditions based on unresolved coverage dispositions.
- Report test counts, suite duration, and action categories.

---

## 4. Verification & Validation Strategy

1. **Static Analysis & Template Checks:**
   - Verify all links in `SKILL.md` and reference files resolve (`npm test` integration contracts).
   - Verify word count / byte limits in skill contracts remain compliant.
2. **Toolkit Unit Tests:**
   - Update `tests/unit/toolkit/domain/prompt.test.ts` and `tests/integration/skill-contract.test.ts` if test expectations reflect updated quality-bar wording.
   - Verify plan parsing and transient linter checks continue to enforce `transient-coverage` and `transient-test-path` rules.
3. **Optimise-Tests Tooling Tests:**
   - Verify `scripts/compare.ts` and associated unit tests run green with the updated criteria and non-gating coverage output.
