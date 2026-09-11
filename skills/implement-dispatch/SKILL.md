---
name: implement-dispatch
description: Implement features or fixes with cross-agent review loops across external CLIs (dispatch, adjudicate, re-review to consensus). Use on /implement-dispatch, multi-agent implementation, or cross-agent review loops.
---

# implement-dispatch

Implement a feature or fix with cross-agent review loops across external agent CLIs. This skill owns the **control flow** — fan-out breadth, re-review depth, consensus gates, and artifact cleanup. Upstream skills carry specific mechanics:

| Skill | Role | Required |
|-------|------|----------|
| `dispatch` | Runner execution, provider cascade, CLI flags, sandboxing | Yes |
| `dispatch-plan-review` | Plan template, 7 review axes, adjudication table, plan finding grammar | Optional (Step 3 skipped if absent) |
| `dispatch-code-review` | Walkthrough template, 6 review axes, adjudication table, code finding grammar | Optional (Steps 5–7 skipped if absent) |

Reference each skill by name. If an optional skill is absent, name its absence in the handoff, author the artifact with standard headings, and proceed with the reduced flow.

Delegates return **claims**; the orchestrator adjudicates and applies them.

## Invocation

```
/implement-dispatch <level> (<pins>): <feature | fix | ask>
```

Both `<level>` and `(<pins>)` are optional and case-insensitive; `<level>` defaults to `medium`, and the colon is optional.

- `<level>` — `low`, `medium`, `high`, `max`. Controls depth (wave caps, consensus requirements, tool-turn budgets), target breadth when unpinned, and model/effort configuration per phase.
- `(<pins>)` — comma-separated provider keys (`claude`, `agy`, `copilot`, `opencode`), or `dispatch`'s `--provider` aliases (e.g. `antigravity`, `claudecode`), normalized to the canonical key. Overrides breadth: fans out to exactly these providers, whatever the level's count.

## Flow Plan

Resolve the flow plan at the end of Step 1 once scope is classified, and store the output as `flow`:

```bash
node <skills-dir>/implement-dispatch/scripts/resolve-flow.mjs --platform <key> [--level <level>] [--pins <key,key,...>]
```

Resolve `<skills-dir>` as `dispatch` does (`.agents/skills`, `.claude/skills`, or `~/.agents/skills`). `<key>` is the orchestrator's platform key (`claude`, `agy`, `copilot`, `opencode`). `--validate-only` checks the config schema alone and rejects every other flag.

`resolve-flow.mjs` resolves the review/implementation flow only — no artifact paths or slug. Resolve those separately via `dispatch`'s `resolve-artifact-paths.mjs` (see Host Conventions below).

| Field | Read at | Meaning |
|-------|---------|---------|
| `flow['plan-review'].targets` | Step 3 | Platforms to dispatch (`platform`, `model?`, `effort?`, `allowSameAgent?`) |
| `flow['plan-review'].maxRounds` | Step 3 | Plan review wave cap; `0` means the phase is configured off |
| `flow['plan-review'].consensus` | Step 3 | Plan review consensus requirement (`true` / `false`) |
| `flow['plan-review'].toolTurns` | Step 3 | Tool-turn budget handed to each plan reviewer |
| `flow.implementation` | Step 4 | Orchestrator platform plus model and effort hints for native subagents |
| `flow['code-review'].targets` | Steps 5, 7 | Platforms to dispatch (`platform`, `model?`, `effort?`, `allowSameAgent?`) |
| `flow['code-review'].maxRounds` | Steps 5, 7 | Code review wave cap; `0` means the phase is configured off |
| `flow['code-review'].consensus` | Steps 6, 7 | Code review consensus requirement (`true` / `false`) |
| `flow['code-review'].toolTurns` | Steps 5, 7 | Tool-turn budget handed to each code reviewer |
| `flow.diagnostics` | Step 8 | `{ effectiveLevel: string, unavailable: string[], droppedPins: { [section]?: string[] }, clamped: { [section]?: { requested: number, resolved: number } } }` — report as data |

Artifact paths (plan/walkthrough) are not part of `flow` — resolve them separately via `dispatch`'s `resolve-artifact-paths.mjs` (Host Conventions below).

A **round** is one fan-out pass where every target in `targets` is launched in parallel within a single turn. `maxRounds` counts total waves **including the first review**. Plan review and code review track independent round counters.

When `targets` is empty and `maxRounds > 0`, external platforms are unavailable: take the in-process subagent fallback below. When `maxRounds === 0` the phase is configured off — run neither the dispatch nor the fallback.

An unpinned run with no live candidates degrades to the fallback (`targets: []`, `maxRounds > 0`); a pinned run where every named pin is unavailable is a hard `resolve-flow.mjs` error instead — a pin names a specific delegate the user asked for, so its absence is a failure worth surfacing rather than silently substituting.

## Platform Agent Modes

| Platform | Write-capable subagent | Read-only subagent |
|----------|------------------------|--------------------|
| `claude` | `general-purpose` | `Explore` |
| `agy` | `self` | `research` |
| `copilot` | `self` | `self` (read-only tool set) |
| `opencode` | orchestrator executes directly | orchestrator executes directly |

