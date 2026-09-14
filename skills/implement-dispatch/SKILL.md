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

**Install them side by side.** `resolve-flow.mjs` imports `dispatch`'s scripts by sibling path, so every skill above must live in one `<skills-dir>`. A split install (say `dispatch` global, `implement-dispatch` project-local) fails at import. Install all of them to the same scope (`npx skills add Gyunikuchan/dispatch-skills --all`, with `-g` on every skill or on none).

**Rejections need the citing reviewer.** With the phase's `consensus: true`, an orchestrator Reject or Downgrade of a delegate-reported MUST-FIX or SHOULD-FIX claim is not final:
- It is logged `[Rejected — pending confirmation]` and handed back to every citing delegate in the next re-review round.
- Rewrite it to `[Rejected / Downgraded]` only when a citing delegate's report explicitly affirms the counter-evidence (silence keeps it pending), or to `[Resolved Dispute]` after a user ruling.
- If every citing delegate is excluded or unavailable, escalate it to the user at once rather than waiting for the cap.
- Delegate-reported `CONSIDER` findings follow `dispatch`'s `references/alignment.md` § Finality and are final at the orchestrator's ruling without entering the pending confirmation loop.
- With `consensus: false`, rejections are final, but every `[Disputed]` line is still ruled by the user and rewritten before the gate.

**Loop exit is mechanical.** A review loop continues while (the last round modified the artifact **or** a `[Disputed]` / `[Rejected — pending confirmation]` line exists) and rounds < `maxRounds`. Never exit early because remaining edits look minor. At the cap, escalate every remaining item to the user and rewrite each ruling to `[Resolved Dispute]` in the artifact. Gate with:

```bash
node <skills-dir>/implement-dispatch/scripts/check-consensus.mjs <artifact path>
```

Exit 0 means settled (or no `## Review Findings & Resolutions` section); exit 1 lists the unsettled lines; exit 2 reports unreadable files or usage syntax errors. There is no "the user ruled" exception — a ruling is written into the artifact first.

**Ruling resets rounds.** When the round cap is reached or an unsettled item is escalated to the user, the user's interactive ruling settles the dispute (`[Resolved Dispute]`). A user ruling grants exactly one additional re-review round for that phase (with a refreshed tool turn budget) to verify that amendments made to satisfy the ruling meet requirements; rounds already spent are not forgiven, and reaching the cap a second time ends the loop and escalates to the user.

**Exclude failed platforms.** When a review wave records a target (or substitute) that failed `[auth]` or `[quota]`, add its platform to the run's exclusion set and re-run Step 1.3's `resolve-flow.mjs` with `--exclude <set>` before the next wave or phase, using the new `targets` / `reserves`. Exclusion is platform-granular: a `[quota]` on one model excludes that platform's other models too. Target affinity still narrows re-review targets to citing delegates that remain live.

**Budget sizes to the work.** The `Tool Turn Budget` handed to each reviewer is computed per dispatch, not configured: `8 + 2 × <units under review>`, where a unit is a changed file (code review) or a `## Proposed Changes` entry (plan review). On a re-review round, count only the units changed since the previous round. Reviewers get what the job takes; there is no ceiling.

## Invocation

```
/implement-dispatch <level> (<pins>): <ask>
```

Extends `dispatch`'s `references/alignment.md` § Invocation grammar. Both `<level>` and `(<pins>)` are optional:
- `<level>`: `low`, `medium` *(default)*, `high`, `xhigh`, `max`. Controls wave caps, reviewer breadth, consensus gates, and model budgets.
- `(<pins>)`: Comma-separated provider keys (`claude`, `agy`, `copilot`, `opencode`), `--provider` aliases, or `all`. Overrides breadth to target specified platforms. Or a single reviewer count `n ≥ 1` (alone), which replaces the level's `targetCount` for both review phases. Selection, reserves and clamping stay as in an unpinned run.

---

## Process

### 1. Scope & Setup

1. **Understand ask**: Restate requirements as checkable success criteria. If preceded by user questioning/interviews (e.g. `grilling`), fold settled decisions directly into criteria and assumptions without intermediate approval gates.
2. **Scope gate**: Classify the change based on scope, complexity, and risk:
   - `trivial` / low risk (single-file mechanical edit, rename, comment/typo, simple constant, isolated tweak) → evaluate at `low`.
   - `focused` / moderate risk (standard feature, multi-file changes in a bounded subsystem, routine bug fix/refactoring) → evaluate at `medium`.
   - `cross-cutting` / high risk (architectural changes, complex refactoring, multi-subsystem integrations, public API/contract changes, state machines) → evaluate at `high`.
   When the user gave no `<level>`, run at the evaluated level (`low`, `medium`, or `high`); otherwise use the requested level. `xhigh` and `max` are never selected automatically and remain reserved for manual pinning. Provider or count pins `(<pins>)` alone do not affect level selection.
