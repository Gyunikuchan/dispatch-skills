# Dispatch Skills Agent Guide

Repository-wide instructions for work in this checkout. `.claude/CLAUDE.md` symlinks here; edit this canonical file.

## Product Objective and Principles

The `dispatch` skill should support high-confidence development across native agent harnesses: catch flawed assumptions early and reduce the cost and time of verified delivery while minimizing routine human coordination. Use these principles to guide changes to `dispatch` and its compatibility aliases:

- **Proportional assurance:** Balance correctness, token efficiency, and speed against task risk and required confidence. Preserve acceptance and safety boundaries; choose the simplest, least costly workflow that meets them.
- **Native collaboration:** Preserve each platform's native reasoning loop and permitted tools while standardizing routing, evidence, and handoffs.
- **Evidence and intent:** Treat delegate findings as claims. Check them against governing intent, repository rules, and actual artifacts; resolve findings with evidence rather than vote counts.
- **Lean context:** Keep always-loaded contracts and initial briefs focused. Disclose detail when needed, retain logs and evidence in linked artifacts, and prefer deterministic enforcement over recurring prose.
- **Informed handoffs:** At each handoff to or from an agent, provide the objective, relevant decisions and rationale, constraints, current state, next action, and evidence the recipient needs to act or review. Link to supporting artifacts for detail.
- **Structural least privilege:** Keep provider delegates read-only and scope native writes explicitly. See `skills/dispatch/references/providers.md`; independently check submitted changes before acceptance.
- **Recoverable autonomy:** Automate routine progress within approved scope. Preserve work and durable evidence, recover without duplicate effects, and escalate unresolved blockers or intent decisions.
- **Simple, portable composition:** Respect host conventions and maintain clear ownership between layers. Keep `dispatch` independent of its aliases; prefer one coherent execution path over added coordination machinery. Keep skills standalone or composable without writing conventions into host repositories.

## Communication

Be terse and high-signal; omit filler and hedging, and preserve exact terms, code, and units. Use complete prose for security warnings, destructive-action guidance, documentation, commits, and PRs. Link to artifacts or run logs rather than copying long traces.

## Clarify Material Ambiguity

Ask when unresolved requirements, constraints, or trade-offs could change scope, behavior, or risk. Continue independent work that does not depend on the answer; otherwise state a reasonable assumption and proceed. Suggest simpler alternatives when they meet the goal.

For backward-incompatible changes, choose the simpler current behavior and drop legacy support by default; preserve compatibility only when instructed.

Escalate before implementation when a change would add an external dependency or runtime prerequisite, or when a suspected user mistake or contradiction could change the outcome. Report adjacent findings while keeping execution within the requested scope.

## Repository Change Workflow

For code and documentation changes, follow **Discover → Bound → Execute → Verify → Handoff**:

- **Discover:** Read relevant `SKILL.md` files or scripts and inspect the current state before editing.
- **Bound:** Set the intended outcome, in-scope paths, and checkable completion criteria from the request or approved plan. Keep planning and review proportional to task risk.
- **Execute:** Apply minimal, focused edits within scope, preserving existing comments and invariants.
- **Verify:** Run plan Verify commands and `npm test` before completing an edit task. Record evidence for each criterion after the last change; failed or unrun required checks remain open.
- **Handoff:** Use the task-appropriate format below.

## Product Architecture and Key Areas

`dispatch` owns every shipped runner, driver, template, schema, config, and operational reference. The four companion skills are user-invoked compatibility aliases:

```text
dispatch-design-review ─┐
dispatch-plan-review ───┼──> dispatch
dispatch-implement ─────┤
dispatch-code-review ───┘

dispatch has no dependency on these aliases.
```

Key areas:

```text
skills/dispatch/          model-visible contract, config, scripts, references
skills/*-review/          small user-invoked aliases and human manuals
skills/dispatch-implement/ compatibility alias and human manual
.agents/skills/           local-only and vendored agent skills; none shipped
docs/                     long-term human and agent maintainer context
scripts/                  repository tooling
tests/unit/{core,policy,domain,providers,lib,machines}/ unit tests
tests/integration/        layout, dependency, runtime, and skill contracts
tests/tooling/             repository tool tests
tests/e2e/                 Git/subprocess flows
```

