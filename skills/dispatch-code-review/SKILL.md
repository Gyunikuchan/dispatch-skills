---
name: dispatch-code-review
description: Review session changes across 6 code axes through external agent CLIs, then adjudicate returned claims. Use when code changes need a cross-agent second opinion or review.
---

# dispatch-code-review

The delegate's report is a **claim, not a verdict**. The orchestrator adjudicates every finding against the active codebase before updating the walkthrough or reporting to the user.

## Process

### 1. Assemble context and dispatch

Attach the change walkthrough and implementation plan (if present), plus any user-specified files, with `-f "<path>"` (forward slashes throughout).

Resolve context files in order. Plan and walkthrough share one slug and one resolver call:

1. **User- or orchestrator-supplied plan/walkthrough** when an explicit path is passed or an orchestrating skill hands one over — skip the script for that kind.
2. **Otherwise**, resolve the slug (`dispatch`'s [skill alignment: artifact path resolution](../dispatch/references/alignment.md#planwalkthrough-artifact-resolution): derive from the current git branch, or choose an explicit kebab-case one when derivation fails), then run once for both kinds:
   ```bash
   node <skills-dir>/dispatch/scripts/resolve-artifact-paths.mjs --slug <slug>
   ```
   For `plan`: `tier: native` or `scratch-existing` means a plan already exists — attach it (e.g. from a prior planning phase); `tier: scratch-new` (`exists: false`) — omit `-f` for the plan, none exists.
   For `walkthrough`: `tier: native` or `scratch-existing` means one already exists — attach it as-is; `tier: scratch-new` — author the returned path following the walkthrough template below before dispatching. External delegates read attached files as their primary task context.

#### Walkthrough template

When authoring a walkthrough, use this structure:

````markdown
# Walkthrough — <Goal Description>

Summary of changes made, context, and what was accomplished.

## Changes Made

### <Component Name>
- **[NEW]** `<relative-path>` — Purpose and new interface/behavior.
- **[MODIFY]** `<relative-path>` — Concrete changes and invariants preserved.
- **[DELETE]** `<relative-path>` — Removed symbols and cleanup.

## Verification & Validation
### Automated Tests
- Command: `<test command>` — Output/results (e.g. `X tests passed`).
### Manual Verification
- Concrete manual verification performed and observed results.

## Key Deviations
Deviations from original plan or design intent, with rationale (or "None").

## Review Findings & Resolutions
<!-- Populated during code review cycles -->
*No reviews conducted yet.*
````

#### Prompt template

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

Adhere to this project's conventions (read `AGENTS.md` / `.claude/CLAUDE.md` from the workspace) and industry best practices for code quality.

### Instructions

#### 1. Inspect Changes
1. Run `git status --short` to identify modified files. The changes under review are usually **uncommitted**: inspect both unstaged (`git diff`) and staged (`git diff --staged`) work. Fall back to `git diff HEAD~1` only when the working tree is clean.
2. Cross-reference changes against the attached walkthrough and implementation plan (if provided) to verify intent fidelity, completeness, and test coverage.
3. Targeted inspection: inspect targeted diffs (`git diff --staged -- <paths>` / `git diff -- <paths>`) and check adjacent call sites, interfaces, or tests to verify contracts and blast radius (use AST / code-graph tools if available, e.g. codegraph, graphify). Avoid full-file dumps or open-ended codebase exploration.
4. Honour Review Scope: on a re-review round, confine the six axes to the paths it names plus their call sites, confirm each logged resolution actually landed, and treat lines settled in earlier rounds as closed.
5. Complete inspection within Tool Turn Budget when it names a number; otherwise spend 3–4 tool turns for focused tasks, up to 8 for broad refactors or cross-cutting changes, and fewer on a re-review round. Spend a constrained budget on AST / code-graph queries (`codegraph`, `graphify`) rather than full-file reads. Then emit the report immediately.

#### 2. Six-Axis Evaluation
- **Architecture & Module Design** (`shallow`, `seam`, `adapter`, `coupling`):
  - *Depth & Leverage*: Small interfaces hiding deep logic vs shallow pass-through modules. High leverage for callers, locality for maintainers.
  - *Seams & Dependencies*: One adapter = hypothetical seam; two adapters = real seam. Prefer direct implementations over speculative indirection. Internal seams stay private. Dependency tiers (in-process, local-substitutable, remote owned, external mock).
- **Domain & Business Logic** (`domain-logic`, `invariant`, `unit`, `math`, `runtime`, `type`):
  - *Domain & Project Rules*: Adversarial audit against project context and domain authorities (`AGENTS.md` / `.claude/CLAUDE.md`). Challenge assumptions; catch mistaken requirements, flawed mental models by user/agent, or skipped business prerequisites.
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
- `## Axis Coverage`: One line per axis — `<axis>: clean` or `<axis>: <n> finding(s)`; `<axis>: n/a` only for UI when no UI was touched, and on a re-review round `<axis>: out of scope` for an axis Review Scope excludes. Explicitly list every axis.
- `## MUST-FIX`: Defects and vulnerabilities that block shipping, or "None."
- `## SHOULD-FIX`: Real weaknesses worth correcting now, or "None."
- `## CONSIDER`: Optional improvements and high-yield cuts, or "None."
- `## Actionable Next Steps`: Prioritized follow-ups citing target locations.
````

**Dispatch**: use orchestrator-supplied dispatch invocations when present (retains fan-out breadth and provider pinning). Otherwise dispatch backgrounded and yield the turn; see `dispatch` for cascade, flags, and log monitoring. Dispatch runs structurally read-only.

**Done when:** the walkthrough and plan (if present) are resolved (or walkthrough authored), attached, the prompt is populated, and dispatch is launched backgrounded with the turn yielded.

---

### 2. Adjudicate each actionable claim

Adjudicate claims proposing concrete changes (defects, cuts, vulnerabilities, recommendations). Discard passing axes, clean verdicts, and praise immediately.

Ground truth for a code claim is the cited `<file>:L<line>`. Read it plus enough surrounding context to judge, then assign one verdict:

| Verdict | Criterion | Action |
|---------|-----------|--------|
| **Accept** | Code confirms the defect and its stated impact | Apply fix or carry into report, and log per Step 3 |
| **Reject** | Cited code contradicts the claim, the line does not exist, or the fix is already present | Drop from changes; log rejection in walkthrough resolutions |
| **Downgrade** | Real but trivial — style, taste, or speculative | Fold into next steps or drop; log in walkthrough resolutions |
| **Disputed** | Unsettleable from code alone (intent, unverified external figures, deliberate trade-offs, convention cutting both ways) | Escalate to user |

Verify every claim against the cited lines before accepting. Classify uncited, contradicted, or unverifiable claims as **Reject**.

**Evidence over votes**: when aggregating multi-delegate reports, dedupe duplicate claims pointing to the same defect at the same `<file>:L<line>` into a single finding, then verify against the code. Accept valid findings regardless of delegate count; reject refuted findings even if unanimous. Provider agreement is context, never evidence.

**Escalate disputes**: query the user via interactive question tool (`ask_question` / `AskUserQuestion`) before modifying code or reporting for **Disputed** findings. Batch up to 4 questions per invocation (if more disputes exist, ask in successive batches); cite `<file>:L<line>`, state the delegate's claim, and provide your counter-reading with accept / reject / defer options. Apply user choices verbatim as final. Escalate whenever disputes involve repository-named domain authorities, persisted schema, shared URL state, or explicit user requests.

**Done when:** every actionable claim carries a verdict and all disputes are resolved by the user.

---

### 3. Fold findings into walkthrough and report

1. **Apply fixes and update walkthrough**: Apply accepted `MUST-FIX` items and approved modifications to the codebase. When fixes modify additional code or verification results, update `## Changes Made` and `## Verification & Validation` in the walkthrough accordingly.
2. **Record review outcomes**: Append this round's complete adjudication log under `## Review Findings & Resolutions` in the walkthrough file:
   - `- **[Accepted]** <file>:L<line> — <tag>: <defect> → <resolution & fix applied>`
   - `- **[Resolved Dispute]** <file>:L<line> — <tag>: <defect> → <user ruling & action>`
   - `- **[Rejected / Downgraded]** <file>:L<line> — <tag>: <defect> → <rejection rationale>`

Report to the user, prefixed by provider label from the dispatch result (including session deep-link or resume command when available):

1. **Verdict**: one line — ship readiness and health across the 6 axes.
2. **Accepted findings**: each in delegate grammar, `MUST-FIX` first. Accepted findings only — filter out passing axes, clean areas, and praise.
3. **Next steps**: prioritized follow-up fixes citing `<file>:L<line>`.
4. **Adjudication note**: one line summarizing rejected/downgraded counts and dispute resolutions (omit when all findings were accepted without dispute).

**Done when:** accepted fixes are applied and recorded, `## Review Findings & Resolutions` is updated with this round's adjudications, and the user report is delivered with provider prefix.
