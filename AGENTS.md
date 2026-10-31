# Dispatch Skills Agent Guide

Repository-wide instructions for work in this checkout. `.claude/CLAUDE.md` symlinks here; edit this canonical file.

## Product Objective and Principles

Dispatch enables high-confidence development across native agent harnesses: catch flawed assumptions early and verify delivery with minimal routine human coordination. Guide changes with these principles:

- **Proportional assurance:** Balance correctness, token efficiency, and speed against task risk. Preserve acceptance and safety boundaries with the simplest, least costly workflow.
- **Native collaboration:** Preserve each platform's native reasoning loop and permitted tools; standardize routing, evidence, and handoffs.
- **Evidence and intent:** Treat delegate findings as claims. Check them against governing intent, rules, and artifacts; resolve findings with evidence, never vote counts.
- **Lean context:** Keep always-loaded contracts and initial briefs focused. Disclose detail progressively, retain evidence in linked artifacts, and prefer deterministic enforcement over recurring prose.
- **Diagnostics:** Capture metrics identifying defects and bottlenecks. Minimize token overhead when disabled; load instructions and collect observations only when enabled.
- **Informed handoffs:** State objective, decisions, constraints, current state, next action, and verified evidence at each handoff. Link artifacts for detail.
- **Structural least privilege:** Keep provider delegates read-only; scope native writes explicitly ([providers.md](skills/dispatch/references/providers.md)). Independently check submitted changes.
- **Recoverable autonomy:** Automate routine progress within approved scope. Preserve work and durable evidence; recover without duplicate effects; escalate unresolved blockers.
- **Stack neutrality:** Assume no host language, package manager, build tool, or test runner. Host-specific behavior comes from plan-declared commands and paths. Repository Node tooling is a maintainer choice, not a product default.
- **Simple, portable composition:** Respect host conventions; maintain clean layer boundaries. Keep skills standalone and composable without imposing framework conventions on host repositories.
- **User deputy:** Act as the user's executive deputy. Verify facts, adjudicate claims, and distill trade-offs autonomously. Escalate only material blockers and intent decisions with clear recommendations and evidence.

## Communication

Follow ASD-STE100 (Simplified Technical English). Be terse and high-signal: omit filler and hedging; preserve exact terms, code, and units. Link to artifacts or run logs instead of pasting long traces.

## Clarify Material Ambiguity

Investigate first: verify facts against the repository, tools, and governing intent before consulting the user.

