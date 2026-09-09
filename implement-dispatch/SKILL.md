---
name: implement-dispatch
description: Implement features or fixes with cross-agent review loops across external CLIs (dispatch, adjudicate, re-review to consensus). Use on /implement-dispatch or when requested for multi-agent implementation or second-opinion reviews.
---

# implement-dispatch

Implement a feature or fix, then buy second opinions from other agent CLIs. This skill owns the **control flow** — fan-out breadth, re-review depth, and escalation gates. Three skills carry the rest:

| Skill | Owns | Required |
|-------|------|----------|
| `dispatch` | The runners, the cascade, the flags | Yes |
| `dispatch-plan-review` | Plan review criteria and adjudication | Optional — Step 3 skips without it |
| `dispatch-code-review` | Code review criteria and adjudication | Optional — Steps 5–7 skip without it |

Reach each by skill name. When an optional skill is absent, say so in the handoff and run the reduced flow.

Delegates return **claims**; the orchestrator adjudicates, accepts, rejects, and applies them.

## Invocation

```
/implement-dispatch <level> (<pins>): <feature | fix | ask>
```

Both `<level>` and `(<pins>)` are optional and case-insensitive; `<level>` defaults to `medium`, the colon is optional.

- `<level>` — `low`, `medium`, `high`, `max`. Controls **depth**: which steps run and how far re-review goes. See the [README](README.md) for level details.
- `(<pins>)` — comma-separated dispatch provider keys (`claude`, `agy`, `copilot`, `local`). Controls **breadth**: the fan-out set becomes exactly these at every dispatch step. An unrecognised key stops the run and prompts the user with valid keys.

## Host conventions

Read the host repository's `AGENTS.md` / `CLAUDE.md` once at the start of the run and carry two things through it:

- **Verify command** — the repository's lint + typecheck + test entry point, run at Steps 4, 6, and 7.
- **Escalation triggers** — the repository's own "ask before you assume" list, which extends the Deadlock section below.

Run artifacts live in `.scratch/plan/`, or the scratch location the repository documents.

## Dispatch invariants

### Resolve flow plan

Before Step 1, resolve the execution flow plan. This outputs concrete targets, round counts, and consensus flags for every dispatch step — no further fan-out calculation is needed.

```bash
# Antigravity (project-local)
node .agents/skills/implement-dispatch/scripts/resolve-flow.mjs --platform <key> [--level <level>] [--pins <key,key,...>]
# Claude Code (project-local)
node .claude/skills/implement-dispatch/scripts/resolve-flow.mjs --platform <key> [--level <level>] [--pins <key,key,...>]
# Global install
node ~/.agents/skills/implement-dispatch/scripts/resolve-flow.mjs --platform <key> [--level <level>] [--pins <key,key,...>]
```

Store the JSON output as `flow`. `flow['plan-review']`, `flow['code-review']`, and `flow.implementation` drive every subsequent step. If the script fails (missing config, unrecognised pins, all pins unavailable), surface the error to the user and stop.

### Dispatch calls

Every dispatch is a **pinned** run (`--provider <key>`), launched **backgrounded**, all round delegates launched in a single turn. Yield the turn and await reactive notification.

```bash
# Antigravity (project-local)
node .agents/skills/dispatch/scripts/dispatch.mjs --provider <key> -f "<plan>" -f "<walkthrough>" "<populated prompt>"
# Claude Code (project-local)
node .claude/skills/dispatch/scripts/dispatch.mjs --provider <key> -f "<plan>" -f "<walkthrough>" "<populated prompt>"
# Global install
node ~/.agents/skills/dispatch/scripts/dispatch.mjs --provider <key> -f "<plan>" -f "<walkthrough>" "<populated prompt>"
```

