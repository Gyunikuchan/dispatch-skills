---
name: implement-dispatch
description: Implement features or fixes through a plan → review → implement → review loop across external agent CLIs, adjudicating claims to consensus. Use on /implement-dispatch or multi-agent implementation with cross-agent review.
---

# implement-dispatch

Orchestrate feature and fix implementations with multi-agent review loops across external agent CLIs. This skill owns **control flow** (scope gating, fan-out waves, consensus loops, implementation, and cleanup). Upstream skills provide review criteria:

| Skill | Role | Status |
|---|---|---|
| `dispatch` | Runner execution, CLI flags, sandboxing, fallback | **Required** |
| `dispatch-plan-review` | Plan template, review axes, plan adjudication | **Optional** *(skips Step 3 if absent)* |
| `dispatch-code-review` | Walkthrough template, review axes, code adjudication | **Optional** *(skips Steps 5–7 if absent)* |

If an optional skill is absent, name its absence in the handoff and proceed with the reduced flow.

**Install side by side.** `resolve-flow.mjs` imports `dispatch` scripts by sibling path; all skills above must live in one `<skills-dir>`. Install all to the same scope (`npx skills add Gyunikuchan/dispatch-skills --all`, with `-g` on all or none).

## Invocation

```
/implement-dispatch <level> (<pins>): <ask>
```

Extends `dispatch`'s `references/alignment.md` § Invocation grammar. `<level>` and `(<pins>)` are optional:
- `<level>`: `low`, `medium`, `high`, `xhigh`, `max`. Controls wave caps, reviewer breadth, consensus gates, and model budgets.
- `(<pins>)`: platform keys, aliases, or `all` per that shared grammar, overriding breadth to target the specified platforms. Or a single reviewer count `n ≥ 1` (alone), replacing the level's `targetCount` for both review phases. Selection, reserves, and clamping stay as in an unpinned run.

Pass pins through to `resolve-flow.mjs --pins` and use the platforms it returns. It expands `all` from this skill's own config sections, so do not expand pins yourself or substitute `dispatch --list-platforms` here.

---

## Process

### 1. Scope & Setup

1. **Understand ask**: Restate requirements as checkable success criteria. When preceded by user questioning/interviews (e.g. `grilling`), fold settled decisions directly into criteria and assumptions without intermediate approval gates.
2. **Scope gate**: Classify the change by scope, complexity, and risk:
   - `trivial` / low risk (single-file mechanical edit, rename, comment/typo, simple constant, isolated tweak) → evaluate at `low`.
   - `focused` / moderate risk (standard feature, multi-file changes in bounded subsystem, routine bug fix/refactoring) → evaluate at `medium`.
   - `cross-cutting` / high risk (architectural changes, complex refactoring, multi-subsystem integrations, public API/contract changes, state machines) → evaluate at `high`.
   When user specified no `<level>`, run at evaluated level (`low`, `medium`, or `high`); otherwise use requested level. `xhigh` and `max` are manual-only and never selected automatically. Provider or count pins `(<pins>)` alone do not alter level selection.
