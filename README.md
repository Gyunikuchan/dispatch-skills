# dispatch-skills

[![Version](https://img.shields.io/badge/version-v0.5.0-blue.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

Delegate work and reviews to other agent CLIs — Claude Code, Antigravity, GitHub Copilot, OpenCode — from whichever agent you already work in. Independent models plan, review, and cross-check each other; your host agent verifies every claim against the real code before accepting it, so a confident wrong answer from one model does not become a change in your tree.

Delegates always run read-only. Writes happen only through your host agent's own write subagent, behind an approval gate.

## Contents

- [Why dispatch-skills?](#why-dispatch-skills)
- [Key differentiators](#key-differentiators)
- [Install](#install)
- [Skills](#skills)
- [Quick start](#quick-start)
- [License](#license)

## Why dispatch-skills?

One agent working alone carries its own blind spots all the way to your working tree: it keeps the assumption it started with, grades its own output as correct, and surfaces the design flaw only after five hundred lines exist. `dispatch-skills` splits the work into phases and puts a different model on each side of the review, while your host agent keeps the working tree and the approval gate.

This is the full loop for a large change — a design decomposed into increments, each increment planned, reviewed, implemented, and verified before the next:

```mermaid
flowchart TD
    User(["👤 Requirement"]) --> Design["🗺️ Technical design"]
    Design --> DesignReview["⚡ Design review"]
    DesignReview --> Increments["🧩 Increment graph"]
    Increments --> Plan["📝 Increment plan"]
    Plan --> PlanReview["⚡ Plan review"]
    PlanReview --> Gate{"🛑 One approval gate"}
    Gate --> Baseline["✅ Baseline tests"]
    Baseline --> Implement["💻 Write subagent"]
    Implement --> Verify["✅ Tests, lint, build"]
    Verify --> CodeReview["⚡ Code review"]
    CodeReview --> Fix["🔧 Verified fixes"]
    Fix --> Consensus{"🔄 Settled?"}
    Consensus -->|Findings remain| CodeReview
    Consensus -->|Next increment| Plan
    Consensus -->|Last increment| Integration["📦 Integration + handoff"]
    Consensus -->|Cap or deadlock| User
    Integration --> User
```

Smaller work enters the same loop further down: `/dispatch implement:` starts at the plan, and a standalone review runs one box on its own.

## Key differentiators

| What bites you | What dispatch does about it |
|---|---|
| **🎲 One model's blind spot** | Route the same plan or diff across genuinely different architectures — Claude, Gemini, GPT, GLM, Qwen, local models — so one family's blind spot is another's obvious catch. |
| **🪞 Grading its own homework** | Unpinned runs diversity-sort on purpose: every platform's first reviewer answers before any platform's second, your own host platform goes last, and your host's active model goes last within it. Reviewing with yourself takes an explicit pin. |
| **⚖️ Confident hallucinations winning the vote** | Reviewers return *claims*, not verdicts, and must cite `file:L<line>` or `§ plan section`. Your host agent checks each claim against the real code and your `AGENTS.md` / `CLAUDE.md`. Contradicted, uncited, and speculative claims are rejected however many models agreed; a verified defect is accepted even from one. |
| **💡 Finding the design flaw last** | A missing migration caught in a plan file costs pennies; the same flaw found after five hundred lines costs a debugging session. Design and plan review are where the one-shot success rate is won. |
| **🛡️ A delegate editing your tree** | Delegates run in read-only mode — plan mode, a read-tool allowlist, a write-tool denylist — and the runners strip credentials from their environment and guard sensitive files. OS sandboxing (Seatbelt, Bubblewrap, the Copilot sandbox) layers on top where the platform supports it. Every edit comes from your host's own write subagent, after you approve. |
| **🧼 A long run poisoning the session** | Subprocess logs, traces, and prompts stream to OS temp. Only dense syntheses and actionable findings enter your context window. |
| **💰 One provider's rate limit** | Spread the load across every CLI you already pay for instead of buying a redundant top tier, and keep working in your own IDE while other models do the reading. |
| **⚡ PR bots reviewing too late** | Review the uncommitted diff in your terminal, with an automated fix-and-verify loop, while the context that produced it is still live. |

## Install

```bash
npx skills add Gyunikuchan/dispatch-skills -s '*'
```

Requires Node.js `>=22` and at least one provider CLI on your `PATH`.

Nothing is enabled until you create a config: copy `skills/dispatch/config.sample.jsonc` to `config.jsonc` (or `config.local.jsonc`) beside it, and keep the models you actually pay for. Then check what resolved:

```bash
node skills/dispatch/scripts/dispatch.mjs --doctor --level high
```

> [!NOTE]
> Install every skill into the same scope — all project-local or all global (`-g`). The aliases resolve `dispatch` as a sibling, so a mixed install breaks them.

> [!NOTE]
> OS sandboxing degrades rather than fails. Where it is unavailable — native Windows, Linux without Bubblewrap, a provider that rejects the flag — the delegate still runs, read-only but unsandboxed, and says so with a `[dispatch] WARNING:` line and `sandboxDowngraded` in its structured output. Use WSL2 on Windows if you need the sandbox enforced. Antigravity has no sandbox; plan mode is its only write boundary.

See [`skills/dispatch/README.md`](skills/dispatch/README.md) for the config tables, levels, sandboxing, and CLI flags.

## Skills

| Skill | Use it for |
|---|---|
| [`dispatch`](skills/dispatch/README.md) | Everything below, plus one-off delegation. Model- and user-invoked. |
| [`dispatch-plan-review`](skills/dispatch-plan-review/README.md) | Alias for `/dispatch review plan:` |
| [`dispatch-design-review`](skills/dispatch-design-review/README.md) | Alias for `/dispatch review design:` |
| [`dispatch-code-review`](skills/dispatch-code-review/README.md) | Alias for `/dispatch review code:` |
| [`implement-dispatch`](skills/implement-dispatch/README.md) | Alias for `/dispatch implement:` |

The four aliases exist for familiar slash commands only; `dispatch` alone does the work.

## Quick start

```text
/dispatch [level] [(pins)] [ask|plan|design|review|implement]: <argument>
```

Levels `low` … `max` buy more targets, rounds, and stronger models. Pins like `(claude,agy)` or `(all)` choose which configured providers answer.

Ask another model a bounded question:

```text
/dispatch: Trace discount stacking in src/domain/pricing.ts
/dispatch (all): Does the cache invalidation flow have a race?
```

Write a plan, then have other models attack it before you spend tokens on code:

```text
/dispatch high (claude,agy) plan: Add webhook idempotency
/dispatch review plan: .scratch/plan/2026-09-22-webhooks.md
```

Review your working tree or a branch range:

```text
/dispatch review code
/dispatch review code --fix
/dispatch review code: main..HEAD
```

> [!NOTE]
> With no range, a dirty tree is reviewed as its uncommitted changes alone — staged, unstaged, and untracked — and your committed branch work is left out. A clean tree falls back to a branch comparison against `origin/HEAD`, else `main` or `master`. Name a range explicitly when you want commits and uncommitted edits reviewed together.

> [!NOTE]
> Reviews are report-only. Add `--fix` to let verified findings be applied.

Run the whole loop — plan, review, approval gate, implementation, code review to consensus:

```text
/dispatch implement: Add CSV export
/dispatch implement --phases from:code-review: .scratch/plan/2026-09-22-csv.md
```

For work too big for one pass, `design:` splits it into increments that implement one at a time:

```text
/dispatch design: Migrate the billing state machine
```

> [!NOTE]
> Nothing is ever committed, pushed, or opened as a PR. Interrupted runs resume from their artifacts in `.scratch/plan/`; logs and traces stay out of your context in OS temp.

## License

MIT © [Gyunikuchan](https://github.com/Gyunikuchan). See [LICENSE](LICENSE).
