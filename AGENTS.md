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
- **Stack neutrality:** Assume no host language, package manager, build tool, test runner, or reporter format. Host-specific behavior comes from plan-declared commands and paths. This repository's Node tooling is a maintainer choice, not a product default.
- **Simple, portable composition:** Respect host conventions and maintain clear ownership between layers. Keep `dispatch` independent of its aliases; prefer one coherent execution path over added coordination machinery. Keep skills standalone or composable without writing conventions into host repositories.
- **User deputy:** Act as the user's executive deputy. Verify facts, adjudicate delegate claims, and distill trade-offs autonomously. Shield the user from routine coordination; escalate only material blockers and intent decisions with a clear recommendation and verified evidence.

## Communication

Follow ASD-STE100 (Simplified Technical English) in agent communication. Be terse and high-signal; omit filler and hedging, and preserve exact terms, code, and units. Link to artifacts or run logs rather than copying long traces.

## Clarify Material Ambiguity

Investigate first: verify facts against the repository, tools, and governing intent before consulting the user.

When unresolved requirements, constraints, or trade-offs could change scope, behavior, or risk, escalate using the [Decision Frame](skills/dispatch/references/decision-frame.md).

Continue independent work that does not depend on the answer; for routine progress within approved scope, state a reasonable assumption and proceed. Suggest simpler alternatives when they meet the goal.

For backward-incompatible changes, choose the simpler current behavior and drop legacy support by default; preserve compatibility only when instructed.

