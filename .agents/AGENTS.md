# Dispatch Skills Agent Guide

Agent skills for delegating work to external coding-agent CLIs and reviewing results. Single source of truth for agent rules (`.claude/CLAUDE.md` symlinks here; edit this file).

## Product North Star & Core Pillars

Deliver high-confidence cross-agent delegation and review with minimal token overhead and zero human babysitting.

- **Trade-offs (Correctness > Token Efficiency > Speed)**: Spend tokens to verify code rather than guess or skip; never sacrifice correctness for efficiency. Optimize context hygiene and token density before raw execution speed.
- **Claims, Not Verdicts**: Delegates report raw claims; orchestrators verify claims against actual code. Evidence over votes: accept verified findings regardless of vote count; reject unverified findings even if unanimous. Axis coverage is explicit and visible.
- **Structural Least Privilege**: Delegate invocations are structurally read-only (`--mode plan`, read-only tools), except OpenCode off Linux (accepted risk; see `skills/dispatch/references/providers.md`). Reserve file writes and destructive actions exclusively for the orchestrator or native subagents. Guard every boundary with git status validation (`git status --porcelain`) and sanitize delegate outputs.
- **Context Hygiene & Token Density**: Protect the orchestrator's context window. Stream execution traces and subprocess logs out-of-context to temp logs (`.scratch/` or OS temp); pass only concise syntheses, banners, and log paths to the orchestrator. High token density via progressive disclosure.
- **Autonomous One-Shot Reliability**: Checkable completion bounds, deterministic review loops, and structured adjudication converge on clean consensus without user intervention.
- **Host Neutrality & Composability**: Make zero assumptions about the host repository. Delegates read workspace `AGENTS.md` / `CLAUDE.md` and fall back to industry best practices. Skills maintain strict downward independence and work standalone or together. Shared conventions (`skills/dispatch/references/alignment.md`) govern only review-flow skills; host conventions always win, and skills never write conventions into the host repo.

## Communication

Terse, high-signal: fragments OK, omit filler/hedging, preserve exact terms, code, and units. Standard prose for security warnings, destructive actions, code, docs, commits, and PRs.

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
.agents/skills/                  repo-development skills (audit-dispatch-skills, -fix), vendored
                                 skills (tracked in skills-lock.json), and symlinks to skills/; none shipped
scripts/                         repo tooling (hash generation, config validation)
tests/                           mirrors the tree under test: tests/skills/<skill>/, tests/scripts/,
                                 tests/integration/ for cross-skill invariants
```

### Unidirectional Dependency Flow

```
implement-dispatch → dispatch-plan-review, dispatch-code-review, dispatch
dispatch-plan-review, dispatch-code-review → dispatch
dispatch → (nothing)
```

- **Name the skill, not its install path.** Refer to another skill by name; a sibling file inside the same `<skills-dir>` may be linked relatively (as `implement-dispatch` links the review skills' templates, keeping them single-source). Host-specific install paths (`.claude/skills/`, `.agents/skills/`, `.github/skills/`, `.opencode/skill/`) and absolute paths never appear in skill markdown — they break the moment the skill is installed to a different host.
- **Assume dependencies are installed**: Downstream skills assume upstream dependencies exist and invoke them directly.
- **Upstream skills never name downstream skills** in prose or frontmatter, except `skills/dispatch/references/alignment.md` and the gated "Skill Alignment" pointer section in `skills/dispatch/SKILL.md` (which serve `implement-dispatch`, `dispatch-plan-review`, `dispatch-code-review`).
- **Graceful degradation**: State absence of optional dependencies and run the reduced flow.

## Documentation Standards

Differentiate human documentation, agent execution contracts, and non-operational background notes:

- **Human Documentation (`README.md`, `skills/*/README.md`)**: Optimized for human developers. Filter: *Is this something the human user of the skill needs to know?*
  - **Root `README.md`**: Core value proposition (2–3 sentences), quick install (`npx skills add ...`), skills catalog table, quick start prompt examples, and architecture highlights.
  - **Skill Manuals (`skills/*/README.md`)**: Purpose and core concepts, prerequisites/installation, realistic invocation examples (slash commands / prompt templates), configuration, and CLI quirks/troubleshooting.
- **Agent Contracts (`skills/*/SKILL.md`, operational `references/*.md`)**: Governed by `writing-for-agents`. Focus exclusively on operational context, decision paths, and checkable execution bounds.
- **Non-Operational Notes (`skills/*/references/notes.md`)**: Holding area for architectural rationale, background decisions, or maintainer context neither needed by human end-users nor required for agent runtime execution.

## Authoring & Cross-Platform Standards

Format skills as Markdown with YAML frontmatter (`name`, `description`). Apply `writing-for-agents` when editing Markdown documents (`.agents/AGENTS.md`, `SKILL.md`, reference docs).

Portable by default across macOS, Windows, and Linux (zsh, bash, PowerShell) and across Antigravity, Claude Code, Copilot, and OpenCode:

- **Cross-Skill Alignment & Shared Conventions**: Single-source multi-skill conventions and shared review schemas in `skills/dispatch/references/alignment.md`. Ensure alignment, downward independence, and compatibility across standalone and orchestrated invocations.
- **Naming**: kebab-case for skill identifiers and filenames.
- **Paths**: Forward-slash relative paths instead of `file://` URIs or absolute paths; use Node `path` utilities in scripts.
- **Shell portability**: Universal shell syntax or Node scripts; fork steps explicitly where agent or shell environments diverge.
- **Scratch directory**: Ephemeral state and run logs belong in `.scratch/`. Orchestrators owning the full lifecycle relocate scratch artifacts to OS temp on completion; standalone reviews retain theirs (see `skills/dispatch/references/alignment.md` § Artifact Lifecycle). Note: `.scratch/` is intentionally not git-ignored; review `git status` before committing.

### Comments

Explain non-obvious rationale ("why", CLI/subprocess quirks, cross-platform nuances, architectural decisions) in a single clause. Omit obvious mechanics and type signatures.

- **Structure**: Group long sections with short headers; use `// SECTION:` dividers for major segments and platform/mode branches.
- **Markers**: Use `// NOTE:` for workarounds; preserve active `TODO:` / `FIXME:`.

## Execution & Handoff Contract

Follow **Goal-Driven Execution** (**Discover → Edit → Verify**):

- **Discover**: Check relevant `SKILL.md` or scripts before editing.
- **Edit**: Apply minimal, focused edits preserving existing comments and invariants.
- **Verify**: Run `npm test` before completing any edit task; when it reports hash drift, run `npm run hashes`. Dev/test tooling needs Node 22+ (the quoted test glob); skill runtime stays Node 18+.

### Handoff Format

End completed tasks with:

1. **Delivered behaviour** — structural, logic, or documentation change, concisely.
2. **Verification status** — commands executed and test results.
3. **Skill Retrospective / Friction** — actionable friction, ambiguous instructions, or workflow inefficiencies observed during skill execution (omit section if clean). High-confidence improvements should be applied directly to the owning doc or skill.
4. **Suggested commit message** — concise Conventional Commits style summary (`type(scope): summary`), optionally with bulleted body for non-trivial changes.

