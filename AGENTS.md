# Dispatch Skills Agent Guide

Repository-wide instructions for work in this checkout. `.claude/CLAUDE.md` symlinks here; edit this canonical file.

## Product Objective and Principles

Dispatch turns the host agent into an end-to-end orchestrator across native subagents and cross-platform CLI delegates—catching flawed assumptions early and verifying delivery with minimal routine human coordination.

- **AX / DX / UX balance:** Evaluate changes across **AX** (agents running the skill: reliability, context and tool-call cost), **DX** (human and agent maintainers), and **UX** (human users). Protect **UX** outcomes and **AX** reliability first; use **DX** to serve both without adding runtime friction.
- **Proportional assurance:** Balance quality, token/monetary cost, and speed against task risk, preserving acceptance and safety boundaries with the simplest workflow.
- **Native collaboration:** Preserve each platform's native reasoning loop and permitted tools; standardize routing, evidence, and handoffs.
- **Evidence and intent:** Treat delegate findings as claims. Verify them against governing intent, rules, and source; resolve findings with evidence, never vote counts.
- **Lean context:** Keep always-loaded contracts and briefs focused, disclose detail progressively (via pointers and on-demand script output), retain evidence in linked artifacts, and enforce deterministically over repeating prose. Delegate multi-file research to native explorer subagents returning distilled, cited replies.
- **Scripts as spine:** Scripts save cost through deterministic work and guide agents without restricting efficient execution. Add a check only when it prevents a likely, costly fault that instructions and review miss; prefer trusting an instructed agent over guarding against it. Checks warn by default and block only to protect a user gate or prevent work loss; remove checks that restrict routine progress or cost more than the fault they prevent.
- **Diagnostics:** Capture defect and bottleneck metrics with zero token overhead when disabled; load instructions and collect observations only when enabled.
- **Informed handoffs:** State objective, decisions, constraints, current state, next action, and verified evidence at each handoff, linking artifacts for detail.
- **Structural least privilege:** Keep provider delegates read-only and scope native writes explicitly ([providers.md](skills/dispatch/references/providers.md)); independently check submitted changes.
- **Recoverable autonomy:** Automate routine progress within approved scope, preserve work and durable evidence, recover idempotently, and escalate unresolved blockers.
- **Stack neutrality:** Assume no default host language, package manager, build tool, or test runner; derive host behavior from the host repository, rules, and plan-declared commands and paths. Repository Node tooling is a maintainer choice.
- **Simple, portable composition:** Keep skills standalone and composable across host conventions without imposing framework rules on host repositories.
- **User deputy:** Equip the host agent to act as the user's executive deputy—verifying facts, adjudicating claims, and distilling trade-offs autonomously, escalating only material blockers and intent decisions with recommendations and evidence.

## Communication and Ambiguity

Use ASD-STE100 (Simplified Technical English): terse prose without filler or hedging; preserve exact terms, code, and units. Link artifacts/logs instead of long traces.

