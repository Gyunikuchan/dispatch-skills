# High-Value Durable Tests & Transient Test Lifecycle Design

- **Date:** 2026-10-25
- **Status:** Approved
- **Scope:** Shipped skill contracts (`skills/dispatch/`) and test optimization tooling (`.agents/skills/optimise-tests/`). `AGENTS.md` remains untouched so that these standards apply to all users of `dispatch`.

---

## 1. Problem Statement

Test suites easily accumulate low-value tests: trivial field assertions, mirror checks of simple pass-through logic, and fine-grained unit checks written solely to chase branch/line coverage metrics. These tests increase suite runtime and maintenance friction without defending against plausible, high-severity defects.

Furthermore, while Dispatch supports `Retain: transient` in planning, transient tests currently rely on manual post-review trimming guidance rather than a deterministic lifecycle, allowing transient tests to inadvertently leak into permanent repository test suites. Additionally, `.agents/skills/optimise-tests` historically treated line coverage preservation as a hard gate, actively preventing agents from pruning low-value tests.

---

## 2. Objectives & Principles

1. **High-Value Durability Standard:** A durable test must earn its retention by protecting against plausible high-severity defects (contract breaks, state corruption, data loss, security violations, or core protocol flows).
2. **No Trivial Spec Testing:** Trivial, mechanical, or self-evident requirements (e.g., cosmetic formatting, pass-through getters, default fallback constants) must not have dedicated durable regression tests.
3. **Coverage Demoted from Retention:** Code coverage percentage is explicitly removed as a heuristic or gating metric for durable test quality. Dropping coverage when pruning low-value tests is intentional and healthy.
4. **Coverage Bounded to Implementation TDD:** Test coverage remains a valid local exploration tool for writers during TDD implementation, but any tests created primarily for implementation-branch coverage must be marked `Retain: transient`.
5. **Deterministic Pruning in Dispatch:** Transient tests created during implementation must be deterministically pruned by Dispatch after code review passes and before delivery to the caller checkout.
6. **Optimise-Tests Repurposed for Pruning:** `.agents/skills/optimise-tests/` is decoupled from coverage gating, allowing autonomous writers to prune low-value and leaked transient tests.

---

## 3. Detailed Design

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