## Operating Invariants

- **Mandatory Entry Gate**: Every `/implement-dispatch` invocation begins by running `resolve-flow.mjs` (Step 1). Never edit code or author artifacts before resolving `flow`. Even `low` depth runs execute the resolver, code review, and run diagnostics.
- **Execution boundaries**: External delegates run structurally read-only, per `dispatch`'s CLI mechanics. Initial implementation is dispatched primarily to native write-capable subagents with model/effort from `flow.implementation`. The orchestrator directly applies code fixes resulting from review cycles (Step 6).
- **Parallel turns**: Launch all delegates for a round concurrently in the background, then yield the turn and await notifications.
- **Provider flags**: Always pass `--provider <target.platform> --no-config` so each dispatch stays on a platform from this skill's own config and ignores `dispatch`'s config. Pass target hints `-m <target.model>` and `-e <target.effort>` when present. Pass `--allow-same-agent` when `target.allowSameAgent: true`. Attach artifacts via `-f "<path>"` (forward slashes).
- **Fallback**: When a provider fails (a pinned target never cascades to another platform) or no candidate is available, re-run the prompt and attachments through the in-process read-only subagent from the platform agent-mode table.
- **Target affinity**: Route re-reviews and dispute rebuttals back to the specific delegate handles that raised or accepted them.
- **Evidence over votes**: Deduplicate findings across delegate reports by target locus (`## <Section>` or `<file>:L<line>`). Ground truth is the requirement, active code, and repository rules.
- **Consensus rule**: Under `consensus: true`, every disputed finding must be accepted, escalated to the user, or rebutted with counter-evidence in re-dispatch. Under `consensus: false`, reject directly when verified counter-evidence exists.
- **Round cap escalation**: Reaching a phase's round cap without consensus escalates remaining disputes to the user. User feedback starts a fresh cap: reset that phase's round counter to 0 and allow up to `flow['<phase>'].maxRounds` additional waves.

## Host Conventions

Read the host repository's `AGENTS.md` / `CLAUDE.md` once at start for:
- **Verify command**: Project test/lint command kept green across all code changes (Steps 4, 6, 7).
- **Escalation triggers**: Project-specific decisions requiring user consultation before proceeding.
- **Artifact location convention**: An explicit plan/walkthrough path or directory the repo names, if any.

When the repo names an explicit location above, use it and stop. Otherwise resolve both artifact locations once, at Step 1, via `dispatch`'s `resolve-artifact-paths.mjs` (see its own `--slug`/`--orchestrator` flags; slug derivation and native-vs-scratch tiering both live there now — not in `resolve-flow.mjs`), per `dispatch`'s [skill alignment: artifact path resolution](../dispatch/references/alignment.md#planwalkthrough-artifact-resolution) — native tier (e.g. Antigravity's `<appDataDir>/brain/<conversation-id>/implementation_plan.md` and `walkthrough.md`, written and updated directly with the respective review skill's template) preferred over the resolved scratch path under `.scratch`, reused for every subsequent write — never author multiple copies (e.g. a native and a scratch) of the same artifact.

Hand the resolved path to `dispatch-plan-review` / `dispatch-code-review` as the orchestrator-supplied artifact so they don't re-derive it.

## Process

### 1. Understand Requirement & Scope

1. Restate the ask as checkable success criteria. Record settling assumptions directly in the plan; query the user only on unresolvable contradictions or repository escalation triggers.
2. **Scope gate**: Classify the change to determine the level:
   - `trivial` (single-file mechanical edit, rename, comment/typo fix, constant change) → downshift to `low`.
   - `focused` (single component/contract) → requested level.
   - `cross-cutting` (multiple components, schema, security boundary) → requested level.
   *(Scope downshifts only to `low`; never upshifts and never overrides an explicit level).*
3. Run `resolve-flow.mjs` to resolve `flow`. If the resolver exits non-zero, halt immediately and show the full error output to the user — every validation problem is listed and must be resolved before proceeding.
4. Resolve the plan and walkthrough artifact paths per Host Conventions via `dispatch`'s `resolve-artifact-paths.mjs`, which derives the slug itself (explicit → current git branch → active orchestrator's conversation id — see its own docs) and record the resolved paths for reuse in Steps 2 and 5.

**Done when:** Success criteria are checkable, assumptions are recorded, scope is classified, `resolve-flow.mjs` has executed and `flow` is loaded, and artifact paths are resolved.

---

### 2. Write the Plan

Write the plan at the path resolved in Step 1 following `dispatch-plan-review`'s plan template. External delegates read this file as their sole context.

**Done when:** Plan file exists on disk with all template sections populated.

---

### 3. Plan Review Loop

*Skipped when `flow['plan-review'].maxRounds === 0`.*