Investigate repository facts and governing intent before consulting the user. Escalate through the [Decision Frame](skills/dispatch/references/decision-frame.md) when unresolved requirements, constraints, or trade-offs change scope, behavior, or risk, and pause at the [user gate](skills/dispatch/references/decision-frame.md#user-gate-boundaries) before changing intent, adding external dependencies or runtime prerequisites, or discarding work. Continue independent work while a decision is pending; for routine progress within approved scope, state a reasonable assumption, proceed, and suggest simpler alternatives.

For backward-incompatible changes, adopt the simpler current behavior and drop legacy support unless instructed to keep it. When removing behavior, delete all references, lint checks, tests, and guards for it. Report adjacent findings while keeping execution within requested scope.

## Product Architecture and Key Areas

- **Shipped skills (`skills/`):** `dispatch` owns all shipped runners, drivers, templates, schemas, configs, and operational references. `dispatch-plan`, `dispatch-implement`, `dispatch-code-review`, and `dispatch-verify` are thin compatibility aliases (`dispatch` never references them). Reference skills by name or sibling-relative `<skills-dir>` paths, never host-specific paths; aliases require sibling `dispatch`, map arguments to one verb, and report a missing-dependency diagnostic if absent. When changing `dispatch` in this checkout, follow [fixed-controller self-build](skills/dispatch/references/self-build.md).
- **Maintainer and vendored skills (`.agents/skills/`):** Entries tracked in `skills-lock.json` (`grilling`, `retro`, `writing-for-agents`) are external and read-only; adapt their behavior through maintainer-owned files (`AGENTS.md`, root skills, or scripts). Internal maintainer skills (`optimise-tests`, `publish-git`) are repository-owned and not shipped in the npm package.
- **Review and canonical documents:** Shared review rules live in [review-rules.md](skills/dispatch/references/review-rules.md). Canonical document roles and layer boundaries (Spec, Design, Plan, Walkthrough) live in [spec-stage.md](skills/dispatch/references/spec-stage.md#readers-and-document-layers). These artifacts serve a **dual audience (humans and agents)**: keep outcome summaries, observable behavior, and visual aids visible for human review, and collapse machine fields, per-file breakdowns, and granular execution detail inside `<details>` blocks per [quality-bar.md § spec](skills/dispatch/references/templates/quality-bar.md#spec).

## Documentation Standards

Integrate edits into existing structure—rephrase, reorder, and prune stale or duplicate material before adding text. Keep each rule in one canonical home. Inline a rule in `skills/dispatch/SKILL.md` only when every branch needs it (a must-load reference adds a tool call to every run). Cut or consolidate before raising structural ceilings (`SKILL.md` bytes, step budgets, driver LOC); a genuine new rule or behavior may raise a ceiling without user authorization when the reason is recorded beside the ceiling and reported in the handoff (duplicates never justify a raise).

- **Human documentation:** Explain concepts around user tasks with realistic examples, setups, limits, and recovery steps, following the root and `dispatch` READMEs.
- **Agent-facing prose:** Follow [.agents/skills/writing-for-agents/SKILL.md](.agents/skills/writing-for-agents/SKILL.md) (and `SKILL-MECHANICS.md` for skill frontmatter/routing) across skills, prompts, templates, references, and script-emitted instructions. Include rationale only when it alters execution.
- **Maintainer knowledge base (`docs/`):** Keep long-term rationale and active ADRs in `docs/decisions/` (omitting historical logs and superseded context) and operational rules in `skills/dispatch/references/`.

## Code and Cross-Platform Conventions

Maintain portability across macOS, Windows, and Linux (`zsh`, `bash`, PowerShell) and supported hosts (Antigravity, Claude Code, GitHub Copilot, OpenCode, Codex).

- **CodeGraph:** When `codegraph` is available and `.codegraph/` is absent, ask the user once whether to index the repository. When indexed, locate code symbols and call paths with `codegraph explore "<symbols>"` before reading, and read only returned ranges (read non-code and small files whole); CodeGraph may update its index during reads. Include this in subagent and writer briefs; read delegates run it only when config `read-commands` permits `codegraph explore`.
- **Naming and paths:** Use kebab-case for skill identifiers, filenames, and slugs. Use forward-slash relative paths in repository prose and artifacts instead of `file://` URIs or absolute paths; use Node `path` utilities in scripts.
- **Shell and TypeScript:** Use universal shell syntax or Node scripts, branching explicitly where environments diverge. Use native `.ts` with erasable syntax and `.ts` relative imports per `tsconfig.json`.
- **Scratch:** Store transient artifacts in `.scratch/`; commit them only when instructed.

### Code Comments

Explain non-obvious rationale (quirks, invariants, architectural choices) in a single clause; omit obvious mechanics and signatures.

- Group long sections with short headers; use `// SECTION:` dividers for major segments or platform/mode branches.
- Use `// NOTE:` for workarounds; preserve active `TODO:` and `FIXME:` markers.

## Verification Details

- **Aggregate suites:** Run plan `Check:` commands and `npm test` (which runs `typecheck`, `lint`, `format:check`, repo checks, and fast tests; use `npm run format` to auto-fix) after the last edit; run `npm run test:e2e` when touching toolkit, Git, or subprocess behavior (CI runs `npm run test:all`). Record evidence for each criterion; failed or unrun checks remain open.
- **Focused Node tests:** Run:
  ```text
  node --test --import=./tests/helpers/isolated-temp.ts --import=./tests/helpers/block-spawn.ts --test-reporter=./scripts/test-reporter.ts TEST_FILE
  ```
  Add `--test-name-pattern="PATTERN"` to filter (prefer single files when filtering, as multiple files require a match in each). Before aggregate verification, run every modified and impacted test file without `--test-name-pattern`.
- **Brief sizing:** Measure UTF-8 bytes (never token estimates) with `node scripts/brief-size.ts <brief-file> [...]`; store output in `.scratch/` and link in the handoff.
- **Test layers and fixtures:** Keep unit tests in memory; reserve physical filesystem I/O for byte/storage checks within per-file timing budgets, and put real Git or subprocess flows in `tests/e2e/`.
- **Quality bar:** Apply [quality-bar.md § testing](skills/dispatch/references/templates/quality-bar.md#testing) for test retention, oracles, and naming.
- **Toolkit changes:** List callers with CodeGraph; test every caller family, including failures after each durable boundary.
- **Hash-tracked changes:** When editing hash-tracked skill files, declare `[GENERATED] skills/dispatch/skill-hashes.json` in the plan and run `npm run maintain`.

## Long-Running Work and Handoff

Wait event-driven: start commands or delegates once, retain and reuse handles across wait cycles, and await completion, material blockers, or user input (30-minute fallback) without polling or intermediate reads. Instruct delegates to report only completion or material blockers.

For completed repository edit tasks, report:

1. **Delivered behaviour** — concise structural, logic, or documentation changes.
2. **Verification status** — executed commands and results, evidence for each criterion, and any unrun or failed required checks.
3. **Remaining concerns and artifacts** — unresolved decisions, proposed ADR updates, blockers, and artifact links.

For read-only tasks, report findings and evidence without edit-specific fields.