Escalate when unresolved requirements, constraints, or trade-offs change scope, behavior, or risk, using the [Decision Frame](skills/dispatch/references/decision-frame.md). Follow the [user gate](skills/dispatch/references/decision-frame.md#user-gate-boundaries) before implementation when a change would alter intent, add external dependencies or runtime prerequisites, or discard work.

Continue independent work not blocked by the decision. For routine progress within approved scope, state a reasonable assumption and proceed. Suggest simpler alternatives that meet the goal.

For backward-incompatible changes, choose simpler current behavior and drop legacy support by default; preserve compatibility only when instructed. When removing behavior, delete all references, lint checks, tests, and guards for it. Report adjacent findings while keeping execution within requested scope.

## Repository Change Workflow

For code and documentation changes, follow **Discover → Bound → Execute → Verify → Handoff**:

- **Discover:** Read relevant `SKILL.md` files or scripts and inspect current state before editing.
- **Bound:** Set intended outcome, in-scope paths, and checkable completion criteria from the request or approved plan. Keep planning and review proportional to task risk.
- **Execute:** Apply minimal, focused edits within scope, preserving existing comments and invariants.
- **Verify:** Run plan Verify commands and `npm test` before completing an edit task; run `npm run test:e2e` when touching toolkit, Git, or subprocess behavior (CI runs `npm run test:all`). Record evidence for each criterion after the last change; failed or unrun checks remain open.
- **Handoff:** Use the format in [Long-Running Work and Handoff](#long-running-work-and-handoff).

### Implementing plans in this repository

When `/dispatch-implement` (or `dispatch implement`) runs in this checkout, follow [fixed-controller self-build](skills/dispatch/references/self-build.md). Select and inventory a complete stable controller, then run Dispatch execution against the candidate checkout. Keep active-run commands and inputs bound to that controller through verification and owned-worktree cleanup.

Before launching writers or read delegates, if the `codegraph` CLI is available and the repository has no `.codegraph/`, ask the user once whether to index it. When indexed, writers and read delegates locate code symbols with `codegraph explore "<symbols>"` before reading, and read only returned ranges; read non-code and small files whole. Include this in writer briefs. Read delegates run it only when config `read-commands` permits `codegraph explore`. Codegraph may update its index during reads.

Use the procedure's bounded manual repair fallback only when a demonstrated controller defect prevents normal execution and recovery. Preserve the blocked run and evidence; obtain an approved repair plan before editing. Scope, review, verification, and cleanup rules apply.

## Product Architecture and Key Areas

`dispatch` owns every shipped runner, driver, template, schema, config, and operational reference. `dispatch-plan`, `dispatch-implement`, and `dispatch-code-review` are thin compatibility aliases mapping arguments to one verb; `dispatch` never references them.

Key boundaries:
- Reference skills by name or sibling-relative `<skills-dir>` paths, never host-specific paths.
- Aliases require sibling `dispatch`, map arguments to one verb, and report a missing-dependency diagnostic if absent.
- Vendored skills in `.agents/skills/` (tracked in `skills-lock.json`) are external and read-only; never edit them directly. To adapt behavior, configure or wrap them through maintainer-owned files (e.g. `AGENTS.md`, root skills, or scripts).
- Shared review conventions live in [review-rules.md](skills/dispatch/references/review-rules.md).

### Canonical Documents

Execution in `dispatch` centers on four canonical layers:

- **Spec (Mission brief):** Intent, background, user decisions, constraints, and desired outcomes. Governing authority read by authors, reviewers, and writers.
- **Design (Strategy):** Architecture, system boundaries, critical trade-offs, and ordered delivery increments.
- **Plan (Tactics):** Concrete execution units: tasks, file ownership, prerequisites, requirement-linked criteria (`[SC<n>]`), and verification commands.
- **Walkthrough (Debrief):** Post-execution record of delivered behavior, changes, criterion verification evidence, deviations, follow-ups, and review resolutions.

Dual-audience: Canonical documents serve both humans and agents. Keep outcome summaries, observable behavior, and visual aids visible for human review; collapse machine fields, per-file breakdowns, and granular execution detail inside `<details>` blocks.

## Documentation Standards

Integrate new prose into existing structure before adding text: rephrase, reorder, and remove redundant or obsolete material. Keep each rule in one canonical home. Apply progressive disclosure: inline essentials and link branch-specific detail. Use the fewest tokens that preserve meaning and execution.

- **Human documentation:** Explain concepts plainly around user tasks; provide realistic examples, setups, limits, and recovery steps. The root and dispatch READMEs serve as style examples, not rigid outlines.
- **Agent-facing prose:** Applies to skills, prompts, templates, operational references, and script-emitted instructions. Follow [.agents/skills/writing-for-agents/SKILL.md](.agents/skills/writing-for-agents/SKILL.md). Define explicit triggers, sequence, boundaries, and checkable completion criteria. Include rationale only when it alters execution. Format skills with YAML frontmatter (`name`, `description`).
- **Maintainer knowledge base (`docs/`):** Preserve long-term rationale, not operational requirements (which belong in `skills/dispatch/references/`). ADRs (`docs/decisions/`) record current state: focus on active decisions and rationale; omit historical logs and superseded context. Store transient sweeps, logs, and scratch in `.scratch/`, not `docs/`.

## Code and Cross-Platform Conventions

Maintain portability across macOS, Windows, and Linux (zsh, bash, PowerShell) and native agent harnesses (Antigravity, Claude Code, GitHub Copilot, OpenCode, Codex).

- **Naming:** Use kebab-case for skill identifiers, filenames, and slugs.
- **Paths:** Use forward-slash relative paths instead of `file://` URIs or absolute paths; use Node `path` utilities in scripts.
- **Shell portability:** Use universal shell syntax or Node scripts; branch explicitly where environments diverge.
- **TypeScript:** Use native `.ts` with erasable syntax and `.ts` relative imports per `tsconfig.json` and `package.json` Node version.
- **Scratch:** Store transient artifacts in `.scratch/`; commit them only when instructed.

### Code Comments

Explain non-obvious rationale (e.g. quirks, non-obvious invariants, architectural choices) in a single clause. Omit obvious mechanics and signatures.

- Group long sections with short headers; use `// SECTION:` dividers for major segments or platform/mode branches.
- Use `// NOTE:` for workarounds; preserve active `TODO:` and `FIXME:` markers.

## Verification Details

- **Focused Node tests:** Run:
  ```text
  node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts TEST_FILE
  ```
  Add `--test-name-pattern="PATTERN"` to narrow tests. With multiple test files, require a name match in each; prefer running single files when filtering. Before aggregate verification, run every modified and impacted test file with this command without `--test-name-pattern`.
- **Plan checks:** A criterion Verify running a full test file satisfies that file's affected-file check; list under `Automated Tests` only checks not covered by criterion Verifies.
- **Brief sizing:** Use `node scripts/brief-size.ts <brief-file> [<brief-file> ...]` to report UTF-8 bytes (not token estimates). Store output in `.scratch/` and link in handoff.
- **Test layers:** Toolkit tests verify tool results, ledgers, and rendered sections. Real Git and subprocess flows belong in `tests/e2e/`.
- **Fixtures:** Keep unit fixtures in memory; use physical storage only when verifying filesystem behavior or byte output, preserving per-file timing budgets.
- **Quality bar:** Apply [quality-bar.md § Code](skills/dispatch/references/templates/quality-bar.md#code) for test behavior, naming, and retention.
- **Toolkit changes:** List callers with CodeGraph; test every caller family, including failures after each durable boundary.
- **Hash-tracked changes:** When editing hash-tracked skill files, list them in `[GENERATED] skills/dispatch/skill-hashes.json`, run `npm run hashes`, then rerun `npm test`.

## Long-Running Work and Handoff

Wait event-driven: start commands or delegates once, retain handles, and await completion, material blockers, or user input (30-minute fallback). Avoid polling loops, repeated status checks, and intermediate file reads while work runs. Instruct delegates to report only completion or material blockers. Reuse handles across wait cycles.

For completed repository edit tasks, report:

1. **Delivered behaviour** — concise structural, logic, or documentation changes.
2. **Verification status** — executed commands and results, evidence for each criterion, and any unrun or failed required checks.
3. **Remaining concerns and artifacts** — unresolved decisions, proposed ADR updates, blockers, and artifact links.

For read-only tasks, report findings and evidence without edit-specific fields.
