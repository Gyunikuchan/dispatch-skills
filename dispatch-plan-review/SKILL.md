---
name: dispatch-plan-review
description: Review an implementation plan through external agent CLIs before code is written, then adjudicate returned claims. Use when a plan needs a second opinion before implementation.
---

# dispatch-plan-review

6-axis review of an implementation plan **before** any code is written, executed by an external agent CLI through the `dispatch` skill.

The delegate's report is a **claim, not a verdict**. The orchestrator adjudicates every finding against the requirement and the host repository's rules before it reaches the user or the plan.

## Process

### 1. Assemble context and dispatch

Attach the plan file plus any user-specified files with `-f "<path>"`, forward slashes throughout.

Populate the template variables:

- `<Plan Path>` — path to the attached plan.
- `<Requirement>` — the original user ask, verbatim.
- `<User Focus Areas>` — trailing user arguments, or `General review`.

**Dispatch**: when an orchestrating skill supplies the dispatch invocation, use it — it owns fan-out breadth and provider pinning. Otherwise dispatch yourself, **backgrounded**, and yield the turn; see the `dispatch` skill for the cascade, flags, and log monitoring. Dispatch is structurally read-only — delegates cannot modify the workspace.

#### Prompt template

````markdown
Review an implementation plan across six axes. No code has been written yet — judge the plan, not a diff.

### Context & Objective
- Plan: <Plan Path>
- Original Requirement: <Requirement>
- Review Focus: <User Focus Areas>

Adhere to this project's conventions (read `AGENTS.md` / `.claude/CLAUDE.md` from the workspace) and industry best practices.

### Instructions

#### 1. Ground the Plan
1. Read the attached plan in full.
2. Bounded reads: open only the files the plan's Change Set names, in targeted line ranges (`limit` < 80), to confirm the plan matches the code as it exists.
3. Complete grounding within 4 tool turns, then emit the report immediately.

#### 2. Six-Axis Evaluation
- **Requirement Traceability** (`traceability`): Every stated requirement maps to a change in the Change Set, and every change maps back to a requirement. Flag unmet requirements and unrequested scope. Check the plan's stated assumptions against the requirement — an assumption that contradicts the ask is a defect.
- **Approach Correctness** (`approach`): Does the plan respect the project's conventions (from `AGENTS.md` / `.claude/CLAUDE.md`) and industry best practices? Where the plan asserts an external rule, figure, or standard, does it cite an authority or silently invent one?
- **Blast Radius & Reversibility** (`blast-radius`): What else touches the code being changed? Flag changes to persisted schema, serialization aliases, or shared URL state that lack a backward-compatibility story. Flag anything hard to undo once shipped.
- **Testability & Success Criteria** (`testability`): Is each success criterion checkable, and does a named test prove it? Flag criteria that can only be confirmed by eyeballing, and criteria with no test.
- **Simplicity & YAGNI** (`simplicity`): Is there a materially shorter plan that meets the same criteria? Prefer, in order: delete the need, reuse an existing helper, use stdlib or a native platform feature, then write new code. Flag speculative generality, premature abstraction, and new dependencies.
- **Edge Cases & Failure Modes** (`edge-case`): Empty, zero, negative, and boundary inputs; unhandled union branches; partial failure and error propagation. Flag what the plan leaves unaddressed.

#### 3. Report Output

Write every finding as one line in this grammar:

```
## <Section> — <tag>: <defect> → <required change>
```

`<Section>` is the plan heading the finding lands on; `<tag>` is the axis tag above. Cite `path/to/file.ext:L<line>` inline when a finding rests on existing code.

Structure your review as:
- `## Verdict`: One line — is this plan safe to implement as written?
- `## Axis Coverage`: One line per axis — `<axis>: clean` or `<axis>: <n> finding(s)`. Every axis appears, so a skipped axis is visible.
- `## MUST-FIX`: Findings that block implementation, or "None."
- `## SHOULD-FIX`: Weaknesses worth correcting first, or "None."
- `## CONSIDER`: Optional improvements, or "None."
- `## Shorter Path`: The materially simpler plan if one exists, or "None — the plan is already minimal."
````

**Done when:** the plan is attached, the prompt is populated, and the dispatch is launched backgrounded with the turn yielded.

---

### 2. Adjudicate each actionable claim

Adjudicate only claims that ask for a change — defects, cuts, recommendations. Drop passing axes, clean verdicts, and praise on sight; verifying them costs tokens and they never reach the report.

Ground truth for a plan claim is the **requirement plus the host repository's rules**. A claim resting on existing code is additionally verified against the cited `<file>:L<line>`.

| Verdict | Criterion | Action |
|---------|-----------|--------|
| **Accept** | The requirement or a repository rule confirms the defect | Fold into the plan per Step 3 |
| **Reject** | The plan or the cited code contradicts the claim, the section does not exist, or the change is already planned | Drop silently; do not relay |
| **Downgrade** | Real but trivial — style, taste, or speculative | Fold into Out of Scope or drop |
| **Disputed** | Unsettleable from the plan alone: hinges on intent, an unverified external figure, or a deliberate trade-off | Escalate below |

Classify uncited, contradicted, or unverifiable claims as **Reject**.

**Escalate disputes** via interactive question tool (`ask_question` / `AskUserQuestion`) before writing any **Disputed** finding into the plan. One question per dispute (batch up to 4); quote the plan section under dispute, state the delegate's claim and your counter-reading. Offer accept / reject / defer. Apply the user's decision verbatim; treat decided disputes as final.

Escalate rather than guess when the dispute touches a domain authority the repository names as ground truth, persisted schema or shared URL state, or a change the user explicitly asked for.

**Done when:** every actionable claim carries a verdict and every dispute is ruled on by the user.

---

### 3. Fold accepted findings into the plan and report

Accepted `MUST-FIX` items are **edited into the plan file** before implementation begins — the plan on disk is the artifact the implementer reads, so a finding that lives only in the report has not been applied. `SHOULD-FIX` and `CONSIDER` items are folded in, or recorded under the plan's **Out of Scope** section with a reason.

Report to the user, prefixed by provider (use the label from the dispatch result), including the session deep-link or resume command when available:

1. **Verdict**: one line — is the plan safe to implement as amended?
2. **Accepted findings**: each in the delegate's grammar, with where it landed in the plan.
3. **Next steps**: anything deferred to Out of Scope, prioritized.
4. **Adjudication note**: one line — count of rejected or downgraded findings, plus how the user resolved any dispute. Include only when findings were rejected, downgraded, or disputed.

**Done when:** the plan file reflects every accepted finding, and the report is delivered with the provider prefix.
