# dispatch-skills

Four agent skills for handing work to other coding-agent CLIs — Claude Code, Antigravity, GitHub Copilot, OpenCode — and adjudicating what they send back.

Delegates return **claims, not verdicts**. Every skill here draws the same line: the delegate reports, the orchestrator verifies against the code, and only what survives reaches you.

## Install

Each skill installs independently:

```bash
npx skills add Gyunikuchan/dispatch-skills --skill dispatch
```

Or take the whole set:

```bash
npx skills add Gyunikuchan/dispatch-skills --all
```

Skills land in `.agents/skills/` and symlink into `.claude/skills/` (and any other detected agent directory). Add `-g` for a user-level install.

## The skills

| Skill | What it does | Depends on |
|-------|--------------|------------|
| [`dispatch`](dispatch) | Hands a bounded task to another agent CLI through a provider cascade; read-only by default, execution logs kept out of your context. | nothing |
| [`dispatch-plan-review`](dispatch-plan-review) | 6-axis review of an implementation plan **before** code exists; folds accepted findings into the plan on disk. | `dispatch` |
| [`dispatch-code-review`](dispatch-code-review) | 5-axis review of your working-tree diff; verifies every claim against the cited lines. | `dispatch` |
| [`implement-dispatch`](implement-dispatch) | The full loop: plan → plan review → implement → code review → apply → re-review to consensus. | all three (reviews optional) |

Dependencies point one way and never back. `dispatch` references nothing; the review skills reference only `dispatch`; `implement-dispatch` references all three **by skill name**, so nothing breaks when they install to different paths. Install only what you want.

## Quick start

Delegate a question, read-only, letting the cascade pick a provider:

```bash
node .agents/skills/dispatch/scripts/dispatch.mjs \
  -f "src/domain/pricing.ts" \
  "Explain how discount stacking is applied here, and flag any order-dependence."
```

Review what you just changed:

```
dispatch-code-review the current changes, focus on the allocation math
```

Run the whole loop with two reviewers:

```
/implement-dispatch high (claude,agy): migrate the persisted schema to v4
```

## Design

- **Read-only by default.** Reviews never write. Delegation writes only with an explicit `--allow-write`.
- **Context hygiene.** Execution traces stream to a temp log; the orchestrator receives the banner, the log path, and the final answer.
- **Evidence over votes.** A finding the code confirms is accepted however few delegates raised it; one the code refutes is rejected even if every delegate raised it.
- **Host-neutral.** No opinions about your codebase are baked in. The delegate reads your project's conventions directly from `AGENTS.md` / `CLAUDE.md` in the workspace and falls back to industry best practices.
- **Coverage is visible.** Review reports list every axis, so "clean" and "never looked" are distinguishable.

## Requirements

Node >= 24 and at least one provider CLI on `PATH` (`claude`, `agy`, `copilot`, or `opencode`). No dependencies.

## License

MIT — see [LICENSE](LICENSE).
