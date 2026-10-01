# Dispatch Skills Agent Guide

Agent skills for cross-agent CLI delegation and review. Single source of truth for repository rules (`.claude/CLAUDE.md` symlinks here; edit this file).

## Product North Star & Core Pillars

Deliver high-confidence collaborative development workflows across native agent harnesses, catching flawed assumptions before they become code — with minimal token overhead and zero human babysitting.

- **Trade-offs (Correctness > Token Efficiency > Speed)**: Prioritize correctness over token efficiency over execution speed. Verify claims instead of guessing; optimize context hygiene and token density before speed.
- **Native Harness Collaboration:** Preserve each platform's native reasoning loop and permitted tools; standardize routing, evidence, and handoffs between them.
- **Low steady-state load:** Keep always-loaded contracts lean: prefer deterministic scripts and disclosed references over recurring prose; emit mode- or state-specific instructions at branch points rather than documenting every branch up front; add behavioral rules when evidence shows they change outcomes.
- **Claims, Not Verdicts**: Delegates report raw claims; orchestrators verify claims against actual code. Evidence over votes: accept verified findings regardless of delegate count; reject unverified findings even if unanimous.
- **Structural Least Privilege**: Delegate invocations are structurally read-only (read-only flags and tools; see `skills/dispatch/references/providers.md`). Reserve file writes and destructive actions for orchestrators or native subagents; Runner harnesses sanitize outputs.
- **Context Hygiene & Token Density**: Stream execution traces and logs out-of-context to OS temp. Pass concise syntheses, banners, and log paths to orchestrators; record findings into artifacts. Progressive disclosure protects context.
- **Autonomous One-Shot Reliability**: Checkable completion bounds, deterministic review loops, and structured adjudication converge on clean consensus without human intervention.
- **Host Neutrality & Composability**: Make zero assumptions about the host repository. Delegates read workspace rules, falling back to industry best practices. Skills maintain strict downward independence and work standalone or composed. Shared conventions (`skills/dispatch/references/review.md`) govern only review flows; host conventions always win, and skills never write conventions into host repos.

## Communication

Terse, high-signal: fragments OK, omit filler/hedging, preserve exact terms, code, and units. Standard prose for security warnings, destructive actions, code, docs, commits, and PRs. Summarize findings compactly, linking to artifacts/temp logs rather than relaying verbose traces or reports in chat.

## Ask Before You Assume

Clarify requirements, constraints, or trade-offs with multiple viable interpretations before building. State assumptions explicitly; suggest simpler alternatives when available.
For backward-incompatible changes, choose the simpler current behavior and drop legacy support by default; preserve compatibility only when instructed.

**Escalation triggers**:
- Introducing new external dependencies or runtime prerequisites.
- Suspected user mistake, ambiguous prompt, or contradictory instruction.

Report adjacent findings in output; keep execution strictly bounded to requested scope.

## Architecture & Dependency Invariants

`dispatch` owns every shipped runner, driver, template, schema, config, and operational reference. The four companion skills are user-invoked compatibility aliases:

```text
dispatch-design-review ─┐
dispatch-plan-review ───┼─> dispatch ─> nothing
dispatch-implement ────┤
dispatch-code-review ───┘
```

Repository layout:

```text
skills/dispatch/          model-visible contract, config, scripts, references
skills/*-review/          small user-invoked aliases and human manuals
skills/dispatch-implement/ compatibility alias and human manual
.agents/skills/           repository-development and vendored skills; none shipped
scripts/                  repository tooling
tests/                    mirrors source plus cross-skill integration guards
```

- Reference skills by name or sibling-relative `<skills-dir>` paths, never a host-specific installation path.
- Aliases require `dispatch`, map arguments to one verb, and provide a named missing-dependency diagnostic.
- `dispatch` names no alias.
- Shared review behavior lives in `skills/dispatch/references/review.md`.

## Documentation Standards

Classify each document by audience; keep each fact in one class:

