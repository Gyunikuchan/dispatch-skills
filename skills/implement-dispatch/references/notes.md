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

1. **Setup**: Success criteria formulation and artifact path derivation (`resolve-artifact-paths.mjs`).
2. **Author Plan**: Initial plan creation from `dispatch-plan-review` template.
3. **Initial Scope & Flow**: Scope gating (`trivial` → `low`, `focused` → `medium`, `cross-cutting` → `high`) from the initial draft, then flow resolution (`resolve-flow.mjs`).
4. **Plan Review Loop**: Multi-agent review waves via `dispatch-plan-review` (orchestrated mode) until consensus or wave cap (`maxRounds`).
5. **Final Scope & Flow**: Reassess scope/level against the reviewed plan before the approval gate, then refresh `flow` if the level changed.
6. **Implement**: Single user approval gate, native write subagent dispatch (test-first), boundary verification.
7. **Code Review**: Baseline walkthrough verification, multi-agent code review wave via `dispatch-code-review` (orchestrated mode).
8. **Apply Fixes & Settle Disputes**: Orchestrator applies accepted fixes, updates walkthrough, verifies tests pass green, records adjudications.
9. **Re-Review Loop**: Re-dispatch narrowed by target affinity to live citing delegates until `check-consensus.mjs` exits 0 or wave cap reached.
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

### Consensus Gate (`scripts/check-consensus.mjs`)

Validates whether an artifact's `## Review Findings & Resolutions` section has converged on clean consensus.

- **CLI Usage**:
  ```bash
  node check-consensus.mjs <artifact path>
  ```
- **Exit Codes**:
  - `0`: Settled (`Consensus: settled`) — no unsettled lines found, or `## Review Findings & Resolutions` section absent.
  - `1`: Unsettled (`Consensus: <n> unsettled line(s)`) — lists active `[Disputed]` or `[Rejected — pending confirmation]` lines.
  - `2`: Usage error, missing arguments, or unreadable artifact file.
- **Parsing Invariants**:
  - CommonMark-compliant fenced code block skipping (prevents example templates from triggering false positives).
  - Unclosed fence detection triggers fail-closed scan across the entire file.
  - Regex accepts em-dash, en-dash, and hyphens in `[Rejected — pending confirmation]`.

### Run Records (`scripts/run-record.mjs`)

Initializes marked owner-only directories beneath the absolute Git common directory, aggregates
closed-schema `dispatch --metrics-file` slot records, rotates unpinned finalized runs, removes
stale incomplete runs, and atomically replaces or clears `<phase>:<corpus>` baseline labels.
Standalone review commands are untelemetered; an implement-dispatch slot is one launched dispatch,
including reserves and excluding native in-process fallbacks.

### Bounded Review Views (`scripts/build-review-view.mjs`)

Uses `dispatch/scripts/resolution-log.mjs` to preserve the semantic artifact body, immediately
preceding round, every older live finding, and fixed summaries of older settled rounds in a
private OS-temp projection. The canonical artifact remains the only adjudication/edit target.

---

## 3. Test Harness Environment Hooks

### Liveness Override (`IMPLEMENT_DISPATCH_LIVENESS_JSON`)

Replaces the flow resolver's real provider probing with a literal JSON map (e.g. `{ "claude": true, "agy": false, "copilot": true, "opencode": false }`), allowing integration and unit tests to simulate arbitrary provider availability without spawning external CLI processes.

- **Safety Guard**: Armed only when `IMPLEMENT_DISPATCH_TEST_MODE=1` is set alongside it. Setting the JSON map alone throws an error explicitly naming both variables to prevent accidental test-state inheritance in production runs.
- **Diagnostics**: A run using this override sets `flow.diagnostics.livenessSource: "env-override"`; real runs report `"probe"`.

### Test Suite Structure

- `tests/skills/implement-dispatch/resolve-flow.test.mjs`: Unit tests for candidate ordering, host/model demotion, level-knob fallback, pin normalization, candidate array expansion, and platform exclusions.
- `tests/skills/implement-dispatch/resolve-flow-cli.test.mjs`: CLI flag parsing, argument validation, `--validate-only`, integrity failure handling, and liveness probe overrides.
- `tests/skills/implement-dispatch/check-consensus.test.mjs`: Consensus parser tests, fenced markdown handling, dash variations, and exit codes.
- `tests/skills/implement-dispatch/config-default.test.mjs`: Schema validation of `config.default.jsonc`.

---

## 4. Integrity Gate Behavior

The flow resolver verifies its own files against `skill-hashes.json` before loading configuration:
- A missing `skill-hashes.json` prints a warning and proceeds.
- A modified `SKILL.md` or script aborts execution with a list of modified files.
- Regenerate hashes with `npm run hashes` after editing skill files or scripts.

---

## 5. Maintainer Troubleshooting

- **Sibling Import Failures**: `resolve-flow.mjs` imports `../../dispatch/scripts/common.mjs` and `dispatch.mjs` via relative paths. All skills must reside in the same `<skills-dir>`.
- **Platform Exclusions**: When a delegate encounters `[auth]` or `[quota]`, `implement-dispatch` adds its platform to `--exclude <platform>` on subsequent `resolve-flow.mjs` calls. Exclusion is platform-wide (excludes all models on that provider).
- **Target Affinity on Re-Review**: Re-review dispatches target only delegates that authored findings being re-evaluated, avoiding unnecessary token expenditure across uninvolved providers.