3. **Resolve flow** (`<skills-dir>` resolves per `dispatch`'s `references/alignment.md` § Plan/Walkthrough Artifact Resolution):

   ```bash
   node <skills-dir>/implement-dispatch/scripts/resolve-flow.mjs --platform <key> [--orchestrator-model <model>] [--level <level>] [--pins <pins>] [--exclude <keys>]
   ```

   `--platform` is the orchestrator's provider key (`claude`, `agy`, `copilot`, `opencode`); `--orchestrator-model` optionally overrides auto-detected model. Pass `--exclude <keys>` with platforms that failed on `[auth]` / `[quota]` in earlier review waves (**Platform exclusion**); omit on first run. Resolver checks `skill-hashes.json` before loading config; on integrity failure (non-zero exit), report modified files and halt immediately. Save output as `flow`.

   The resolver also rejects any platform configured here but absent from `dispatch`'s effective config, since dispatching to it would exit `PLATFORM_NOT_CONFIGURED` mid-wave. On `Invalid config:` naming such a platform, relay the resolver's lines verbatim and halt — the fix is a config edit the user owns, so never work around it by dropping the platform or editing either config yourself. If the dispatch config cannot be loaded or validated, relay the loader or validation diagnostic and halt before resolving targets.
4. **Resolve artifacts**: Use host repo explicit path (`AGENTS.md` / `CLAUDE.md`) if named. Otherwise resolve paths via `dispatch`'s `resolve-artifact-paths.mjs` per `alignment.md` § Plan/Walkthrough Artifact Resolution:

   ```bash
   node <skills-dir>/dispatch/scripts/resolve-artifact-paths.mjs
   ```

**Done when:** Success criteria are checkable, scope is classified, `flow` is loaded, and artifact paths are resolved.

---

### 2. Author Plan

1. Write plan at the path resolved in Step 1 following `dispatch-plan-review`'s [plan template](../dispatch-plan-review/references/plan-template.md). External delegates read this file as their sole context. When `dispatch-plan-review` is absent, author plan under headings: `## Key Decisions & Context`, `## Proposed Changes` (grouped by file, tagged `[NEW]` / `[MODIFY]` / `[DELETE]`), `## Rollback & Blast Radius`, `## Verification Plan`, `## Out of Scope`.
2. **Single approval gate**: Transition directly to Step 3. Approval is solicited once at Step 4 before code is written — never here and never twice.

**Done when:** Plan file exists on disk with all template sections populated.

---

### 3. Plan Review Loop

*Skip if `flow['plan-review'].maxRounds === 0`.* When `maxRounds > 0` but `flow['plan-review'].targets` is empty, run one in-process review round via `dispatch`'s read-only subagent fallback and record substitution in plan round log and Step 8 diagnostics.

1. **Invoke review**: Call `dispatch-plan-review` in **orchestrated mode**, handing over plan path, `targets` and `reserves` from `flow['plan-review']`, `consensus: true|false` from `flow['plan-review'].consensus`, `Review Scope: Full review`, and `Tool Turn Budget` per **Budget formula**. Apply **Platform exclusion** to any `[auth]` / `[quota]` substitution.
2. **Re-review wave**: While loop exit condition holds (**Mechanical loop exit**), re-invoke `dispatch-plan-review` in orchestrated mode, handing over plan path, `targets` narrowed by target affinity to live citing delegates, `reserves` from current `flow['plan-review']`, `consensus: true|false`, `Review Scope: Re-review round <n>` naming changed sections and pending rebuttals, and `Tool Turn Budget` per **Budget formula**.
3. **Consensus**:
   - `consensus: true`: Disputed MUST-FIX or SHOULD-FIX claims must be accepted, rebutted with counter-evidence in re-dispatch, or escalated to user upon reaching round cap (**Ruling resets rounds**); rejections follow **Pending confirmation loop**. Delegate-reported `CONSIDER` findings follow `dispatch`'s `references/alignment.md` § Finality.
   - `consensus: false`: Orchestrator may reject unverified claims directly; `[Disputed]` lines still go to user.
   - Rewrite each ruled `[Disputed]` line in plan's `## Review Findings & Resolutions` to `[Resolved Dispute]`, and each settled pending line per **Pending confirmation loop**.

**Done when:** `check-consensus.mjs` exits 0 on the plan.

---

### 4. Implement

**User approval gate**: Before writing code or dispatching implementation, solicit user approval on the plan — refined post-review plan when Step 3 ran, authored plan when Step 3 was skipped (`maxRounds: 0`, or `dispatch-plan-review` absent). This is the run's sole approval gate. When plan holds `## Review Findings & Resolutions`, run `check-consensus.mjs` first; never solicit approval while it exits 1, and halt if it exits 2.

1. **Execution choice**:
   - **Trivial scope or fallback** (single-file mechanical edit, subagent failure, or direct execution): Orchestrator implements Proposed Changes directly and authors the baseline walkthrough.
   - **Focused / Cross-cutting scope**: Dispatch test-first to platform native write subagent (**Platform Write Subagents** table, selected by `flow.implementation.platform`), passing hints (`model`, `effort`), plan path, and resolved walkthrough path. Instruct subagent to implement Proposed Changes, run host verify command (from `AGENTS.md` / `CLAUDE.md`) until green, and author baseline walkthrough following `dispatch-code-review`'s [walkthrough template](../dispatch-code-review/references/walkthrough-template.md). When `dispatch-code-review` is absent, skip walkthrough and direct Step 8 diagnostics to plan instead.
2. **Git guard** (apply to orchestrator and hand to subagent verbatim): Confine git commands strictly to read-only inspection — `git status`, `git diff`, `git log`, `git show`. Commands that rewrite or discard working tree or index (`git stash`, `git reset`, `git checkout -- <path>`, `git clean`) are prohibited because untracked scratch plan/walkthrough artifacts would be destroyed.
3. **Verify completion**: Confirm host verification command passes green and baseline walkthrough exists on disk (unless skipped).

**Done when:** User has approved the plan, code changes are complete, host verification is green, and baseline walkthrough exists on disk (or was skipped).

---

### 5. Code Review

*Skip Steps 5–7 if `flow['code-review'].maxRounds === 0` or `dispatch-code-review` is absent.* When `maxRounds > 0` but `flow['code-review'].targets` is empty, run one in-process review round via `dispatch`'s read-only subagent fallback and record substitution in walkthrough round log and Step 8 diagnostics.

1. Verify walkthrough exists at resolved path (authored in Step 4, or author now following `dispatch-code-review`'s [walkthrough template](../dispatch-code-review/references/walkthrough-template.md) if skipped).
2. Invoke `dispatch-code-review` in **orchestrated mode**, handing over walkthrough and plan paths, `targets` and `reserves` from `flow['code-review']` (re-resolved with `--exclude` if plan review excluded platforms), `consensus: true|false` from `flow['code-review'].consensus`, `Review Scope: Full review`, and `Tool Turn Budget` per **Budget formula**. Apply **Platform exclusion** to any `[auth]` / `[quota]` substitution.

**Done when:** Walkthrough exists on disk, every target dispatch has returned, and round 1 claims are in hand for Step 6.

---

### 6. Apply Fixes & Settle Disputes

1. Apply accepted findings directly as orchestrator.
2. Update walkthrough `## Changes Made` and `## Verification & Validation`; rewrite each ruled `[Disputed]` line to `[Resolved Dispute]`, and each settled pending line per **Pending confirmation loop**.
3. Re-run host verify command until green.
4. Enforce consensus against returned `[Disputed]` items: accept, rebut with counter-evidence, or escalate to user with interactive questions citing lines and counter-readings. Under `consensus: true`, rejections of delegate-reported MUST-FIX or SHOULD-FIX stay `[Rejected — pending confirmation]` until citing delegate confirms (**Pending confirmation loop**); Delegate-reported `CONSIDER` findings follow `dispatch`'s `references/alignment.md` § Finality.

**Done when:** Accepted fixes are applied, verify command is green, and round adjudications are logged in walkthrough.

---

### 7. Re-Review Loop

While loop exit condition holds (**Mechanical loop exit**):
1. Re-invoke `dispatch-code-review` in orchestrated mode, handing over walkthrough and plan paths, `targets` narrowed by target affinity to live citing delegates, `reserves` from current `flow['code-review']`, `consensus: true|false`, `Review Scope: Re-review round <n>` naming modified lines and pending rebuttals, and `Tool Turn Budget` per **Budget formula**.
2. Apply accepted fixes and settle disputes per Step 6; apply **Platform exclusion** to any `[auth]` / `[quota]` substitution.

At round cap, escalate remaining items to user (**Ruling resets rounds**) and write each ruling into walkthrough.

**Done when:** `check-consensus.mjs` exits 0 on the walkthrough.

---

### 8. Handoff & Cleanup

**Await all reviews**: Never initiate handoff while background review dispatches are running. All launched target and reserve dispatches across all phases must be fully settled.

1. **Record diagnostics**: When walkthrough holds `## Review Findings & Resolutions`, run `check-consensus.mjs` first and return to Step 7 escalation while it exits 1. Then append `## Run Diagnostics` to walkthrough (or plan if code review skipped):
   - Scope classification, evaluated level (`low` / `medium` / `high`), `flow.diagnostics.effectiveLevel`, and any scope shift.
   - Artifact slug and `slugSource` (`explicit`, `branch`, `conversation`).
   - Rounds spent per phase vs `maxRounds`.
   - Active, failed, substituted, dropped, excluded, unavailable, or clamped delegates (`flow.diagnostics` fields, recorded substitutions, run's exclusion set with reasons).
   - Summary of accepted/rejected findings, rebuttals confirmed by citing delegates, and verify command status.
2. **Relocate scratch**: Per `alignment.md` § Artifact Lifecycle, move scratch plan/walkthrough files to OS temp on completion:

   ```bash
   node <skills-dir>/dispatch/scripts/relocate-scratch.mjs "<plan path>" "<walkthrough path>"
   ```

   If run is unresolved or halted, retain artifacts in place and state reason.
3. **Report to user**: Present run diagnostics and artifact link (avoid verbatim delegate report dumps in chat). Git operations (commit, push, PR) remain for user.

**Done when:** All review tasks are complete, diagnostics appended, scratch artifacts relocated (or retained with stated reason), and handoff report delivered.

---

## Reference

### Platform Write Subagents

| Platform | Native Write Subagent |
|---|---|
| `claude` | `general-purpose` |
| `agy` | `self` |
| `copilot` | `self` |
| `opencode` | `general` |

### Consensus & Review Rules

- **Mechanical loop exit**: A review loop continues while (previous round modified artifact/code **or** an unsettled line `[Disputed]` / `[Rejected — pending confirmation]` exists) and rounds < `maxRounds`. Exit is mechanical via:

  ```bash
  node <skills-dir>/implement-dispatch/scripts/check-consensus.mjs <artifact path>
  ```

  Exit 0 indicates settled (or section absent); exit 1 lists unsettled lines; exit 2 indicates file read or syntax errors. Rulings must be written into the artifact before the gate passes.
- **Pending confirmation loop**: Under `consensus: true`, orchestrator Rejection or Downgrade of delegate-reported MUST-FIX or SHOULD-FIX claims is logged `[Rejected — pending confirmation]` and handed back to citing delegates in next re-review round. Rewrite to `[Rejected / Downgraded]` only when citing delegate explicitly affirms counter-evidence (silence keeps it pending), or `[Resolved Dispute]` after user ruling. If all citing delegates become unavailable, escalate immediately to user. Delegate `CONSIDER` findings follow `dispatch`'s `references/alignment.md` § Finality and are final at orchestrator ruling without entering pending confirmation. Under `consensus: false`, rejections are final immediately, but `[Disputed]` lines still require user ruling.
- **Ruling resets rounds**: When round cap is reached or an unsettled item is escalated, user ruling settles dispute (`[Resolved Dispute]`) and grants exactly one additional re-review round for that phase (with refreshed tool turn budget) to verify amendments. Rounds already spent are not forgiven; reaching cap a second time ends loop and escalates.
- **Platform exclusion**: When a target or reserve fails `[auth]` or `[quota]`, add platform to exclusion set and re-run Step 1.3 `resolve-flow.mjs` with `--exclude <set>` before next wave or phase. Exclusion is platform-granular. Target affinity still narrows re-review targets to live citing delegates.
- **Budget formula**: Handed-over `Tool Turn Budget` per reviewer is `8 + 2 × <units under review>`, where unit is changed file (code review) or `## Proposed Changes` entry (plan review). On re-review rounds, count only units changed since previous round. Reviewers get what the work requires with no artificial ceiling.
