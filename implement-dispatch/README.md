# implement-dispatch

Implement a feature or fix, then buy second opinions from other coding-agent CLIs — plan review before you write, code review after, and re-review until consensus.

This skill owns the **control flow**: how wide to fan out, how deep to re-review, and when to stop and ask you. It writes the plan, implements it, and adjudicates everything the reviewers send back. Delegates return **claims**; the orchestrator decides.

## Install

```bash
npx skills add Gyunikuchan/dispatch-skills --skill implement-dispatch
```

| Skill | Role | Required |
|-------|------|----------|
| [`dispatch`](../dispatch) | The runner and provider cascade | Yes |
| [`dispatch-plan-review`](../dispatch-plan-review) | Plan review criteria and adjudication | Optional — plan review is skipped without it |
| [`dispatch-code-review`](../dispatch-code-review) | Code review criteria and adjudication | Optional — code review and re-review are skipped without it |

Install all four at once:

```bash
npx skills add Gyunikuchan/dispatch-skills --all
```

## Usage

```
/implement-dispatch <level> (<pins>): <feature | fix | ask>
```

Both `<level>` and `(<pins>)` are optional; `<level>` defaults to `medium`, and the colon is optional.

```
/implement-dispatch add a CSV export button to the transactions table
```

```
/implement-dispatch high: fix the off-by-one in pagination
```

```
/implement-dispatch max (claude,agy): migrate the persisted schema to v4
```

```
/implement-dispatch low (local): rename the Household.owner field to primaryHolder
```

- **`<level>`** — `low`, `medium`, `high`, `max`. Controls depth.
- **`(<pins>)`** — dispatch provider keys (`claude`, `agy`, `copilot`, `local`). Controls breadth: the fan-out set becomes exactly these at every step.

## Levels

| Level | Plan review | Code review | Re-review |
|-------|-------------|-------------|-----------|
| `low` | skip | 1 agent | skip |
| `medium` | 1 agent | 1 agent | 1 agent, to consensus |
| `high` | 1 agent | all agents | agents whose findings you accepted, to consensus |
| `max` | all agents | all agents | agents whose findings you accepted, to consensus |

Unpinned, "all agents" is the `dispatch` cascade minus the orchestrator's own platform, and "1 agent" is the first of those.

## The loop

1. **Understand** — restate the ask as checkable success criteria; hunt contradictions and ambiguous terms.
2. **Plan** — write `.scratch/plan/<date>-<slug>.md` with requirement, ambiguities, success criteria, change set, verification, and out-of-scope.
3. **Plan review** — fan out to `dispatch-plan-review`, adjudicate, fold accepted findings into the plan on disk.
4. **Implement** — test-first, by the orchestrator itself, until the host verify command is green.
5. **Code review** — write a walkthrough, fan out to `dispatch-code-review`, adjudicate every claim against the cited lines.
6. **Apply or dispute** — apply what survives, escalate what does not, and record the round in the walkthrough.
7. **Re-review** — re-dispatch to the delegates whose findings you accepted, until a round returns no new accepted findings. Capped at 2 rounds.

Every dispatch is pinned, read-only, backgrounded, and launched for the whole round in a single turn.

## Host conventions

The skill reads your `AGENTS.md` / `CLAUDE.md` once per run and carries two things from it: your **verify command** (run at steps 4, 6, and 7) and your **escalation triggers** (which extend its own deadlock rules). Project conventions are read directly by each delegate from the workspace.

It ships no opinions about your codebase. Everything project-specific comes from your docs.

## What you get back

A handoff naming: what changed, verification status, which delegates reviewed, which failed, which optional skills were absent, and every finding that was rejected or downgraded — so a quiet review and an empty review are distinguishable.

Run artifacts in `.scratch/plan/` are pruned on consensus, and retained with a stated reason when a run ends unresolved.

Git operations — branching, committing, PRs — are left to you.