3. **Resolve flow** (`<skills-dir>` resolves per `dispatch`'s `references/alignment.md` § Plan/Walkthrough Artifact Resolution):

   ```bash
   node <skills-dir>/implement-dispatch/scripts/resolve-flow.mjs --platform <key> [--orchestrator-model <model>] [--level <level>] [--pins <pins>] [--exclude <keys>]
   ```

   `--platform` is the orchestrator's own provider key (`claude`, `agy`, `copilot`, `opencode`); `--orchestrator-model` optionally overrides the auto-detected orchestrator model. `--exclude` carries the run's exclusion set (**Exclude failed platforms**); omit it on the first run. Candidates come back diversity-sorted: every platform's first model before any platform's second, the orchestrator's platform last (with same platform + model matches placed dead last). The resolver also checks the skill's own `skill-hashes.json` before loading config; on an integrity failure (non-zero exit), report the modified files to the user. Halt immediately if non-zero; store output as `flow`.
4. **Resolve artifacts**: Use host repo explicit path (`AGENTS.md` / `CLAUDE.md`) if named. Otherwise resolve paths via `dispatch`'s `resolve-artifact-paths.mjs` per `alignment.md` § Plan/Walkthrough Artifact Resolution:

   ```bash
   node <skills-dir>/dispatch/scripts/resolve-artifact-paths.mjs
   ```

**Done when:** Success criteria are checkable, scope is classified, `flow` is loaded, and artifact paths are resolved.

---

### 2. Author Plan

1. Write the plan at the path resolved in Step 1 following `dispatch-plan-review`'s [plan template](../dispatch-plan-review/references/plan-template.md). External delegates read this file as their sole context. When `dispatch-plan-review` is absent, that template is not installed: author the plan under these headings instead — `## Key Decisions & Context`, `## Proposed Changes` (grouped by file, each tagged `[NEW]` / `[MODIFY]` / `[DELETE]`), `## Rollback & Blast Radius`, `## Verification Plan`, `## Out of Scope`.
2. **Single approval gate**: Transition directly to Step 3's review loop. Approval is solicited exactly once, at Step 4, before any code is written — never here and never twice (especially post-`grilling`).

**Done when:** Plan file exists on disk with all template sections populated.

---

### 3. Plan Review Loop

*Skip if `flow['plan-review'].maxRounds === 0`.* When `maxRounds > 0` but `flow['plan-review'].targets` is empty (every review platform is unavailable), do not invoke the review skill with no targets — it would complete with zero review. Run one in-process review round instead via `dispatch`'s read-only subagent fallback, and record the substitution in the plan's round log and Step 8 diagnostics.

1. **Invoke review**: Call `dispatch-plan-review` in **orchestrated mode**, handing over the plan path, `targets` and `reserves` from `flow['plan-review']`, `consensus: true|false` from `flow['plan-review'].consensus`, `Review Scope: Full review`, and `Tool Turn Budget` per **Budget sizes to the work**. The review skill fills its own prompt template, builds the invocations, and appends the round log. Apply **Exclude failed platforms** to any recorded `[auth]` / `[quota]` substitution.
2. **Re-review wave**: While the loop condition in **Loop exit is mechanical** holds, re-invoke `dispatch-plan-review` in orchestrated mode, handing over the plan path, `targets` and `reserves` from the current `flow['plan-review']`, `consensus: true|false`, `Review Scope: Re-review round <n>` naming changed sections and each pending rebuttal (for its citing delegates), and `Tool Turn Budget` per **Budget sizes to the work**.
3. **Consensus**:
   - `consensus: true`: Disputed MUST-FIX or SHOULD-FIX claims must be accepted, rebutted with counter-evidence in re-dispatch, or escalated to the user upon reaching the round cap (**Ruling resets rounds**); rejections follow **Rejections need the citing reviewer**. Delegate-reported `CONSIDER` findings follow `dispatch`'s `references/alignment.md` § Finality.
   - `consensus: false`: Orchestrator may reject unverified claims directly; `[Disputed]` lines still go to the user.
   - Rewrite each ruled `[Disputed]` line in the plan's `## Review Findings & Resolutions` to `[Resolved Dispute]`, and each settled pending line per **Rejections need the citing reviewer**.

**Done when:** `check-consensus.mjs` exits 0 on the plan.

---

### 4. Implement

**User approval gate**: before writing code or dispatching implementation, solicit user approval on the plan as it stands — the refined post-review plan when Step 3 ran, the plan as authored when Step 3 was skipped (`maxRounds: 0`, or `dispatch-plan-review` absent). This is the run's only approval gate, and it sits here because Step 4 is the first step that writes anything: every path into implementation passes through it. When the plan has a `## Review Findings & Resolutions` section — however Step 3 ran, external targets or in-process fallback — run `check-consensus.mjs` on it first; never ask for approval while it exits 1, and halt immediately if it exits 2 (unreadable file or usage error).

1. **Snapshot the boundary**: record `git status --porcelain` and `git stash list` before dispatching, and confirm the plan file authored in Step 2 is on disk. These are the before-values Step 4.4 compares against.
2. **Dispatch implementation**: Dispatch test-first to the platform's native write subagent (Reference below, selected by `flow.implementation.platform`), passing optional hints (`model`, `effort`) to subagent invocation parameters when supported by the host environment (e.g. Antigravity subagent `Model`), the plan path, and the resolved walkthrough path from Step 1. Instruct it to implement the plan's Proposed Changes, run the host verify command (from `AGENTS.md` / `CLAUDE.md`) until green, and author the baseline walkthrough at the resolved path following `dispatch-code-review`'s [walkthrough template](../dispatch-code-review/references/walkthrough-template.md) — that template is the single source of truth for the headings. When `dispatch-code-review` is absent, skip the walkthrough entirely and let Step 8's diagnostics go to the plan instead.
3. **Git guard** (hand to the subagent verbatim): confine every git command to read-only inspection — `git status`, `git diff`, `git log`, `git show`. To compare before/after state (e.g. test counts), run the verify command and read its output. Anything that rewrites or discards the working tree or index is out of bounds — `git stash`, `git reset`, `git checkout -- <path>`, `git clean` and their kin — because the plan and walkthrough are untracked and not git-ignored, so such a command silently destroys them.
4. **Verify the boundary held**: re-read `git status --porcelain` and `git stash list`. Every entry present in Step 4.1 must still be present, and the stash list must be unchanged. If either moved, halt and report — the scratch artifacts may have been swept up.
5. **Verify completion**: confirm the host verification command passes green, and that the walkthrough exists on disk (unless skipped in 4.2).

**Fallback**: for `trivial` scope, direct execution, or subagent failure, the orchestrator implements and authors directly — the approval gate above and sub-steps 1, 3, 4 and 5 all still apply to its own work. Writing the code yourself is not a reason to skip the gate; `trivial` scope is precisely where level `low` skips plan review, so this path would otherwise reach code with no approval sought at all.

**Done when:** The user has approved the plan, code changes are complete, the pre-dispatch git entries and stash list are intact, host verification passes green, and the baseline walkthrough exists on disk (or was skipped because `dispatch-code-review` is absent).

---

### 5. Code Review

*Skip Steps 5–7 if `flow['code-review'].maxRounds === 0`* — the same span `dispatch-code-review`'s absence skips. Skipping Step 5 alone would strand Step 6 with no claims to adjudicate and a completion bound it could never satisfy. When `maxRounds > 0` but `flow['code-review'].targets` is empty, run one in-process review round via `dispatch`'s read-only subagent fallback instead of invoking the review skill with no targets, and record the substitution in the walkthrough's round log and Step 8 diagnostics.

1. Verify the walkthrough exists at the path resolved in Step 1 (authored in Step 4, or author now following `dispatch-code-review`'s [walkthrough template](../dispatch-code-review/references/walkthrough-template.md) if skipped). This step is unreachable when `dispatch-code-review` is absent — that skips Steps 5–7 outright.
2. Invoke `dispatch-code-review` in **orchestrated mode**, handing over the walkthrough and plan paths, `targets` and `reserves` from `flow['code-review']` (re-resolved with `--exclude` if plan review excluded platforms), `consensus: true|false` from `flow['code-review'].consensus`, `Review Scope: Full review`, and `Tool Turn Budget` per **Budget sizes to the work**. The review skill fills its own prompt template, builds the invocations, appends the round log, and returns claims without applying code fixes. Apply **Exclude failed platforms** to any recorded `[auth]` / `[quota]` substitution.

**Done when:** Walkthrough exists on disk, every target's dispatch has returned, and round 1 claims are in hand for Step 6.

---

### 6. Apply Fixes & Settle Disputes

1. Apply accepted findings directly as the orchestrator.
2. Update the walkthrough's `## Changes Made` and `## Verification & Validation`; rewrite each ruled `[Disputed]` line to `[Resolved Dispute]`, and each settled pending line per **Rejections need the citing reviewer** (the review skill appends each round's log).
3. Re-run the host verify command until green.
4. Enforce consensus against returned `[Disputed]` items: for delegate-reported `MUST-FIX` or `SHOULD-FIX` claims, rebut with counter-evidence, accept, or escalate to the user with interactive questions citing lines and counter-readings. With `consensus: true`, rejections of delegate-reported `MUST-FIX` or `SHOULD-FIX` stay `[Rejected — pending confirmation]` until the citing delegate confirms (**Rejections need the citing reviewer**); delegate-reported `CONSIDER` findings follow `dispatch`'s `references/alignment.md` § Finality.

**Done when:** Accepted fixes are applied, verify command is green, and round adjudications are logged in the walkthrough.

---

### 7. Re-Review Loop

While the loop condition in **Loop exit is mechanical** holds (previous round modified code, or a `[Disputed]` / pending-confirmation line remains, and round count < `flow['code-review'].maxRounds`):
1. Re-invoke `dispatch-code-review` in orchestrated mode, handing over the walkthrough and plan paths, `targets` narrowed to the live delegates that cited the re-reviewed findings or pending rebuttals (target affinity), `reserves` from the current `flow['code-review']`, `consensus: true|false`, `Review Scope: Re-review round <n>` naming modified lines and each pending rebuttal, and `Tool Turn Budget` per **Budget sizes to the work**.
2. Apply accepted fixes and settle disputes per Step 6; apply **Exclude failed platforms** to any recorded `[auth]` / `[quota]` substitution.

At the cap, escalate remaining items to the user (**Ruling resets rounds**) and write each ruling into the walkthrough.

**Done when:** `check-consensus.mjs` exits 0 on the walkthrough — then proceed to Handoff.

---

### 8. Handoff & Cleanup

**Await all reviews**: Never initiate handoff while any background review task or dispatch is still running. All launched target and reserve dispatches across all review phases must be fully completed and settled before beginning Step 8.

1. **Record diagnostics**: When the walkthrough has a `## Review Findings & Resolutions` section, run `check-consensus.mjs` on it first and return to Step 7's escalation while it exits 1. Then append `## Run Diagnostics` to the walkthrough (or plan if code review was skipped):
   - Scope classification, evaluated level (`low` / `medium` / `high`), `flow.diagnostics.effectiveLevel`, and any scope shift.
   - Artifact slug and `slugSource` (`explicit`, `branch`, `conversation`).
   - Rounds spent per phase vs `maxRounds`.
   - Active, failed, substituted, dropped, excluded, unavailable, or clamped delegates (`flow.diagnostics` — `unavailable`, `excluded`, `droppedPins`, `clamped`, `targetCountPin`, `livenessSource`; substitutions as recorded by the review skill; the run's exclusion set with each platform's `[auth]` / `[quota]` reason).
   - Summary of accepted/rejected findings, rebuttals confirmed by citing delegates, and verification command status.
2. **Relocate scratch**: Per `alignment.md` § Artifact Lifecycle, move scratch plan/walkthrough files to OS temp on completion using the shared helper:

   ```bash
   node <skills-dir>/dispatch/scripts/relocate-scratch.mjs "<plan path>" "<walkthrough path>"
   ```

   If the run is unresolved or halted, retain the artifacts in place and state why.
3. **Report to user**: Present run diagnostics and a link to the artifact (never output full inline artifact content or verbatim delegate reports in chat, to conserve write tokens). Git operations (commit, push, PR) remain for the user.

**Done when:** All review dispatches and background tasks across all phases are fully completed, diagnostics are appended, scratch artifacts relocated (or retained with stated reason), and handoff report delivered.

---

## Reference

### Platform Write Subagents
| Platform | Native Write Subagent |
|----------|-----------------------|
| `claude` | `general-purpose` |
| `agy` | `self` |
| `copilot` | `self` |
| `opencode` | `general` |

### Dispatch Invocation Rules
- **Flags**: the review skill maps each handed-over target to `dispatch` flags per `dispatch`'s `references/alignment.md` § Invocation Modes.
- **Parallelism**: Launch all targets in a round concurrently in the background; yield turn and await notifications.
- **Isolation**: External delegates are structurally read-only (`--mode plan` / read-only tools), except OpenCode on macOS, Windows, and Linux without Bubblewrap (`bwrap`) (accepted risk; see `dispatch`'s `references/providers.md`). Orchestrator / native subagents alone write code.
- **Fallback**: A failed target is replaced from `reserves` per `dispatch`'s `references/alignment.md` § Invocation Modes **Reserve substitution** (unpinned and count-pinned runs only — provider-pinned runs carry none), taking the next unused reserve in order; once reserves run out, it falls back to `dispatch`'s in-process read-only subagent.
