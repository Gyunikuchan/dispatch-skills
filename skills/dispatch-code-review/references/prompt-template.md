# dispatch-code-review delegate prompt

Filled by `dispatch`'s `fill-template.mjs` (see `dispatch`'s `references/alignment.md` § Prompt Template Filling). The variable bullets below are the declared variables; `--list` reads them off this file.

## Prompt template

Populate the template variables:
- `<Task Summary>` — summary of the ask and the changes made.
- `<Walkthrough Path>` — path to the attached walkthrough.
- `<Plan Path>` — path to the attached plan, or `None`.
- `<User Focus Areas>` — trailing user arguments, or `General review`.
- `<Review Scope>` — `Full review` on a first review. On a re-review, `Re-review round <n> — verify the resolutions logged under ## Review Findings & Resolutions; raise new findings only on lines changed since round <n-1>: <changed paths>`.
- `<Tool Turn Budget>` — orchestrator-supplied tool-turn budget, or `Unspecified`.

````markdown
Evaluate recent session changes across six axes.

### Context & Objective
- Task Summary: <Task Summary>
- Walkthrough: <Walkthrough Path>
- Implementation Plan: <Plan Path>
- Review Focus: <User Focus Areas>
- Review Scope: <Review Scope>
- Tool Turn Budget: <Tool Turn Budget>

Adhere to this project's conventions (read `AGENTS.md` / `CLAUDE.md` from the workspace) and industry best practices for code quality.

### Instructions

#### 1. Inspect Changes
1. Run `git status --short`; inspect unstaged (`git diff`), staged (`git diff --staged`), and untracked (`??`) files, reading untracked source/text files in full (skip generated, vendored, or binary files). When nothing outside `.scratch/` is modified or untracked, the work is already committed: review the whole branch instead. Resolve the base branch — `origin/HEAD`, else `main`, else `master` — take its merge-base with `HEAD`, and diff that against `HEAD` so every commit on the branch is covered, not just the last one. If the merge-base *is* `HEAD` (you are on the base branch, or detached), that range is empty — review `git diff HEAD~1` instead.
2. Cross-reference changes against the attached walkthrough and implementation plan (if provided) to verify intent fidelity, completeness, and test coverage.
3. Test results are already given to you: read the walkthrough's `## Verification & Validation` for the verify command and its output, and spend your turns on the diff.
4. Targeted inspection: inspect targeted diffs (`git diff --staged -- <paths>` / `git diff -- <paths>`) and check adjacent call sites, interfaces, or tests to verify contracts and blast radius (use AST / code-graph tools if available, e.g. codegraph, graphify). Read diff hunks plus the call sites, interfaces, and tests they touch; stop at that blast radius.
5. Honour Review Scope: on a re-review round, confine the six axes to the paths it names plus their call sites, confirm each logged resolution actually landed, and treat lines settled in earlier rounds as closed.
6. Tool Turn Budget counts every tool call, verification runs included. Complete inspection within it when it names a number; otherwise budget `6 + <changed files>` turns, counting only files changed since the previous round on a re-review. Spend a tight budget on AST / code-graph queries (`codegraph`, `graphify`) rather than full-file reads. Then emit the report immediately.

#### 2. Six-Axis Evaluation
- **Architecture & Module Design** (`shallow`, `seam`, `adapter`, `coupling`):
  - *Depth & Leverage*: Small interfaces hiding deep logic vs shallow pass-through modules. High leverage for callers, locality for maintainers.
  - *Seams & Dependencies*: One adapter = hypothetical seam; two adapters = real seam. Prefer direct implementations over speculative indirection. Internal seams stay private. Dependency tiers (in-process, local-substitutable, remote owned, external mock).
- **Domain & Business Logic** (`domain-logic`, `invariant`, `unit`, `math`, `runtime`, `type`):
  - *Domain & Project Rules*: Adversarial audit against project context and domain authorities (`AGENTS.md` / `CLAUDE.md`). Challenge assumptions; catch mistaken requirements, flawed mental models by user/agent, or skipped business prerequisites.
  - *Invariants & State Integrity*: Business rules preserved across mutations and lifecycles. Flag states representable in types but invalid in domain logic, or partial state updates leaving objects corrupted.
  - *Logic, Math & Runtime*: Sign conventions (inflow/outflow), unit alignment (monthly/annual, fraction/percentage), formula accuracy, off-by-one errors, unhandled union branches, unguarded indexing (`arr[0]`), and floating promises.
- **Security & Resource Safety** (`vuln`, `auth`, `leak`, `perf`):
  - *Vulnerabilities & Auth*: Injection, path traversal, escaping, secrets, and auth/permission bypasses.
  - *Resource Lifecycle & Perf*: Unclosed handles/connections, memory/goroutine leaks, unbounded memory/concurrency, blocking event loops, and quadratic operations on hot paths.
- **Simplicity & Anti-Bloat** (`yagni`, `reuse`, `stdlib`, `root-cause`):
  - *The Ladder*: (1) YAGNI / delete unneeded code, (2) reuse codebase helpers/types, (3) stdlib and native platform features over custom logic/dependencies, (4) shortest working diff.
  - *Root Cause*: Fix at shared source rather than scattering call-site patches.
- **Blast Radius & Compatibility** (`breaking`, `compat`, `migration`, `scope-creep`):
  - *Compatibility & Migration*: Caller/client backwards compatibility, schema/data migration safety, and serialized format handling.
  - *Scope Fidelity*: Flag unrequested changes or diffs exceeding task boundaries.
- **Test Quality & UI/UX** (`test-gap`, `test-leak`, `ui`, `a11y`):
  - *Test Coverage & Surface*: Assert observable outcomes at interface seams; flag missing failure-mode tests or tests coupling to private internals.
  - *UI & UX Contracts*: Visual hierarchy, responsive layout, adherence to project design guidelines (if available), a11y compliance (if UI touched), or CLI/API ergonomics.

#### 3. Report Output

Write every finding as one line in this grammar:

```
<file>:L<line> — <tag>: <defect> → <required change>
```

`<tag>` is one of the axis tags above. Every finding, assertion, violation, recommendation, and code snippet carries a concrete path and line number.

Structure your review as:
- `## Verdict`: One line — ship readiness and overall health across the 6 axes.
- `## Axis Coverage`: One line per axis — `<axis>: clean` or `<axis>: <n> finding(s)`; `<axis>: n/a` only for Test Quality & UI/UX when the change touches neither tests/testable behaviour nor UI, and on a re-review round `<axis>: out of scope` for an axis Review Scope excludes. Explicitly list every axis.
- `## MUST-FIX`: Defects and vulnerabilities that block shipping, or "None."
- `## SHOULD-FIX`: Real weaknesses worth correcting now, or "None."
- `## CONSIDER`: Optional improvements and high-yield cuts, or "None."
- `## Actionable Next Steps`: Prioritized follow-ups citing target locations.
````
