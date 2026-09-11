# Dispatch Skills Agent Guide

Building agent skills for delegating work to external coding-agent CLIs and reviewing results. Distributed via GitHub (`npx skills`).

Single source of truth for agent rules (`.claude/CLAUDE.md` symlinks here); edit this file (`.agents/AGENTS.md`).

## Product North Star & Core Pillars

Deliver high-confidence cross-agent delegation and review with minimal token overhead and minimal human babysitting.

- **Claims, Not Verdicts (Review Rigor)**: Delegates report raw claims; orchestrators verify claims against actual code. Evidence over votes: a verified finding is accepted regardless of vote count; an unverified finding is rejected even if unanimous. Axis coverage is explicit and visible.
- **Structural Least Privilege (Security & Isolation)**: Delegate invocations are structurally read-only (`--mode plan`, read-only tools). File writes and destructive actions belong exclusively to the orchestrator or native subagents. Guard every boundary with git status validation (`git status --porcelain`) and sanitize delegate outputs.
- **Context Hygiene & Token Density (Efficiency)**: Protect the orchestrator's context window. Execution traces and subprocess logs stream out-of-context to temp logs (`.scratch/` or OS temp); only concise syntheses, banners, and log paths reach the orchestrator. High token density via progressive disclosure.
- **Autonomous One-Shot Reliability (Rigor & Consensus)**: Checkable completion bounds, deterministic review loops, and structured adjudication converge on clean consensus without requiring user interventions.
- **Host Neutrality & Composability (Portability & Modularity)**: Zero assumptions about the host repository. Delegates read the target workspace's `AGENTS.md` / `CLAUDE.md` and fall back to industry best practices. Skills maintain strict downward independence and install standalone or together. Shared conventions among the review-flow skills (`dispatch`'s `references/alignment.md`) govern only those skills' own behaviour and artifacts; host `AGENTS.md` / `CLAUDE.md` always wins, and skills never write conventions into the host repo.

## Communication

Terse, high-signal: fragments OK, omit filler/hedging, preserve exact terms, code, and units. Standard prose for security warnings, destructive actions, code, docs, commits, and PRs. Use relative repo paths for markdown links (never machine-specific `file:///`). Exception: a chat-only link to an out-of-repo session path (e.g. OS temp directory) is exempt.

## Ask Before You Assume

Clarify requirements, constraints, or trade-offs with multiple viable interpretations before building. State assumptions explicitly; suggest simpler alternatives when available. Triggers:

- Breaking changes to skill interfaces, shared review schemas, or dependency contracts.
- Introducing new external dependencies or runtime prerequisites.
- Suspected user mistake, ambiguous prompt, or contradictory instruction.

Report adjacent findings in output; keep task execution strictly bounded to requested scope.

## Architecture & Dependency Invariants

Skills live in `skills/` with `SKILL.md` (agent contract) and `README.md` (human documentation):

```
skills/dispatch/                 runner + provider cascade; scripts/ and references/
skills/dispatch-plan-review/     plan review criteria and adjudication
skills/dispatch-code-review/     code review criteria and adjudication
skills/implement-dispatch/       control flow: plan → review → implement → review → consensus
```

`npx skills add Gyunikuchan/dispatch-skills --skill <name>` installs one; `--all` installs all.

### Unidirectional Dependency Flow

```
implement-dispatch → dispatch-plan-review, dispatch-code-review, dispatch
dispatch-plan-review, dispatch-code-review → dispatch
dispatch → (nothing)
```

- **Reference by skill name, never by path.**
- **Assume dependencies are installed**: Downstream skills assume upstream dependencies exist and invoke them directly.
- **Upstream skills never name downstream skills** in prose or frontmatter, except `dispatch`'s `references/alignment.md` and the gated "Skill Alignment" pointer section in `dispatch/SKILL.md`, which may name `implement-dispatch`, `dispatch-plan-review`, `dispatch-code-review` — those conventions exist to serve exactly those three skills.
- **Graceful degradation**: State absence of optional dependencies and run the reduced flow.

## Review Report Standards

Review skills share the severity ladder (`MUST-FIX` / `SHOULD-FIX` / `CONSIDER`) and finding grammar:

```
<locus> — <tag>: <defect> → <required change>
```

- `<locus>` is `<file>:L<line>` for code and `## <Section>` for plans.
- Open reports with `## Verdict` and `## Axis Coverage` (explicitly accounting for every axis).
- Adjudication, the resolutions log, and the user report are single-sourced in `dispatch`'s `references/alignment.md`; ladder, grammar, and report skeleton stay inline in both prompt templates, checked by a parity test. Modifying any of them requires updating both review skills simultaneously.

## Authoring & Cross-Platform Standards

Format skills as Markdown with YAML frontmatter (`name`, `description`) following `writing-for-agents`. Prune duplicate meaning, maintain single sources of truth, and phrase instructions positively. Leverage plans and walkthroughs created by Antigravity.

Portable by default across macOS, Windows, and Linux (zsh, bash, PowerShell) and across Antigravity, Claude Code, and Copilot:

- **Naming**: kebab-case for skill identifiers and filenames.
- **Paths**: Relative paths with forward slashes instead of `file://` URIs or absolute paths; use Node `path` utilities in scripts.
- **Line endings**: LF normalized via `.gitattributes`.
- **Shell portability**: Universal shell syntax or Node scripts; fork steps explicitly where agent or shell environments diverge.
- **Scratch directory**: Ephemeral state and run logs belong in `.scratch/`; an orchestrator owning the full lifecycle relocates its scratch artifacts to OS temp on completion, while standalone reviews retain theirs (see `dispatch`'s `references/alignment.md` § Artifact Lifecycle for review-flow artifacts).
- **Docs**: Every skill README must include install and usage examples.

### Comments

Explain non-obvious rationale ("why", CLI/subprocess quirks, cross-platform nuances, architectural decisions) in a single clause. Omit obvious mechanics and type signatures.

- **Structure**: Group long sections with short headers; use `// SECTION:` dividers for major segments and platform/mode branches.
- **Markers**: Use `// NOTE:` for workarounds; preserve active `TODO:` / `FIXME:`.

## Execution & Handoff Contract

Follow **Goal-Driven Execution** (**Discover → Edit → Verify**):

- **Discover**: Check relevant `SKILL.md` or scripts before editing.
- **Edit**: Apply minimal, focused edits preserving existing comments and invariants.
- **Verify**: Run `npm test` (which triggers `scripts/generate-hashes.mjs`) before completing any task.

### Handoff Format

End completed tasks with:

1. **Delivered behaviour** — structural, logic, or documentation change, concisely.
2. **Verification status** — commands executed and test results.
3. **Skill Retrospective / Friction** — actionable friction, ambiguous instructions, or workflow inefficiencies observed during skill execution (omit section if clean). High-confidence improvements should be applied directly to the owning doc or skill.

