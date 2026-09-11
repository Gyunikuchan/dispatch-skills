---
name: implement-dispatch
description: Implement features or fixes through a plan → review → implement → review loop across external agent CLIs, adjudicating claims to consensus. Use on /implement-dispatch or multi-agent implementation with cross-agent review.
---

# implement-dispatch

Orchestrate feature and fix implementations with multi-agent review loops across external agent CLIs. This skill owns **control flow** (scope gating, fan-out waves, consensus loops, implementation, and cleanup). Upstream skills provide review criteria:

| Skill | Role | Status |
|-------|------|--------|
| `dispatch` | Runner execution, CLI flags, sandboxing, fallback | **Required** |
| `dispatch-plan-review` | Plan template, review axes, plan adjudication | **Optional** *(skips Step 3 if absent)* |
| `dispatch-code-review` | Walkthrough template, review axes, code adjudication | **Optional** *(skips Steps 5–7 if absent)* |

If an optional skill is absent, name its absence in the handoff and proceed with the reduced flow.

## Invocation

```
/implement-dispatch <level> (<pins>): <ask>
```

Extends `dispatch`'s `references/alignment.md` § Invocation grammar. Both `<level>` and `(<pins>)` are optional:
- `<level>`: `low`, `medium` *(default)*, `high`, `xhigh`, `max`. Controls wave caps, reviewer breadth, consensus gates, and model budgets.
- `(<pins>)`: Comma-separated provider keys (`claude`, `agy`, `copilot`, `opencode`), `--provider` aliases, or `all`. Overrides breadth to target specified platforms.

---

## Process

### 1. Scope & Setup

1. **Understand ask**: Restate requirements as checkable success criteria. If preceded by user questioning/interviews (e.g. `grilling`), fold settled decisions directly into criteria and assumptions without intermediate approval gates.
2. **Scope gate**: Classify change to set effective level:
   - `trivial` (single-file mechanical edit, rename, comment/typo, simple constant) → downshift to `low`.
   - `focused` or `cross-cutting` → keep requested level.
   *(Explicit levels remain fixed; automatic classification only downshifts unpinned defaults to `low`).*
3. **Resolve flow**:

   ```bash
   node <skills-dir>/implement-dispatch/scripts/resolve-flow.mjs --platform <key> [--level <level>] [--pins <pins>]
   ```

   Halt immediately if non-zero; store output as `flow`.
4. **Resolve artifacts**: Use host repo explicit path (`AGENTS.md` / `CLAUDE.md`) if named. Otherwise resolve paths via `dispatch`'s `resolve-artifact-paths.mjs` per `alignment.md` § Plan/Walkthrough Artifact Resolution:

   ```bash
   node <skills-dir>/dispatch/scripts/resolve-artifact-paths.mjs
   ```

**Done when:** Success criteria are checkable, scope is classified, `flow` is loaded, and artifact paths are resolved.

---

### 2. Author Plan

1. Write the plan at the path resolved in Step 1 following `dispatch-plan-review`'s plan template. External delegates read this file as their sole context.
2. **Single approval gate**: Transition directly to Step 3's review loop; solicit user approval once on the refined plan at the end of Step 3 (especially post-`grilling`).

**Done when:** Plan file exists on disk with all template sections populated.

---

### 3. Plan Review Loop

*Skip if `flow['plan-review'].maxRounds === 0`.*

1. **Invoke review**: Call `dispatch-plan-review` in **orchestrated mode** (hand over plan path, targets from `flow['plan-review'].targets`, `Review Scope: Full review`, and `Tool Turn Budget` from `flow['plan-review'].toolTurns`).
2. **Re-review wave**: If accepted findings modify plan sections and round count < `maxRounds`, re-invoke with `Review Scope: Re-review round <n>` naming changed sections.
3. **Consensus & approval**:
   - `consensus: true`: Disputed claims must be accepted, rebutted with counter-evidence in re-dispatch, or escalated to the user upon reaching the round cap.
   - `consensus: false`: Orchestrator may reject unverified claims directly.
   - **User approval gate**: Solicit user approval on the refined post-review plan before writing code.

**Done when:** Plan reflects all accepted findings, disputes are resolved, and refined plan is approved by the user.

---

### 4. Implement

