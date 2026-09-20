# Dispatch Skills Agent Guide

Agent skills for cross-agent CLI delegation and review. Single source of truth for repository rules (`.claude/CLAUDE.md` symlinks here; edit this file).

## Product North Star & Core Pillars

Deliver high-confidence cross-agent delegation and review with minimal token overhead and zero human babysitting.

- **Trade-offs (Correctness > Token Efficiency > Speed)**: Prioritize correctness over token efficiency over execution speed. Spend tokens verifying claims rather than guessing; optimize context hygiene and token density before raw speed.
- **Low steady-state load:** Keep always-loaded contracts lean: prefer deterministic scripts and disclosed references over recurring prose; add behavioral rules when evidence shows they change outcomes.
- **Claims, Not Verdicts**: Delegates report raw claims; orchestrators verify claims against actual code. Evidence over votes: accept verified findings regardless of delegate count; reject unverified findings even if unanimous.
- **Structural Least Privilege**: Delegate invocations are structurally read-only (read-only flags and tools; see `skills/dispatch/references/providers.md`). Reserve file writes and destructive actions exclusively for orchestrators or native subagents. Runner harnesses sanitize outputs.
- **Context Hygiene & Token Density**: Stream execution traces and subprocess logs out-of-context to OS temp. Pass concise syntheses, banners, and log paths to orchestrators; record full findings into artifacts. Progressive disclosure protects context windows.
- **Autonomous One-Shot Reliability**: Checkable completion bounds, deterministic review loops, and structured adjudication converge on clean consensus without human intervention.
- **Host Neutrality & Composability**: Make zero assumptions about the host repository. Delegates read workspace rules and fall back to industry best practices. Skills maintain strict downward independence and work standalone or composed. Shared conventions (`skills/dispatch/references/alignment.md`) govern only review flows; host conventions always win, and skills never write conventions into host repos.

## Communication

Terse, high-signal: fragments OK, omit filler/hedging, preserve exact terms, code, and units. Standard prose for security warnings, destructive actions, code, docs, commits, and PRs. Summarize findings compactly and link to artifacts/temp logs instead of relaying verbose traces or verbatim reports in chat.

## Ask Before You Assume

Clarify requirements, constraints, or trade-offs with multiple viable interpretations before building. State assumptions explicitly; suggest simpler alternatives when available.

**Escalation triggers**:
- Breaking changes to skill interfaces, shared review schemas, or dependency contracts.
- Introducing new external dependencies or runtime prerequisites.
- Suspected user mistake, ambiguous prompt, or contradictory instruction.

Report adjacent findings in output; keep execution strictly bounded to requested scope.

## Architecture & Dependency Invariants

Skills live in `skills/` with `SKILL.md` (agent contract) and `README.md` (human documentation):

```
skills/dispatch/                 runner + provider cascade; scripts/ and references/
skills/dispatch-design-review/   technical-design review criteria and adjudication
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
implement-dispatch → dispatch-design-review, dispatch-plan-review, dispatch-code-review, dispatch
dispatch-design-review, dispatch-plan-review, dispatch-code-review → dispatch
dispatch → (nothing)
```

- **Name the skill, not its install path**: Reference skills by name or sibling-relative paths (`<skills-dir>`). Never use host-specific install paths (`.claude/skills/`, `.agents/skills/`, `.github/skills/`, `.opencode/skill/`) or absolute paths in operational skill markdown or script invocations (discovery tables documenting standard installation locations are permitted).
- **Assume dependencies are installed**: Downstream skills assume upstream dependencies exist and invoke them directly.
- **Upstream skills never name downstream skills** in prose or frontmatter (gated exceptions: `skills/dispatch/references/alignment.md` and `skills/dispatch/SKILL.md` § Skill Alignment).
- **Graceful degradation**: State absence of optional dependencies and run the reduced flow.

## Documentation Standards

Differentiate human documentation, agent execution contracts, and maintainer notes:

- **Human Documentation (`README.md`, `skills/*/README.md`)**: Optimized for human users (*Is this something the user needs to know?*).
  - **Root `README.md`**: Core value proposition (2–3 sentences), install command (`npx skills add ...`), catalog table, quick-start prompts, architecture overview.
  - **Skill Manuals (`skills/*/README.md`)**: Purpose, concepts, prerequisites, realistic invocation examples, configuration, and troubleshooting.
- **Agent Contracts (`skills/*/SKILL.md`, operational `references/*.md`)**: Governed by `writing-for-agents`. Focus strictly on operational context, decision paths, and checkable execution bounds. Hold word count net-neutral or lower; grow it only when the task requires it, reaching first for rewording, leading words, or disclosure. Maintainer notes belong in `docs/<skill>-notes.md` (not shipped).

## Authoring & Cross-Platform Standards

Format skills as Markdown with YAML frontmatter (`name`, `description`). Apply `writing-for-agents` when editing Markdown documents (`.agents/AGENTS.md`, `SKILL.md`, reference docs).

Portable across macOS, Windows, Linux (zsh, bash, PowerShell) and Antigravity, Claude Code, Copilot, OpenCode:

- **Cross-Skill Alignment**: Single-source multi-skill conventions and shared schemas in `skills/dispatch/references/alignment.md`.
- **Naming**: kebab-case for skill identifiers, filenames, and slugs.
- **Paths**: Forward-slash relative paths instead of `file://` URIs or absolute paths; use Node `path` utilities in scripts.
- **Shell portability**: Universal shell syntax or Node scripts; fork steps explicitly where environments diverge.
- **Scratch directory allowlist**: Only active plan files (`.scratch/plan/<yyyy-mm-dd>-<slug>.md`), walkthrough files (`.scratch/plan/<yyyy-mm-dd>-<slug>-walkthrough.md`), audit reports (`.scratch/audits/<run>-audit.md`), and in-flight audit working directories (`.scratch/audits/<run>-work/`) belong in `.scratch/`. All other data (subprocess logs, traces, filled prompts `*-review-prompt*.md`, probe captures, ephemeral run files) belongs in OS temp (`os.tmpdir()`). Orchestrators relocate working scratch artifacts to OS temp on completion; standalone reviews retain plans/walkthroughs in place (see `skills/dispatch/references/alignment.md` § Wave and lifecycle). Note: `.scratch/` is not git-ignored; do not stage scratch files into git commits.

### Comments

Explain non-obvious rationale ("why", CLI/subprocess quirks, cross-platform nuances, architectural decisions) in a single clause. Omit obvious mechanics and type signatures.

- **Structure**: Group long sections with short headers; use `// SECTION:` dividers for major segments or platform/mode branches.
- **Markers**: Use `// NOTE:` for workarounds; preserve active `TODO:` / `FIXME:`.

## Execution & Handoff Contract

Follow **Goal-Driven Execution** (**Discover → Edit → Verify**):

- **Discover**: Check relevant `SKILL.md` or scripts before editing.
- **Edit**: Apply minimal, focused edits preserving existing comments and invariants.
- **Verify**: Run `npm test` before completing any edit task; when it reports hash drift, run `npm run hashes`. Shipped skills and development tooling require Node 22+.

### Handoff Format

End completed tasks with:

1. **Delivered behaviour** — structural, logic, or documentation change, concisely.
2. **Verification status** — commands executed and test results.
3. **Skill Retrospective / Friction** — actionable friction, ambiguous instructions, workflow inefficiencies, or token hotspots / refactoring opportunities with proposed solutions (omit section if clean). Apply high-confidence improvements directly to the owning doc or skill.
4. **Suggested commit message** — concise Conventional Commits style summary (`type(scope): summary`), optionally with bulleted body for non-trivial changes.
