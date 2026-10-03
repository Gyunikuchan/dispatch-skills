# Dispatch Skills Agent Guide

Agent skills for cross-agent CLI delegation and review. Single source of truth for repository rules (`.claude/CLAUDE.md` symlinks here; edit this file).

## Product North Star & Core Pillars

The `dispatch` skill should facilitate high-confidence development across native agent harnesses, catching flawed assumptions early and reducing the total cost and time of verified delivery with minimal routine human coordination. These pillars guide development of `dispatch` and its companion aliases.

- **Proportional assurance:** Balance correctness, token efficiency, and speed against task risk and required confidence. Preserve acceptance and safety boundaries; choose the simplest, least costly workflow that satisfies them.
- **Native collaboration:** Preserve each platform's native reasoning loop and permitted tools; standardize routing, evidence, and handoffs.
- **Evidence and intent:** Treat delegate findings as claims. Verify them against governing intent, repository rules, and actual artifacts; use evidence to resolve findings rather than vote counts.
- **Lean context:** Keep always-loaded contracts and initial briefs focused. Disclose detail when needed; retain logs and evidence in artifacts reached by pointer. Prefer deterministic enforcement over recurring prose.
- **Structural least privilege:** Keep provider delegates read-only and native writes explicitly scoped; see `skills/dispatch/references/providers.md`. Independently check submitted changes before acceptance.
- **Recoverable autonomy:** Automate routine progress within approved scope. Preserve work and durable evidence; recover without duplicate effects and escalate unresolved blockers or intent decisions.
- **Simple, portable composition:** Respect host conventions and maintain clear ownership and downward independence. Prefer one coherent execution path over additional coordination machinery. Shared review conventions live in `skills/dispatch/references/review-rules.md`; skills remain standalone or composable without writing conventions into host repositories.

## Communication

Terse, high-signal: fragments OK, omit filler/hedging, preserve exact terms, code, and units. Standard prose for security warnings, destructive actions, code, docs, commits, and PRs. Summarize findings compactly, linking to artifacts or run logs rather than relaying verbose traces or reports in chat.

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
dispatch-implement ─────┤
dispatch-code-review ───┘
```

Repository layout:

```text
skills/dispatch/          model-visible contract, config, scripts, references
skills/*-review/          small user-invoked aliases and human manuals
skills/dispatch-implement/ compatibility alias and human manual
.agents/skills/           repository-development and vendored skills; none shipped
scripts/                  repository tooling
tests/unit/{core,policy,domain,providers,lib,machines}/ runtime-layer unit tests
tests/integration/        layout, dependency, runtime, and skill contracts
tests/tooling/             repository tool tests
tests/e2e/                 Git/subprocess flows
```

- Reference skills by name or sibling-relative `<skills-dir>` paths, never a host-specific installation path.
- Aliases require `dispatch`, map arguments to one verb, and provide a named missing-dependency diagnostic.
- `dispatch` names no alias.
- Shared review behavior lives in `skills/dispatch/references/review-rules.md`.

## Documentation Standards

Classify each document or piece of prose by its primary audience and task. Keep each rule in one canonical home; other documents may explain its audience-specific effect and link to that home.

- **Human documentation**: Help users decide whether and how to use the skills. Include a detail when users need it to choose a skill, set it up, use it correctly, understand its results or limits, or recover from a problem. Explain purpose and concepts plainly, organize around user tasks, and use realistic examples with relevant outcomes and constraints. Treat the root and dispatch READMEs as examples of this style, not required outlines.
- **Agent-facing prose**: Apply these rules to any prose intended for an agent, wherever it appears: contracts, prompts, templates, instructions embedded in scripts, and operational references. Direct agent decisions and actions with explicit triggers, order, boundaries, and checkable completion criteria. Include operational context or rationale when it changes execution. Keep instructions focused and single-sourced; disclose branch-specific detail. Add detail when it materially improves correct execution, naming the behavior, decision, or failure mode it addresses.
- **Maintainer knowledge base** (`docs/`): Preserve long-term context for human and agent maintainers. These records are not operationally required; put operational requirements in `skills/dispatch/references/`.

## Authoring & Cross-Platform Standards

Format skills as Markdown with YAML frontmatter (`name`, `description`). When editing agent-facing prose, wherever it appears, apply `writing-for-agents` and single-source each instruction: reference, or restructure the flow around, its existing home instead of restating it.

Portable across macOS, Windows, and Linux (zsh, bash, PowerShell), with native guidance for Antigravity, Claude Code, GitHub Copilot, OpenCode, and Codex:

- **Cross-Skill Alignment**: Single-source multi-skill conventions and shared schemas in `skills/dispatch/references/review-rules.md`.
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

Follow **Goal-Driven Execution** (**Discover → Bound → Execute → Verify → Handoff**):

- **Discover**: Read relevant `SKILL.md` files or scripts and inspect the current state before editing.
- **Bound**: Set the intended outcome, in-scope paths, and checkable completion criteria from the request or approved plan. Keep planning and review proportional to task risk.
- **Execute**: Apply minimal, focused edits within the agreed scope, preserving existing comments and invariants.
- **Verify**: Run plan Verify commands and `npm test` before completing an edit task. Record evidence for each criterion after the last change; failed or unrun required checks remain open. For focused Node tests, use `node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts [--test-name-pattern="…"] <file>`; with multiple files, require a name-pattern match in each. Inspect hash drift; run `npm run hashes` only when intended edits changed hashed skill files, then rerun `npm test`. Require Node `^22.18 || >=23.6`.
  - Test behavior at each layer through its public entrypoint: protocol tests cover frames, events, and rendered sections; pure machine tests cover state and effect transitions. Keep one behavior per test and name it for that behavior. Put real Git/subprocess flows in `tests/e2e/`.
- **Handoff**: Use the format below.

### Long-running commands and delegates

Start each command or delegate once and retain its handle. Wait event-driven for completion, material blockers, or user input, with a 30-minute fallback. Ask delegates to report only completion or material blockers; continue through routine progress without status requests or narration. When an API caps waits, use its longest event-capable wait and reuse the handle.

### Handoff Format

End completed tasks with:

1. **Delivered behaviour** — structural, logic, or documentation change, concisely.
2. **Verification status** — commands executed and test results; include evidence for each completion criterion and identify failed or unrun required checks.
3. **Remaining concerns and artifacts** — unresolved decisions or blockers, with paths/links to useful artifacts.
4. **Suggested commit message** — concise Conventional Commits style summary (`type(scope): summary`), optionally with bulleted body for non-trivial changes.
