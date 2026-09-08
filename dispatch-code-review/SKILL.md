---
name: dispatch-code-review
description: Review session changes through external agent CLIs across architecture, domain, simplicity, security, and UI, then adjudicate returned claims. Use when changes need a cross-agent second opinion.
---

# dispatch-code-review

5-axis review (Architecture, Domain, Simplicity, Security, UI) of recent session changes, executed by an external agent CLI through the `dispatch` skill.

The delegate's report is a **claim, not a verdict**. The orchestrator adjudicates every finding against the active codebase before it reaches the user.

## Process

### 1. Assemble context and dispatch

Attach a walkthrough of the change with `-f "<path>"`, forward slashes throughout. Resolve it in order:

1. **Orchestrator-supplied walkthrough** when an orchestrating skill hands one over — use it rather than authoring a duplicate.
2. **Platform-native walkthrough** when the orchestrator's platform produces one (Antigravity writes `<appDataDir>/brain/<conversation-id>/walkthrough.md`).
3. **No artifact** — the delegate works from `git diff` alone; write `<Task Summary>` inline and set `<Artifacts List>` to `None`.

Add any user-specified files, then populate the template variables:

- `<Task Summary>` — summary of the user request and the changes made.
- `<Artifacts List>` — attached artifact paths, or `None`.
- `<User Focus Areas>` — trailing user arguments, or `General review`.

**Dispatch**: when an orchestrating skill supplies the dispatch invocation, use it — it owns fan-out breadth and provider pinning. Otherwise dispatch yourself, **backgrounded**, and yield the turn; see the `dispatch` skill for the cascade, flags, and log monitoring. Reviews are read-only — omit `--allow-write`.

#### Prompt template

````markdown
Evaluate recent session changes across five axes.

### Context & Objective
- Task Summary: <Task Summary>
- Attached Artifacts: <Artifacts List>
- Review Focus: <User Focus Areas>

Adhere to this project's conventions (read `AGENTS.md` / `.claude/CLAUDE.md` from the workspace) and industry best practices for code quality.

### Instructions

#### 1. Inspect Changes
1. Run `git status --short` to identify modified files. The changes under review are usually **uncommitted**: inspect both unstaged (`git diff`) and staged (`git diff --staged`) work. Fall back to `git diff HEAD~1` only when the working tree is clean.
2. Batch inspect targeted diffs in 2–4 commands: `git diff --staged -- <path1> <path2>` (and `git diff --` for unstaged).
3. Bounded reads: read specific line ranges (`limit` < 80) for adjacent hunk context; keep full files out of context.
4. Complete all inspection within 4 tool turns, then emit the report immediately.

#### 2. Five-Axis Evaluation
- **Architecture & Module Design** (`shallow`, `deepen`, `seam`, `adapter`, `test-leak`):
  - *Depth & Leverage*: Small interfaces hiding deep logic vs shallow pass-through modules. High leverage for callers, locality for maintainers.
  - *Seams & Adapters*: One adapter = hypothetical seam; two adapters = real seam. Avoid premature ports/indirection. Internal seams stay private to their module.
  - *Dependency Tiers*: In-process (merge & test direct), Local-substitutable (in-memory stand-in), Remote owned (ports & adapters with injected transport), True external (mock adapter).
  - *Test Surface*: Assert observable outcomes at interface seams; flag tests coupling to private internals.
- **Correctness, Domain & Spec** (`domain-drift`, `unit`, `math`, `runtime`, `type`, `spec`):
  - *Domain Realism*: Adversarial audit against domain authorities in the project (named in `AGENTS.md` / `.claude/CLAUDE.md`). Challenge model assumptions; flag states that are representable in code but impossible in the real world, or that skip a real-world prerequisite.
  - *Domain & Math*: Sign conventions (inflow/outflow), unit alignment (monthly/annual, fraction/percentage), and formula accuracy.
  - *Runtime & Concurrency*: Off-by-one errors, unhandled union branches, unguarded indexing (`arr[0]`), floating promises, and state mutations.
  - *Standards & Spec*: Layering, typing, validation, and logging rules from the project config, plus industry standards and task scope fidelity.
