# Dispatch Skills Agent Guide

Agent skills for cross-agent CLI delegation and review. Single source of truth for repository rules (`.claude/CLAUDE.md` symlinks here; edit this file).

## Product North Star & Core Pillars

Deliver high-confidence collaborative development workflows across native agent harnesses, catching flawed assumptions before they become code — with minimal token overhead and zero human babysitting.

- **Trade-offs (Correctness > Token Efficiency > Speed)**: Prioritize correctness over token efficiency over execution speed. Spend tokens verifying claims rather than guessing; optimize context hygiene and token density before raw speed.
- **Native Harness Collaboration:** Preserve each platform's native reasoning loop and permitted tools; standardize routing, evidence, and handoffs between them.
- **Low steady-state load:** Keep always-loaded contracts lean: prefer deterministic scripts and disclosed references over recurring prose; have scripts emit mode- or state-specific instructions at the branch point rather than documenting every branch up front; add behavioral rules when evidence shows they change outcomes.
- **Claims, Not Verdicts**: Delegates report raw claims; orchestrators verify claims against actual code. Evidence over votes: accept verified findings regardless of delegate count; reject unverified findings even if unanimous.
- **Structural Least Privilege**: Delegate invocations are structurally read-only (read-only flags and tools; see `skills/dispatch/references/providers.md`). Reserve file writes and destructive actions exclusively for orchestrators or native subagents. Runner harnesses sanitize outputs.
- **Context Hygiene & Token Density**: Stream execution traces and subprocess logs out-of-context to OS temp. Pass concise syntheses, banners, and log paths to orchestrators; record full findings into artifacts. Progressive disclosure protects context windows.
- **Autonomous One-Shot Reliability**: Checkable completion bounds, deterministic review loops, and structured adjudication converge on clean consensus without human intervention.
- **Host Neutrality & Composability**: Make zero assumptions about the host repository. Delegates read workspace rules and fall back to industry best practices. Skills maintain strict downward independence and work standalone or composed. Shared conventions (`skills/dispatch/references/review.md`) govern only review flows; host conventions always win, and skills never write conventions into host repos.

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

`dispatch` owns every shipped runner, driver, template, schema, config, and operational reference. The four companion skills are user-invoked compatibility aliases:

```text
dispatch-plan-review ─┐
dispatch-code-review ─┼─> dispatch ─> nothing
dispatch-design-review┤
dispatch-implement ───┘
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
  - **Dispatch documentation (`skills/dispatch/README.md` and its disclosed references)**: Purpose, concepts, prerequisites, realistic invocations, configuration, troubleshooting; write human guidance for users and cover referenced paths with path-convention guards.
- **Agent contracts** (`skills/*/SKILL.md`, `AGENTS.md`, `CLAUDE.md`, operational `references/*.md` outside `references/readme/`): Include only operational context, decision paths, and checkable completion bounds. Keep word count net-neutral or lower; expand only after exhausting rewording, leading words, and disclosure.
- **Maintainer notes** (`docs/<skill>-notes.md`): Record implementation context that users and executing agents do not need; these files are not shipped.

## Authoring & Cross-Platform Standards

Format skills as Markdown with YAML frontmatter (`name`, `description`). When touching agent-read prose (agent contracts or prompt/instruction strings in code), always apply `writing-for-agents` and single-source each instruction: reference, or restructure the flow around, its existing home instead of restating it.

Portable across macOS, Windows, Linux (zsh, bash, PowerShell) and Antigravity, Claude Code, Copilot, OpenCode:

- **Cross-Skill Alignment**: Single-source multi-skill conventions and shared schemas in `skills/dispatch/references/review.md`.
- **Naming**: kebab-case for skill identifiers, filenames, and slugs.
- **Paths**: Forward-slash relative paths instead of `file://` URIs or absolute paths; use Node `path` utilities in scripts.
- **Shell portability**: Universal shell syntax or Node scripts; fork steps explicitly where environments diverge.
- **Type checking**: Start every `skills/` and `scripts/` `.mjs` file with `// @ts-check`; type exported functions and destructured options with JSDoc. `npm test` runs `tsc` (`checkJs`, non-strict) first.
- **Scratch directory allowlist**: Only active plan files (`.scratch/plan/<yyyy-mm-dd>-<slug>.md`), walkthrough files (`.scratch/plan/<yyyy-mm-dd>-<slug>-walkthrough.md`), technical designs (`.scratch/plan/<yyyy-mm-dd>-<slug>-design.md`), increment implementation plans (`.scratch/plan/<yyyy-mm-dd>-<design-slug>-i<nn>-<increment-slug>-plan.md`), increment walkthroughs (matching `-walkthrough.md` shape), integration walkthroughs (`.scratch/plan/<yyyy-mm-dd>-<design-slug>-integration-walkthrough.md`), hidden design staging files (`.scratch/plan/.<design-file>.bak`/`.tmp`/`.status.tmp`), audit reports (`.scratch/audits/<run>-audit.md`), and in-flight audit working directories (`.scratch/audits/<run>-work/`) belong in `.scratch/`. All other data (subprocess logs, traces, filled prompts `*-review-prompt*.md`, probe captures, ephemeral run files) belongs in OS temp, inside the run's session directory (`<os.tmpdir()>/dispatch-skills-<user>/sessions/<id>/`); only durable cross-session stores (ledgers, relocated artifacts, telemetry, locks) sit beside it under `dispatch-skills-<user>/`. Orchestrators relocate working scratch artifacts to OS temp on completion; design-run artifacts relocate together only after final integration; standalone reviews retain plans/walkthroughs in place (see `skills/dispatch/references/review.md` § Wave and artifact lifecycle). Note: `.scratch/` is not git-ignored; do not stage scratch files into git commits.

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
