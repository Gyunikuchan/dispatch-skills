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

- `<level>` — `low`, `medium`, `high`, `max`. Controls **depth**: which steps run and how far re-review goes.
- `(<pins>)` — comma-separated dispatch provider keys (`claude`, `agy`, `copilot`, `local`). Controls **breadth**: the fan-out set becomes exactly these at every dispatch step. An unrecognised key stops the run and prompts the user with valid keys.

`/implement-dispatch high (local): fix the allocation drift` runs one reviewer (local) at every step, with `high`'s re-review-to-consensus depth.

## Levels

| Level | Step 3 plan review | Step 5 code review | Step 7 re-review |
|-------|--------------------|--------------------|------------------|
| `low` | skip | 1 agent | skip |
| `medium` | 1 agent | 1 agent | 1 agent, to consensus |
| `high` | 1 agent | all agents | agents whose findings you accepted, to consensus |
| `max` | all agents | all agents | agents whose findings you accepted, to consensus |

**Fan-out set**: unpinned, "all agents" is the `dispatch` cascade minus this orchestrator's own platform, and "1 agent" is the first of those. Pinned, both are the pins. Derive the cascade from the `dispatch` skill at run time rather than assuming a fixed provider list.

## Host conventions

Read the host repository's `AGENTS.md` / `CLAUDE.md` once at the start of the run and carry three things through it:

- **Verify command** — the repository's lint + typecheck + test entry point, run at Steps 4, 6, and 7.
- **Escalation triggers** — the repository's own "ask before you assume" list, which extends the Deadlock section below.

Run artifacts live in `.scratch/plan/`, or the scratch location the repository documents.

## Dispatch invariants

This skill owns the dispatch call itself, the fan-out breadth, and the pinning — so hand the review skills the invocation below rather than letting them dispatch on their own.

Every dispatch is a **pinned** run (`--provider <key>`), launched **backgrounded**, all round delegates launched in a single turn. Yield the turn and await reactive notification.

```bash
# Antigravity (project-local)
node .agents/skills/dispatch/scripts/dispatch.mjs --provider <key> -f "<plan>" -f "<walkthrough>" "<populated prompt>"
# Claude Code (project-local)
node .claude/skills/dispatch/scripts/dispatch.mjs --provider <key> -f "<plan>" -f "<walkthrough>" "<populated prompt>"
# Global install
node ~/.agents/skills/dispatch/scripts/dispatch.mjs --provider <key> -f "<plan>" -f "<walkthrough>" "<populated prompt>"
```

Dispatch is structurally read-only — delegates cannot modify the workspace. Pass `--allow-same-agent` only when pinning the orchestrator's own platform, and note this in the handoff — a reviewer sharing the orchestrator's platform shares its blind spots.

**Best-effort fan-out**: adjudicate returning reports and record failed delegates. If none return or a pinned provider fails, route directly to an in-process read-only subagent (`Explore` in Claude Code, `research` in Antigravity) with the same prompt to preserve provider provenance.

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

### 3. Plan review — `low` skips this step

Dispatch `dispatch-plan-review`'s prompt template to the fan-out set, attaching the plan.

Adjudicate returned claims per that skill's adjudication step — the requirement plus this repository's rules are ground truth. Fold accepted `MUST-FIX` items into the plan; escalate `Disputed` items to the user.

**Done when:** the plan on disk reflects every accepted finding, and all disputes are resolved.

### 4. Implement

Implement the plan's Change Set yourself — you hold the requirement context, ambiguities, and plan rationale. **Do not dispatch writes to external CLIs** — only the orchestrator or a native in-process subagent may modify the workspace.

- Work **test-first**: write a failing test before a fix or domain logic.
- Record any Change Set deviations and reasons for the walkthrough.
- Run the host verify command and iterate until green.

Delegate to a write-capable **native** in-process subagent (`general-purpose` in Claude Code, `self` in Antigravity) only on explicit user request or when the Change Set splits into file-disjoint chunks suitable for parallel execution. Require files changed, deviations with reasons, and verify output. External `dispatch` delegates are read-only and must not be used for implementation.

**Done when:** the host verify command passes and you have read the raw output yourself.

### 5. Code review

Write the run walkthrough at `.scratch/plan/<yyyy-mm-dd>-<slug>-walkthrough.md`, covering the ask, changes, deviations from the Change Set, verification output, and focus areas. This is the orchestrator-supplied walkthrough `dispatch-code-review` resolves at its first tier.

Dispatch `dispatch-code-review`'s prompt template to the fan-out set, attaching the plan and walkthrough.

Adjudicate every returned claim per that skill's adjudication step, including its dedupe and evidence-over-votes rules when more than one delegate reports.

**Done when:** every actionable claim carries a verdict.

### 6. Apply or dispute

Apply accepted findings, keeping the host verify command green. Escalate contested findings to the user with the delegate's claim, your counter-reading, and cited lines. Apply user rulings verbatim.

Append the round's outcome to the walkthrough under `## Accepted findings — round <n>`, in the review skill's finding grammar. This is what Step 7 diffs against.

**Done when:** every accepted finding is applied and verified, every dispute is ruled on, and the round is recorded in the walkthrough.

### 7. Re-review — `low` skips this step

If Step 6 applied no changes, proceed to handoff. Otherwise re-dispatch `dispatch-code-review` to the delegates **whose findings you accepted** (`medium`: 1 agent), attaching the updated walkthrough with its accepted-findings rounds.

**Consensus** is reached when a round returns no new accepted findings on changed lines. Cap at **2 re-review rounds**; on reaching the cap or on irreconcilable delegate contradictions, escalate to the user.

**Done when:** a round reaches consensus, or the user has ruled on the deadlock.

## Deadlock

Resolve ambiguity or deadlock by asking the user (`ask_question` / `AskUserQuestion`). Trigger on: unresolvable contradictions after Step 1, claims unsettleable from code, conflicting delegate claims, or reaching the re-review cap. Present competing readings with cited code evidence.

## Handoff

Conclude per the host repository's handoff contract, specifying: reviewing delegates, failed delegates, absent optional skills, and rejected or downgraded findings.

**Prune** `.scratch/plan/` artifacts upon reaching consensus; durable knowledge belongs in code, tests, decision records, or the repository's observation log. Preserve plan artifacts only for **unresolved** runs (re-review cap hit, open dispute, or user halt) as resumption points, noting why in the handoff.

**Done when:** the plan and walkthrough are deleted, or explicitly retained with stated rationale in handoff.

Leave git operations (branching, committing, PRs) to the user.