1. **Dispatch**: Dispatch `dispatch-plan-review` prompt template in parallel to each target in `flow['plan-review'].targets` with attached plan (`-f`), populating `<Tool Turn Budget>` from `flow['plan-review'].toolTurns`. Round 1 uses `Review Scope: Full review`.
2. **Adjudicate**: Evaluate returned claims per `dispatch-plan-review`'s adjudication table. Discard passing axes.
3. **Fold & Re-dispatch**: Apply accepted findings to the plan on disk and record outcomes under `## Review Findings & Resolutions`. When accepted changes modify sections and round count < `flow['plan-review'].maxRounds`, re-dispatch to reviewing delegates with `Review Scope: Re-review round <n>` naming changed sections.
4. **Consensus & Cap**: Enforce `flow['plan-review'].consensus`. Escalate unresolved disputes to the user when cap is reached.

**Done when:** Plan on disk reflects all accepted findings, and all disputes are resolved or user-ruled.

---

### 4. Implement

Dispatch implementation test-first to the native write-capable subagent from the platform agent-mode table, configured with `model` and `effort` from `flow.implementation`. For `trivial` scope or if subagent spawn fails, the orchestrator writes the initial code directly while keeping all subsequent review and diagnostic steps intact.

Require the subagent to implement Proposed Changes, run the host verify command until green, and report back modified files, verification output, and any deviations.

**Done when:** Code changes are complete, raw verify output has been inspected, and tests are green.

---

### 5. Code Review

*Skipped when `flow['code-review'].maxRounds === 0`.*

1. Write the walkthrough at the path resolved in Step 1 following `dispatch-code-review`'s walkthrough template.
2. Dispatch `dispatch-code-review` prompt template in parallel to each target in `flow['code-review'].targets` with attached walkthrough and plan (`-f`), populating `<Tool Turn Budget>` from `flow['code-review'].toolTurns` and using `Review Scope: Full review`. (Consumes round 1 of code review).
3. Adjudicate returned claims against cited `<file>:L<line>` per `dispatch-code-review`.

**Done when:** Walkthrough exists on disk, dispatches completed, and round 1 claims are adjudicated.

---

### 6. Apply Fixes & Settle Disputes

1. Apply accepted findings to the codebase directly as the orchestrator.
2. Update the walkthrough (`## Changes Made`, `## Verification & Validation`, and append round adjudications under `## Review Findings & Resolutions`).
3. Run the host verify command until green.
4. Enforce `flow['code-review'].consensus`: escalate unresolvable disputes to the user via interactive questions with cited lines and counter-readings.

**Done when:** Accepted fixes are applied, verify command is green, and round adjudications are recorded in the walkthrough.

---

### 7. Re-Review Loop

While previous round modified code and code review round count < `flow['code-review'].maxRounds`:
1. Re-dispatch to reviewing targets with updated walkthrough and `Review Scope: Re-review round <n>` naming modified lines.
2. Adjudicate returned claims and apply fixes per Step 6.

Proceed to Handoff when:
- **Consensus**: Round returns no new accepted findings on modified code.
- **No changes**: Step 6 applied no modifications.
- **Round cap**: Escalate remaining disputes to the user; user feedback resets the counter.

**Done when:** Consensus is reached, no modifications remain, or user rules on deadlock.

---

### 8. Handoff & Cleanup

1. **Record run diagnostics**: Append a `## Run Diagnostics` section — owned by `implement-dispatch`, not part of `dispatch-code-review`'s walkthrough template — to the walkthrough, covering:
   - Scope classification, plus `flow.diagnostics.effectiveLevel` and any scope downshift from Step 1.
   - Artifact slug and its `slugSource` (`explicit` / `branch` / `conversation`); a `conversation` slug is found automatically only in this conversation.
   - Rounds spent per phase against `maxRounds`.
   - Reviewing delegates (provider keys, session handles) and any failed delegates.
   - `flow.diagnostics.unavailable`, `droppedPins`, and `clamped` reported as data.
   - Absent optional skills (if any).
   - Summary of accepted fixes and rejected/downgraded findings.
   - Verification command status.

   When Step 5 was skipped (no walkthrough exists), append this section to the plan instead.
2. **Relocate scratch artifacts**: If Step 1 resolved the scratch-fallback tier, upon reaching consensus/completion move (never delete) the scratch plan and walkthrough files this run created into the OS temp directory (`os.tmpdir()` / `$TMPDIR`), preserving filenames. When the session ends unresolved (round cap reached, open disputes, or user halt), retain scratch files in place for resumption and state reasons in the handoff.
3. **Report to user**: Report only diagnostics and a link to the artifact — its content stays on disk. Format the hand-off per host repository conventions in `AGENTS.md` / `CLAUDE.md`, including a link to the artifact from Step 1 above:
   - Host-convention or native tier: a normal repo-relative markdown link.
   - Scratch tier, post-relocation: a chat-only path to the OS temp location — exempt from the repo's relative-link rule since it is never written into a repo file (see `AGENTS.md` Communication section).
4. Leave git operations (commit, push, PR) to the user.

**Done when:** Run diagnostics are recorded in the walkthrough (or plan), scratch artifacts are relocated to the OS temp directory (or retained in place with explicit reason), and the handoff report links to the artifact without re-emitting its content.