Escalate under the [user gate](skills/dispatch/references/decision-frame.md#user-gate-boundaries) before implementation when a change would alter intent, add an external dependency or runtime prerequisite, or discard work. Report adjacent findings while keeping execution within the requested scope.

## Repository Change Workflow

For code and documentation changes, follow **Discover → Bound → Execute → Verify → Handoff**:

- **Discover:** Read relevant `SKILL.md` files or scripts and inspect the current state before editing.
- **Bound:** Set the intended outcome, in-scope paths, and checkable completion criteria from the request or approved plan. Keep planning and review proportional to task risk.
- **Execute:** Apply minimal, focused edits within scope, preserving existing comments and invariants.
- **Verify:** Run plan Verify commands and `npm test` before completing an edit task. Record evidence for each criterion after the last change; failed or unrun required checks remain open.
- **Handoff:** Use the task-appropriate format below.

### Implementing plans in this repository

When `/dispatch-implement` (or `dispatch implement`) runs in this checkout, read and follow [the fixed-controller self-build procedure](skills/dispatch/references/self-build.md). Select and inventory a complete stable controller, then use normal Dispatch execution against the candidate checkout. Keep active-run commands and inputs bound to that controller through verification and owned-worktree cleanup.

Before writer launch, if the `codegraph` CLI is available and the repository has no `.codegraph/`, ask the user once whether to index it. When an index exists, tell each writer in its brief to locate code symbols with `codegraph explore "<symbols>"` before reading, then read only the returned ranges; non-code and small files may be read whole. Writers never initialize or rebuild the index.

Use the procedure's bounded manual repair fallback only when a demonstrated controller defect prevents normal execution and recovery. Preserve the blocked run and evidence, and obtain a bounded approved repair plan before implementation. Existing scope, review, verification and cleanup rules still apply.

## Product Architecture and Key Areas

`dispatch` owns every shipped runner, driver, template, schema, config, and operational reference. The three companion skills are compatibility aliases that run only when invoked by name:

```text
dispatch-plan ──────────┐
dispatch-implement ─────┼──> dispatch
dispatch-code-review ───┘

dispatch has no dependency on these aliases.
```

Key areas:

```text
skills/dispatch/          model-visible contract, config, scripts, references
skills/dispatch-{plan,implement,code-review}/ compatibility aliases and human manuals
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
- Never edit skills managed by `npx skills` (listed in `skills-lock.json`); updates overwrite local edits. When one needs different behavior here, adapt it through files this repository owns, such as this guide or a local skill that invokes it.

### Canonical Documents

Execution in `dispatch` centers on four canonical document layers:

- **Spec (Mission brief):** Intent, background, user decisions, constraints, and desired outcomes. Governing authority read by all participants (authors, reviewers, and writers).
- **Design (Strategy):** Architecture, system boundaries, critical trade-offs, and ordered delivery increments.
- **Plan (Tactics):** Concrete execution details for a single coherent unit: tasks, file ownership, prerequisites, requirement-linked criteria (`[SC<n>]`), and verification commands.
- **Walkthrough (Debrief):** Post-execution record of delivered observable behavior, changes made, criterion verification evidence, deviations, follow-ups, and review findings and resolutions.

## Documentation Standards

Classify each document or piece of prose by its primary audience and task. Keep each rule in one canonical home; other documents may explain its audience-specific effect and link to that home.

- **Human documentation:** Help users decide whether and how to use the skills. Include details they need to choose a skill, set it up, use it correctly, understand its results or limits, or recover from a problem. Explain concepts plainly, organize around user tasks, and use realistic examples with relevant outcomes and constraints.
- **Agent-facing prose:** Apply these rules to contracts, prompts, templates, instructions embedded in scripts, and operational references. Direct decisions and actions with explicit triggers, order, boundaries, and checkable completion criteria. Include rationale when it changes execution; keep instructions focused and single-sourced; disclose branch-specific detail. Add detail when it materially improves correct execution, naming the behavior, decision, or failure mode it addresses. Word count may increase when genuinely new content warrants it, or after streamlining (e.g., de-duplicating, rewording, reordering, or moving detail to referenced files) has been considered. When editing agent-facing prose, apply `writing-for-agents` and reference existing rules instead of restating them.
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
- Before the aggregate gate, run every test in each modified logical test file and known impacted consumer file without `--test-name-pattern`:

  ```text
  node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts TEST_FILE
  ```

  Keep narrow selectors for RED/GREEN feedback; declare affected-file checks as fast `Automated Tests` commands in plans.
- Use `node scripts/brief-size.ts <brief-file> [<brief-file> ...]` to report total and section UTF-8 bytes for valid UTF-8 inputs; it does not estimate tokens. Keep output under run scratch and link it in the handoff.
- Protocol tests cover frames, events, and rendered sections; pure machine tests cover state and effect transitions. Put real Git/subprocess flows in `tests/e2e/`.
- Keep logical unit fixtures in memory (`memoryRunFs`); use physical storage only when the claim depends on bytes or filesystem behavior. Physical I/O breaks per-file timing budgets under aggregate load.
- Apply the [quality bar's code section](skills/dispatch/references/templates/quality-bar.md#code) to test behavior, naming, and retention.
- When a change alters a shared machine or effect contract, list its callers with CodeGraph and cover every parent machine family, including failure after each durable boundary.
- For a plan that changes hash-tracked skill files, its `[GENERATED] skills/dispatch/skill-hashes.json` entry lists every changed hash-tracked skill file, including scripts, as Inputs; run `npm run hashes`, then rerun `npm test`.

## Long-Running Work and Handoff

Start each command or delegate once and retain its handle. Wait event-driven for completion, material blockers, or user input, with a 30-minute fallback. Do not poll with repeated status checks, short waits, or file reads while work is running. Ask delegates to report only completion or material blockers; continue through routine progress without status requests or narration. When an API caps waits, use its longest event-capable wait and reuse the handle.

For completed repository edit tasks, report:

1. **Delivered behaviour** — structural, logic, or documentation change, concisely.
2. **Verification status** — commands executed and results; include evidence for each completion criterion and identify failed or unrun required checks.
3. **Remaining concerns and artifacts** — unresolved decisions or blockers, with paths or links to useful artifacts.

For read-only tasks, report findings and evidence without change-only fields.