- **Human documentation**: Help users understand and operate the skills.
  - **Root `README.md`**: Core value proposition (2–3 sentences), install command (`npx skills add ...`), catalog table, quick-start prompts, architecture overview.
  - **Dispatch documentation (`skills/dispatch/README.md` and disclosed references)**: Purpose, concepts, prerequisites, invocations, configuration, troubleshooting; cover referenced paths with path-convention guards.
- **Agent contracts** (`skills/*/SKILL.md`, `AGENTS.md`, `CLAUDE.md`, operational `references/*.md` outside `references/readme/`): Include only operational context, decision paths, and checkable completion bounds. Keep word count net-neutral or lower; expand only after exhausting rewording, leading words, and disclosure.
- **Maintainer notes** (`docs/<skill>-notes.md`): Record implementation context that users and executing agents do not need; these files are not shipped.

## Authoring & Cross-Platform Standards

Format skills as Markdown with YAML frontmatter (`name`, `description`). When touching agent-read prose (agent contracts or prompt/instruction strings in code), always apply `writing-for-agents` and single-source each instruction: reference, or restructure the flow around, its existing home instead of restating it.

Portable across macOS, Windows, Linux (zsh, bash, PowerShell) and Antigravity, Claude Code, Copilot, OpenCode:

- **Cross-Skill Alignment**: Single-source multi-skill conventions and shared schemas in `skills/dispatch/references/review.md`.
- **Naming**: kebab-case for skill identifiers, filenames, and slugs.
- **Paths**: Forward-slash relative paths instead of `file://` URIs or absolute paths; use Node `path` utilities in scripts.
- **Shell portability**: Universal shell syntax or Node scripts; fork steps explicitly where environments diverge.
- **Type checking**: Use native `.ts` with erasable syntax and `.ts` relative imports. `npm test` runs strict `tsc --noEmit` first.
- **Scratch**: Do not commit files under `.scratch/` unless explicitly instructed.

### Comments

Explain non-obvious rationale ("why", CLI/subprocess quirks, cross-platform nuances, architectural decisions) in a single clause. Omit obvious mechanics and type signatures.

- **Structure**: Group long sections with short headers; use `// SECTION:` dividers for major segments or platform/mode branches.
- **Markers**: Use `// NOTE:` for workarounds; preserve active `TODO:` / `FIXME:`.

## Execution & Handoff Contract

Follow **Goal-Driven Execution** (**Discover → Edit → Verify**):

- **Discover**: Check relevant `SKILL.md` or scripts before editing.
- **Edit**: Apply minimal, focused edits preserving existing comments and invariants.
- **Verify**: Run tests, including plan Verify commands, as `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts [--test-name-pattern="…"] <file>`; filtered commands with multiple files require a match in every file. Run `npm test` before completing any edit task; when it reports hash drift, run `npm run hashes`. Require Node `^22.18 || >=23.6`. Tests assert observable protocol (frames, events, rendered sections), never internal state or private helpers; one behavior per test, named for it. Git or subprocess tests belong in `tests/e2e/`.

### Long-running commands and delegates

Start each command or delegate once and retain its handle. Use an event-driven wait with a 30-minute fallback timeout, waking for completion, blockers, or user input. Ask delegates to report only completion or material blockers; continue waiting through routine progress without status requests or narration. When an API caps waits, use its longest event-capable wait and reuse the handle.

### Handoff Format

End completed tasks with:

1. **Delivered behaviour** — structural, logic, or documentation change, concisely.
2. **Verification status** — commands executed and test results.
3. **Skill Retrospective / Friction** — actionable friction, ambiguous instructions, workflow inefficiencies, or token hotspots / refactoring opportunities with proposed solutions (omit section if clean). Apply high-confidence improvements directly to the owning doc or skill.
4. **Suggested commit message** — concise Conventional Commits style summary (`type(scope): summary`), optionally with bulleted body for non-trivial changes.