- **Simplicity & Anti-Bloat** (`delete`, `reuse`, `native`, `stdlib`, `yagni`, `root-cause`):
  - *The Ladder*: (1) YAGNI / delete unneeded code, (2) reuse codebase helpers/types, (3) stdlib and native platform features over custom logic/dependencies, (4) shortest working diff.
  - *Root Cause*: Fix at shared source rather than scattering call-site patches.
- **Security** (`vuln`): High-confidence exploitable vulnerabilities (injection, path traversal, escaping, secrets).
- **Web & UI Design** (`layout`, `a11y`, `token`): Visual hierarchy, responsive layout, and a11y compliance (if UI touched).

#### 3. Report Output

Write every finding as one line in this grammar:

```
<file>:L<line> — <tag>: <defect> → <required change>
```

`<tag>` is one of the axis tags above. Every finding, assertion, violation, recommendation, and code snippet carries a concrete path and line number.

Structure your review as:
- `## Verdict`: One line — ship readiness and overall health across the 5 axes.
- `## Axis Coverage`: One line per axis — `<axis>: clean` or `<axis>: <n> finding(s)`; `<axis>: n/a` only for UI when no UI was touched. Every axis appears, so a skipped axis is visible.
- `## MUST-FIX`: Defects and vulnerabilities that block shipping, or "None."
- `## SHOULD-FIX`: Real weaknesses worth correcting now, or "None."
- `## CONSIDER`: Optional improvements and high-yield cuts, or "None."
- `## Actionable Next Steps`: Prioritized follow-ups citing target locations.
````

**Done when:** the walkthrough tier is resolved, the prompt is populated, and the dispatch is launched backgrounded with the turn yielded.

---

### 2. Adjudicate each actionable claim

Adjudicate only claims that ask for a change — defects, cuts, vulnerabilities, recommendations. Drop passing axes, clean verdicts, and praise on sight; verifying them costs tokens and they never reach the report.

Ground truth for a code claim is the cited `<file>:L<line>`. Read it plus enough surrounding context to judge, then assign one verdict:

| Verdict | Criterion | Action |
|---------|-----------|--------|
| **Accept** | Code confirms the defect and its stated impact | Carry into the report |
| **Reject** | Cited code contradicts the claim, the line does not exist, or the fix is already present | Drop silently; do not relay |
| **Downgrade** | Real but trivial — style, taste, or speculative | Fold into next steps or drop |
| **Disputed** | Unsettleable from the code alone: hinges on intent, an unverified external figure, a deliberate trade-off, or a convention cutting both ways | Escalate below |

Verify every claim against the cited lines before accepting. Classify uncited, contradicted, or unverifiable claims as **Reject**.

**Evidence over votes** when several delegates report on the same change: dedupe to one finding per `<file>:L<line>` + claim, then judge each against the code. Accept a finding the code confirms regardless of how many delegates raised it; reject one the code refutes even if every delegate raised it. Provider agreement is context, never evidence.

**Escalate disputes** via interactive question tool (`ask_question` / `AskUserQuestion`) before writing any **Disputed** finding into the report. One question per dispute (batch up to 4); state the delegate's claim, your counter-reading, and cite `<file>:L<line>`. Offer accept / reject / defer to follow-up. Apply the user's decision verbatim; treat decided disputes as final.

Escalate rather than guess when the dispute touches a domain authority the repository names as ground truth, persisted schema or shared URL state, or a change the user explicitly asked for.

**Done when:** every actionable claim carries a verdict and every dispute is ruled on by the user.

---

### 3. Report

Prefix by provider (use the label from the dispatch result), including the session deep-link or resume command when available:

1. **Verdict**: one line — ship readiness and health across the 5 axes.
2. **Accepted findings**: each in the delegate's grammar, `MUST-FIX` first. Accepted findings only — filter out passing axes, clean areas, and praise.
3. **Next steps**: prioritized follow-up fixes citing `<file>:L<line>`.
4. **Adjudication note**: one line — count of rejected or downgraded findings, plus how the user resolved any dispute. Include only when findings were rejected, downgraded, or disputed.

**Done when:** the report is delivered with the provider prefix, carrying accepted findings only.