- Reference skills by name or sibling-relative `<skills-dir>` paths, never a host-specific installation path.
- Aliases require `dispatch`, map arguments to one verb, and provide a named missing-dependency diagnostic.
- `dispatch` names no alias.
- Shared cross-skill review conventions live in `skills/dispatch/references/review-rules.md`.

## Documentation Standards

Classify each document or piece of prose by its primary audience and task. Keep each rule in one canonical home; other documents may explain its audience-specific effect and link to that home.

- **Human documentation:** Help users decide whether and how to use the skills. Include details they need to choose a skill, set it up, use it correctly, understand its results or limits, or recover from a problem. Explain concepts plainly, organize around user tasks, and use realistic examples with relevant outcomes and constraints.
- **Agent-facing prose:** Apply these rules to contracts, prompts, templates, instructions embedded in scripts, and operational references. Direct decisions and actions with explicit triggers, order, boundaries, and checkable completion criteria. Include rationale when it changes execution; keep instructions focused and single-sourced; disclose branch-specific detail. Add detail when it materially improves correct execution, naming the behavior, decision, or failure mode it addresses. When editing agent-facing prose, apply `writing-for-agents` and reference existing rules instead of restating them.
- **Maintainer knowledge base (`docs/`):** Preserve long-term context for human and agent maintainers. These records are not operationally required; put operational requirements in `skills/dispatch/references/`.

Format skills as Markdown with YAML frontmatter (`name`, `description`). Treat the root and dispatch READMEs as examples of human-facing documentation, not required outlines.

## Code and Cross-Platform Conventions

Keep repository guidance portable across macOS, Windows, and Linux (zsh, bash, PowerShell), with native guidance for Antigravity, Claude Code, GitHub Copilot, OpenCode, and Codex.

- **Naming:** Use kebab-case for skill identifiers, filenames, and slugs.
- **Paths:** Use forward-slash relative paths instead of `file://` URIs or absolute paths; use Node `path` utilities in scripts.
- **Shell portability:** Use universal shell syntax or Node scripts; fork steps explicitly where environments diverge.
- **TypeScript:** Use native `.ts` with erasable syntax and `.ts` relative imports. Follow `tsconfig.json`; use the Node version declared in `package.json`.
- **Scratch:** Do not commit files under `.scratch/` unless explicitly instructed.

### Code Comments

Explain non-obvious rationale (why, CLI/subprocess quirks, cross-platform nuances, or architectural decisions) in a single clause. Omit obvious mechanics and type signatures.

- Group long sections with short headers; use `// SECTION:` dividers for major segments or platform/mode branches.
- Use `// NOTE:` for workarounds; preserve active `TODO:` and `FIXME:` markers.

## Verification Details

- For focused Node tests, use:

  ```text
  node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts TEST_FILE
  ```

  Add `--test-name-pattern="PATTERN"` when narrowing a test run. With multiple files, require a name-pattern match in each.
- Test behavior at each layer through its public entrypoint: protocol tests cover frames, events, and rendered sections; pure machine tests cover state and effect transitions. Keep one behavior per test and name it for that behavior. Put real Git/subprocess flows in `tests/e2e/`.
- For intended changes to hash-tracked skill files, run `npm run hashes`, then rerun `npm test`.

## Long-Running Work and Handoff

Start each command or delegate once and retain its handle. Wait event-driven for completion, material blockers, or user input, with a 30-minute fallback. Ask delegates to report only completion or material blockers; continue through routine progress without status requests or narration. When an API caps waits, use its longest event-capable wait and reuse the handle.

For completed repository edit tasks, report:

1. **Delivered behaviour** — structural, logic, or documentation change, concisely.
2. **Verification status** — commands executed and results; include evidence for each completion criterion and identify failed or unrun required checks.
3. **Remaining concerns and artifacts** — unresolved decisions or blockers, with paths or links to useful artifacts.
4. **Suggested commit message** — concise Conventional Commits summary (`type(scope): summary`), optionally with a bulleted body for non-trivial changes.

For read-only tasks, report findings and evidence without change-only fields.