1. **Dispatch implementation**: Dispatch test-first to platform's native write subagent (Reference below) configured with `flow.implementation` hints and the resolved walkthrough path from Step 1. Instruct the subagent to implement Proposed Changes, run the host verify command (from `AGENTS.md` / `CLAUDE.md`) until green, and author the baseline walkthrough directly at the resolved path following `dispatch-code-review`'s template (`## Changes Made` with `[NEW]`/`[MODIFY]`/`[DELETE]` tags, `## Verification & Validation`, `## Key Deviations`, and `## Review Findings & Resolutions: *No reviews conducted yet.*`). For `trivial` scope, direct execution, or subagent failure, orchestrator implements and authors directly.
2. **Verify completion**: Confirm code changes pass host verification tests green and baseline walkthrough exists on disk.

**Done when:** Code changes are complete, host verification tests pass green, and baseline walkthrough exists on disk.

---

### 5. Code Review

*Skip if `flow['code-review'].maxRounds === 0`.*

1. Verify the walkthrough exists at the path resolved in Step 1 (authored in Step 4, or author now following `dispatch-code-review`'s template if skipped).
2. Invoke `dispatch-code-review` in **orchestrated mode** (hand over walkthrough path, plan path, targets from `flow['code-review'].targets`, `Review Scope: Full review`, and `Tool Turn Budget`). The review skill returns claims without applying code fixes.

**Done when:** Walkthrough exists on disk, dispatches completed, and round 1 claims are adjudicated.

---

### 6. Apply Fixes & Settle Disputes

1. Apply accepted findings directly as the orchestrator.
2. Update the walkthrough (`## Changes Made`, `## Verification & Validation`, and append round logs under `## Review Findings & Resolutions`).
3. Re-run the host verify command until green.
4. Enforce consensus against returned `[Disputed]` items: rebut with counter-evidence, accept, or escalate to the user with interactive questions citing lines and counter-readings.

**Done when:** Accepted fixes are applied, verify command is green, and round adjudications are logged in the walkthrough.

---

### 7. Re-Review Loop

While previous round modified code and code review round count < `flow['code-review'].maxRounds`:
1. Re-invoke `dispatch-code-review` in orchestrated mode with `Review Scope: Re-review round <n>` naming modified lines, routing re-reviews to citing delegates (target affinity).
2. Apply accepted fixes and settle disputes per Step 6.

Proceed to Handoff when consensus is reached, no modifications remain, or user rules on round-cap escalation (user input resets that phase's round counter to 0, allowing further rounds).

**Done when:** Consensus is reached, no modifications remain, or user rules on deadlock.

---

### 8. Handoff & Cleanup

1. **Record diagnostics**: Append `## Run Diagnostics` to the walkthrough (or plan if code review was skipped):
   - Scope classification, `flow.diagnostics.effectiveLevel`, and any scope downshift.
   - Artifact slug and `slugSource` (`explicit`, `branch`, `conversation`).
   - Rounds spent per phase vs `maxRounds`.
   - Active, failed, dropped, or unavailable delegates (`flow.diagnostics`).
   - Summary of accepted/rejected findings and verification command status.
2. **Relocate scratch**: Per `alignment.md` § Artifact Lifecycle, move scratch plan/walkthrough files to OS temp (`os.tmpdir()`) on completion. If unresolved/halted, retain in place with reasons stated.
3. **Report to user**: Present run diagnostics and a link to the artifact (omit full inline artifact content). Git operations (commit, push, PR) remain for the user.

**Done when:** Diagnostics are appended, scratch artifacts relocated (or retained with stated reason), and handoff report delivered.

---

## Reference

### Platform Write Subagents
| Platform | Native Write Subagent |
|----------|-----------------------|
| `claude` | `general-purpose` |
| `agy` | `self` |
| `copilot` | `self` |
| `opencode` | Direct execution |

### Dispatch Invocation Rules
- **Flags**: Pass `--provider <target.platform> --no-config`. Pass `-m <target.model>`, `-e <target.effort>`, and `--allow-same-agent` when present in target config. Attach context with `-f "<path>"`.
- **Parallelism**: Launch all targets in a round concurrently in the background; yield turn and await notifications.
- **Isolation**: External delegates are structurally read-only (`--mode plan` / read-only tools). Orchestrator / native subagents alone write code.
- **Fallback**: Provider failures fall back to `dispatch`'s in-process read-only subagent.
