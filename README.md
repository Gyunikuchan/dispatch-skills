# dispatch-skills [![GitHub](https://img.shields.io/badge/GitHub-Gyunikuchan%2Fdispatch--skills-blue?logo=github)](https://github.com/Gyunikuchan/dispatch-skills)

Four agent skills for handing work to other coding-agent CLIs — Claude Code, Antigravity, GitHub Copilot, OpenCode — and adjudicating what they send back. Delegates return **claims, not verdicts**: the delegate reports, the orchestrator verifies against the code, and only what survives reaches you.

## Install

Each skill installs independently:

```bash
npx skills add Gyunikuchan/dispatch-skills --skill dispatch
```

Or take the whole set:

```bash
npx skills add Gyunikuchan/dispatch-skills --all
```

Add `-g` for a user-level install.

## The skills

| Skill | What it does | Depends on |
|-------|--------------|------------|
| [`dispatch`](skills/dispatch) | Hands a bounded task to another agent CLI through a provider cascade; read-only (no write mode), execution logs kept out of your context. | nothing |
| [`dispatch-plan-review`](skills/dispatch-plan-review) | 7-axis review of an implementation plan **before** code exists; folds accepted findings into the plan on disk. | `dispatch` |
| [`dispatch-code-review`](skills/dispatch-code-review) | 6-axis review of your working-tree diff; verifies every claim against the cited lines. | `dispatch` |
| [`implement-dispatch`](skills/implement-dispatch) | The full loop: plan → plan review → implement → code review → apply → re-review to consensus. | all three |

Dependencies point one way and never back. `dispatch` references nothing; the review skills reference only `dispatch`; `implement-dispatch` references all three **by skill name**, never by hard-coded path. Install only what you want — but install whatever you do want to the **same scope**, all global or all project-local: the scripts locate each other as siblings in one skills directory, so a split install (global `dispatch`, project-local `implement-dispatch`) fails to start.

## Quick start

Delegate a question, read-only, letting the cascade pick a provider:

```
/dispatch -f "src/domain/pricing.ts" "Explain how discount stacking is applied here, and flag any order-dependence."
```

Review a plan before code exists:

```
/dispatch-plan-review .scratch/plan/2026-09-11-schema-v4.md focus on migration safety
```

Review what you just changed:

```
/dispatch-code-review the current changes, focus on the allocation math
```

Run the whole development loop with two reviewers (`<level> (<pins>): <ask>`):

```
/implement-dispatch high (claude,agy): migrate the persisted schema to v4
```

## Design

- **Delegates are read-only.** External CLIs never write; the orchestrator alone edits (plan review folds findings into the plan; standalone code review applies accepted fixes).
- **Context hygiene.** Execution traces stream to a temp log; the orchestrator receives the banner, the log path, and the final answer.
- **Evidence over votes.** A finding the code confirms is accepted however few delegates raised it; one the code refutes is rejected even if every delegate raised it.
- **Host-neutral.** No opinions about your codebase are baked in. The delegate reads your project's conventions directly from `AGENTS.md` / `CLAUDE.md` in the workspace and falls back to industry best practices.
- **Coverage is visible.** Review reports list every axis, so "clean" and "never looked" are distinguishable.

## Requirements

Node >= 18 and at least one provider CLI on `PATH` (`claude`, `agy`, `copilot`, or `opencode`). No dependencies. If no provider is reachable, `dispatch` exits with a clear error explaining why.

## License

MIT — see [LICENSE](LICENSE).
