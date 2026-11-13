# ADR 0018: Verification stage order and naming

- **Status**: Accepted
- **Date**: 2026-11-13
- **Audience**: Maintainers

## Context

The verification surface previously overloaded `verify` across three concepts: the `verify` verb (runtime proof by a verifier subagent), the `verify run` tool action (deterministic plan criterion and contract commands), and the `Verify:` / `Evidence: verify` plan fields. Standalone `verify` ran no test command, `implement` ran every criterion command (including slow gates) after every task integration, and the verifier brief gave only one line of proof guidance.

## Decision

### Naming

Each concept has one name across the toolkit, plans, prose, and [glossary](../../skills/dispatch/references/glossary.md):

| Concept | Name |
| --- | --- |
| Deterministic command runner | `check run` (with `--criteria` or `--task`) |
| Plan criterion command field and evidence class | `Check:`, `Evidence: check` |
| Layer 1 deterministic work | checks |
| Whole verification stage (`verify` verb) | verification stage |
| Layer 2 runtime proof | runtime verification (executed by the verifier) |

`verify`, `dispatch-verify`, `## Verification Plan`, `### Manual Verification`, `RED:`, `verification` ledger records, and `verification/` directories keep their names. `verify run`, `Verify:`, and `Evidence: verify` are removed with no compatibility aliases.

### Stage order and rationale

In `implement`, the stage order is:

```text
integrate task -> check run --task <task>
all tasks integrated -> check run (all criteria + contract) -> runtime verification
-> test cleanup -> check run (all) + code review -> review fixes -> check run (all) -> re-check -> deliver
```

1. **Task-scoped checks per integration; all checks before runtime verification:** Running only the integrated task's criteria avoids repeating slow gates on every integration while keeping immediate feedback on task scope. Running `check run` across all criteria and the contract row before launching the verifier ensures cross-task regressions surface before runtime proof and routes failures to repair.
2. **Checks before runtime verification:** Deterministic checks are the first layer of the verification stage. Failing checks or a failing repository baseline prevent outcome `proved` until fixed, avoiding wasted runtime proof on broken builds or tests.
3. **Runtime verification before test cleanup:** Any gap-filling tests added by the verifier are committed before test cleanup runs, so cleanup evaluates them alongside writer tests under the retention gates.
4. **Code review after test cleanup:** Test cleanup runs on the settled post-verification tree before code review, so reviewers inspect the final retained test suite and production code together on the same HEAD.
5. **Re-check after review fixes:** When accepted review fixes change proved behaviour, `check run` passes on the new HEAD before one targeted re-check runs after all review rounds settle.

### Standalone `verify` gating and proof standards

Standalone `verify` runs `check run` first only when `status show` reports both a bound plan and a session integration (passing `checks passed` in the verifier focus). Otherwise, the verifier discovers the repository's own test command from host rule files and repository conventions, runs it, and reports it as a baseline row (a failure is an issue; finding none is a limit), keeping the stage stack-neutral without requiring a named host section or tool.

The verifier brief embeds ten stack-neutral proof standards inline with no external URL or host-layout assumption.

## Consequences

Agents and maintainers can distinguish checks from runtime verification by name. Standalone `verify` reports deterministic test status alongside runtime proof. `implement` runs slow gates once per settled HEAD without weakening pre-delivery evidence gates. Pre-existing plans using `Verify:` or `Evidence: verify` fail `lint run` until updated.