Dispatch is structurally read-only — delegates cannot modify the workspace. Pass `--allow-same-agent` when a target in `flow` has `allowSameAgent: true` (always present at `max` level, where the orchestrator's platform is included as a reviewer), and note this in the handoff.

**Best-effort fan-out**: adjudicate returning reports and record failed delegates. If none return or a pinned provider fails, route directly to an in-process read-only subagent (`Explore` in Claude Code, `research` in Antigravity) with the same prompt to preserve provider provenance.

### Adjudication and consensus

Applies to both plan-review (Step 3) and code-review (Steps 5–7). Use the `consensus` field from the relevant `flow` section.

**`consensus: true`** (high/max): you cannot unilaterally dismiss a finding with your own judgment alone. For every finding you believe is wrong, you must either (a) accept it, (b) escalate to the user, or (c) re-dispatch with a rebuttal message stating your counter-evidence and asking the delegate to reconsider.

**`consensus: false`** (low/medium): hard-evidence rejection is allowed — cite the specific line that directly contradicts the claim and reject it.

### Round cap and user ping

Both plan-review and code-review use a `rounds` field: the total number of dispatch calls before escalating to the user. After the user provides feedback, the counter resets and another `rounds` dispatches occur before the next ping.

- `rounds: 0` — skip the phase entirely.
- `rounds: 1` — one dispatch, no re-review; any unresolvable disputes escalate to the user immediately.
- `rounds: N` — dispatch up to N times total; escalate after N dispatches without consensus.

## Process

### 1. Understand the requirement

Restate the ask as checkable success criteria. Hunt contradictions, impossible states, and terms with more than one reading in this codebase.

Proceed under **explicitly stated assumptions**, recorded in the plan, rather than interrogating the user. Stop and ask (`ask_question` / `AskUserQuestion`) only on the host repository's escalation triggers.

**Done when:** success criteria are checkable, and every ambiguity is either resolved by the user or written down as an assumption.

### 2. Write the plan

Write `.scratch/plan/<yyyy-mm-dd>-<slug>.md`. External delegates read this file with no other context; each section stands alone:

- **Requirement** — the ask, restated.
- **Ambiguities & Resolutions** — each ambiguity and the settling assumption or user answer.
- **Success Criteria** — checkable tests that prove completion.
- **Change Set** — per-file changes and rationale.
- **Verification** — commands that must pass.
- **Out of Scope** — explicitly unhandled aspects.

**Done when:** the plan file exists, every success criterion maps to a change, and every change maps to a requirement.

### 3. Plan review — skip if `flow['plan-review'].rounds === 0`

Dispatch `dispatch-plan-review`'s prompt template to each platform in `flow['plan-review'].targets`, attaching the plan.

Adjudicate returned claims per that skill's adjudication step — the requirement plus this repository's rules are ground truth. Fold accepted `MUST-FIX` items into the plan. Apply the **Adjudication and consensus** rules above using `flow['plan-review'].consensus`.

Re-dispatch the updated plan to targets with unresolved disputes, up to `flow['plan-review'].rounds` total dispatches. After hitting the round cap without consensus, escalate remaining disputes to the user. After user feedback, the round counter resets and another `flow['plan-review'].rounds` dispatches may occur.

**Done when:** the plan on disk reflects every accepted finding, and all disputes are resolved or user-escalated.

### 4. Implement

Implement the plan's Change Set yourself — you hold the requirement context, ambiguities, and plan rationale. Only the orchestrator or a native in-process subagent may modify the workspace.

- Work **test-first**: write a failing test before a fix or domain logic.
- Use `flow.implementation` for model and effort hints if your platform supports subagent configuration.
- Record any Change Set deviations and reasons for the walkthrough.
- Run the host verify command and iterate until green.

Delegate to a write-capable **native** in-process subagent (`general-purpose` in Claude Code, `self` in Antigravity) only on explicit user request or when the Change Set splits into file-disjoint chunks suitable for parallel execution. Require files changed, deviations with reasons, and verify output.

**Done when:** the host verify command passes and you have read the raw output yourself.

### 5. Code review

Write the run walkthrough at `.scratch/plan/<yyyy-mm-dd>-<slug>-walkthrough.md`, covering the ask, changes, deviations from the Change Set, verification output, and focus areas. This is the orchestrator-supplied walkthrough `dispatch-code-review` resolves at its first tier.

Dispatch `dispatch-code-review`'s prompt template to each platform in `flow['code-review'].targets`, attaching the plan and walkthrough.

Adjudicate every returned claim per that skill's adjudication step, including its dedupe and evidence-over-votes rules when more than one delegate reports.

**Done when:** every actionable claim carries a verdict.

### 6. Apply or dispute

Apply accepted findings, keeping the host verify command green. Apply the **Adjudication and consensus** rules above using `flow['code-review'].consensus`. Escalate contested findings to the user with the delegate's claim, your counter-reading, and cited lines. Apply user rulings verbatim.

Append the round's outcome to the walkthrough under `## Accepted findings — round <n>`, in the review skill's finding grammar. This is what Step 7 diffs against.

**Done when:** every accepted finding is applied and verified, every dispute is ruled on, and the round is recorded in the walkthrough.

### 7. Re-review — skip if `flow['code-review'].rounds === 1`

Track total code-review dispatches across Steps 5 and 7. If Step 6 applied no changes, proceed to handoff without re-dispatching.

Otherwise re-dispatch `dispatch-code-review` to the delegates **whose findings you accepted** in the previous round, attaching the updated walkthrough.

- **Consensus**: a round returns no new accepted findings on previously changed lines — proceed to handoff.
- **Round cap**: when total dispatches reach `flow['code-review'].rounds` without consensus, escalate to the user with remaining disputes. After user provides feedback, reset the counter and dispatch another `flow['code-review'].rounds` rounds.

**Done when:** a round reaches consensus, or the user has ruled on the deadlock.

## Deadlock

Resolve ambiguity or deadlock by asking the user (`ask_question` / `AskUserQuestion`). Trigger on: unresolvable contradictions after Step 1, claims unsettleable from code, conflicting delegate claims, or reaching the round cap. Present competing readings with cited code evidence.

## Handoff

Conclude specifying: reviewing delegates, failed delegates, absent optional skills, and rejected or downgraded findings.

**Prune** `.scratch/plan/` artifacts upon reaching consensus; durable knowledge belongs in code, tests, decision records, or the repository's observation log. Preserve plan artifacts only for **unresolved** runs (re-review cap hit, open dispute, or user halt) as resumption points, noting why in the handoff.

**Done when:** the plan and walkthrough are deleted, or explicitly retained with stated rationale in handoff.

Leave git operations (branching, committing, PRs) to the user.
