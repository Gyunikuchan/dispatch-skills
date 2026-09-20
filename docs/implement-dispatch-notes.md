# implement-dispatch Maintainer Notes

Developer documentation, test harness hooks, and internal maintainer notes. Not loaded by agents during normal execution.

---

## 1. Architecture & Lifecycle

`implement-dispatch` orchestrates multi-agent implementation and review loops across external agent CLIs, owning control flow while delegating criteria and prompt generation to upstream skills:

```
implement-dispatch
  ├── dispatch                (Required: runner execution, cascade, CLI flags, fallback)
  ├── dispatch-plan-review    (Optional: plan template, review axes, plan adjudication)
  └── dispatch-code-review    (Optional: walkthrough template, review axes, code adjudication)
```

### Execution Pipeline

1. **Setup**: Success criteria formulation, review-owned preparation, and run initialization.
2. **Author Plan**: Initial plan creation from `dispatch-plan-review` template.
3. **Initial Change Scope & Flow**: Change-scope gating (`trivial` → `low`, `focused` → `medium`, `cross-cutting` → `high`) from the initial draft, then flow resolution (`resolve-flow.mjs`).
4. **Plan Review Loop**: Multi-agent review waves via `dispatch-plan-review` (orchestrated mode) until consensus or wave cap (`maxRounds`).
5. **Final Change Scope & Flow**: Reassess change scope and level against the reviewed plan before the approval gate, then refresh `flow` if the level changed.
6. **Implement**: Single user approval gate, native write subagent dispatch (test-first), boundary verification.
7. **Code Review**: Baseline walkthrough verification, multi-agent code review wave via `dispatch-code-review` (orchestrated mode).
8. **Apply Fixes & Settle Disputes**: Orchestrator applies accepted fixes directly inline (without dispatching implementation native subagents), updates walkthrough, verifies tests pass green, records adjudications.
9. **Re-Review Loop**: Review-owned preparation builds bounded views; source-grouped rebuttal
   packets return live claims to their citing candidates or replacements until consensus/cap.
10. **Handoff & Cleanup**: Await all review dispatches, record run diagnostics, relocate scratch artifacts to OS temp, deliver user summary.

---

## 2. Script Contracts & Exit Codes

### Flow Resolver (`scripts/resolve-flow.mjs`)

Resolves reviewer candidate targets, reserve lists, level knobs, and platform hints into a single JSON execution flow plan.

- **CLI Usage**:
  ```bash
  node resolve-flow.mjs --platform <key> [--orchestrator-model <model>] [--level <low|medium|high|xhigh|max>]
                        [--pins <keys|all|n>] [--exclude <keys>] [--validate-only]
  ```
- **Exit Codes**:
  - `0`: Valid flow JSON emitted to `stdout` (or config schema valid under `--validate-only`).
  - `1`: Invalid arguments, configuration schema violation, integrity check failure, or unresolvable pins.
- **Candidate Ordering**:
  - Live external candidates preserve configured platform and candidate order.
  - Orchestrator candidates follow every external, with exact model matches demoted to the end.
  - Named pins dispatch every listed configured platform; count and `all` pins select from the ordered candidate pool.
  - Candidates beyond `targetCount` populate `reserves` in order for dynamic substitution during `[auth]` / `[quota]` failures.

### Consensus Gate

Owned by `dispatch`; see [dispatch-notes.md](dispatch-notes.md#consensus-gate).

### Review Preparation

Each review skill owns `scripts/prepare-review.mjs`. It validates a closed JSON request, resolves
artifacts and freshness, builds bounded views/prompts/batch manifests, and returns argv plus
cleanup paths. The caller launches and awaits dispatch, adjudicates untrusted reports, checkpoints
only settled writes, and performs finally-style cleanup. Generic frontmatter, hashing, invocation
state, and view projection live in `dispatch/scripts/review-preparation.mjs`.

### Rebuttal Packets (`scripts/build-rebuttal-packets.mjs`)

Combines strict consensus JSON with explicit orchestrator counter-evidence, groups live findings by
effective source key, and writes owner-only OS-temp packet files. Legacy findings use conservative
round-wide affinity. Packet paths and cleanup directories are returned in a manifest.

---

## 3. Test Harness Environment Hooks

### Liveness Override (`IMPLEMENT_DISPATCH_LIVENESS_JSON`)

Replaces the flow resolver's real provider probing with a literal JSON map (e.g. `{ "claude": true, "agy": false, "copilot": true, "opencode": false }`), allowing integration and unit tests to simulate arbitrary provider availability without spawning external CLI processes.

- **Safety Guard**: Armed only when `IMPLEMENT_DISPATCH_TEST_MODE=1` is set alongside it. Setting the JSON map alone throws an error explicitly naming both variables to prevent accidental test-state inheritance in production runs.
- **Diagnostics**: A run using this override sets `flow.diagnostics.livenessSource: "env-override"`; real runs report `"probe"`.

### Test Suite Structure

- `tests/skills/implement-dispatch/resolve-flow.test.mjs`: Unit tests for candidate ordering,
  stable candidate IDs, host/model demotion, level-knob fallback, pin normalization, candidate
  array expansion, and platform exclusions.
- `tests/skills/implement-dispatch/resolve-flow-cli.test.mjs`: CLI flag parsing, argument validation, `--validate-only`, integrity failure handling, and liveness probe overrides.
- `tests/skills/implement-dispatch/build-rebuttal-packets.test.mjs`: Source grouping, legacy
  affinity, context validation, and private temp-file output.
- `tests/skills/implement-dispatch/config.test.mjs`: Schema validation and level-policy snapshot of `config.sample.jsonc`.

---

## 4. Integrity Gate Behavior

The flow resolver verifies its own files against `skill-hashes.json` before loading configuration:
- A missing `skill-hashes.json` prints a warning and proceeds.
- A modified `SKILL.md` or script aborts execution with a list of modified files.
- Regenerate hashes with `npm run hashes` after editing skill files or scripts.

---

## 5. Maintainer Troubleshooting

- **Provider Reference Split**: Phase 3 keeps `references/providers.md` intact. Phase 0 records
  dispatch-boundary input/output counts, not conditional reference-load cost, so the proposal's
  evidence gate for splitting it by provider has not been met.
- **Sibling Import Failures**: `resolve-flow.mjs` imports `../../dispatch/scripts/common.mjs` and `dispatch.mjs` via relative paths. All skills must reside in the same `<skills-dir>`.
- **Platform Exclusions**: When a delegate encounters `[auth]` or `[quota]`, `implement-dispatch` adds its platform to `--exclude <platform>` on subsequent `resolve-flow.mjs` calls. Exclusion is platform-wide (excludes all models on that provider).
- **Target Affinity on Re-Review**: Re-review dispatches target only delegates that authored findings being re-evaluated, avoiding unnecessary token expenditure across uninvolved providers.
