# Dispatch Skills Agent Guide

Four agent skills for delegating work to other coding-agent CLIs and reviewing the results. Distributed through GitHub — `npx skills` is the registry, so there is no build and no publish step.

Single source of truth for agent rules (`.claude/CLAUDE.md` symlinks here); edit this file (`.agents/AGENTS.md`).

## Communication

Terse, high-signal: fragments OK, omit filler/hedging, preserve exact terms, code, and units. Standard prose for security warnings, destructive actions, code, docs, commits, and PRs.

## Layout

Each skill is a top-level directory holding a `SKILL.md` (the agent-facing contract) and a `README.md` (for humans):

```
dispatch/                 runner + provider cascade; scripts/ and references/
dispatch-plan-review/     plan review criteria and adjudication
dispatch-code-review/     code review criteria and adjudication
implement-dispatch/       control flow: plan → review → implement → review → consensus
```

`npx skills add Gyunikuchan/dispatch-skills --skill <name>` installs one; `--all` installs every skill.

## Independence

The dependency arrow points one way and never back:

```
implement-dispatch → dispatch-plan-review, dispatch-code-review, dispatch
dispatch-plan-review, dispatch-code-review → dispatch
dispatch → (nothing)
```

- **Reference by skill name, never by path.** Skills install to different locations per agent; a relative path is a broken link waiting to happen.
- **A downstream skill never names an upstream one** — not in prose, not in its `description`. `dispatch-code-review` must read as a standalone review skill to an agent that has never heard of `implement-dispatch`.
- **Optional dependencies degrade.** When an optional skill is absent, the caller says so and runs the reduced flow.

## Host neutrality

These skills ship no opinions about any particular codebase. Delegates read the host repository's `AGENTS.md` / `CLAUDE.md` directly from the workspace and fall back to industry best practices when none is present. A rule about someone else's repo hardcoded into a template is a defect.

## Review report format

Both review skills share a severity ladder (`MUST-FIX` / `SHOULD-FIX` / `CONSIDER`), an adjudication table (`Accept` / `Reject` / `Downgrade` / `Disputed`), and one finding grammar:

```
<locus> — <tag>: <defect> → <required change>
```

`<locus>` is `<file>:L<line>` for code and `## <Section>` for a plan. Both reports open with `## Verdict` and `## Axis Coverage`; coverage lists every axis so a skipped axis is visible rather than indistinguishable from a clean one.

Changing the ladder, the grammar, or the adjudication table means changing both skills in the same commit.

## Authoring

Skills are Markdown with YAML frontmatter (`name`, `description`), written per the `writing-for-agents` skill in `.agents/skills/`. Prune duplicated meaning, keep each rule in one owning file, and prefer positive instructions over prohibitions.

## Code Standards

- **Runtime**: Node >= 24, no dependencies. `dispatch/scripts/*.mjs` only.
- **Naming**: skill identifiers and filenames kebab-case.
- **Paths**: forward slashes and Node `path` utilities; nothing platform-specific.
- **Docs**: every skill README carries install and usage examples.

## Cross-platform

Skills run on macOS, Windows, and Linux under zsh, bash, or PowerShell, and are consumed by Antigravity, Claude Code, and Copilot. Portable by default:

- Shell syntax in skill prose must work in all three shells, or be agent-invoked Node instead.
- Path separators: Node `path` utilities only; never hardcoded `/` or `\`.
- Line endings: LF in source; `.gitattributes` enforces this.
- Agent-facing text uses no shell- or host-specific idioms. When a step differs by shell or agent, fork it explicitly rather than assuming one environment.
