# dispatch-plan-review

Get a second opinion on an implementation plan **before** any code is written.

An external agent CLI reviews the plan across six axes and returns findings. Your orchestrating agent then adjudicates every finding against the requirement and your repository's rules, folds what survives into the plan file on disk, and escalates what it cannot settle.

The delegate's report is a **claim, not a verdict** — that separation is the point. A reviewer without your context will confidently flag things that are already handled; adjudication is what keeps those out of your plan.

## Install

```bash
npx skills add Gyunikuchan/dispatch-skills --skill dispatch-plan-review
```

Requires the `dispatch` skill for the runner:

```bash
npx skills add Gyunikuchan/dispatch-skills --skill dispatch
```

## Usage

Ask your agent for a plan review once a plan exists:

```
Review .scratch/plan/2026-09-08-cpf-allocation.md with dispatch-plan-review
```

```
dispatch-plan-review on the current plan, focus on backward compatibility
```

The agent attaches the plan, populates the prompt template, dispatches read-only in the background, and reports back. Trailing words become the review's focus areas.

## The six axes

| Axis | Tag | Asks |
|------|-----|------|
| Requirement Traceability | `traceability` | Does every requirement map to a change, and every change to a requirement? |
| Approach Correctness | `approach` | Does the plan respect your repository's rules and cite its authorities? |
| Blast Radius & Reversibility | `blast-radius` | What else touches this? What is hard to undo? |
| Testability & Success Criteria | `testability` | Is each criterion checkable, and does a named test prove it? |
| Simplicity & YAGNI | `simplicity` | Is there a materially shorter plan meeting the same criteria? |
| Edge Cases & Failure Modes | `edge-case` | Empty, zero, negative, boundary; unhandled branches; partial failure. |

## Report format

The delegate returns a fixed skeleton, and every finding uses one grammar:

```
## <Section> — <tag>: <defect> → <required change>
```

```markdown
## Verdict
Safe to implement once the two MUST-FIX items land.

## Axis Coverage
traceability: 1 finding · approach: clean · blast-radius: 1 finding
testability: 2 findings · simplicity: clean · edge-case: clean

## MUST-FIX
## Change Set — blast-radius: bumps PERSISTED_FORMAT_VERSION with no decoder for v3 payloads → add a v3→v4 migration path before the bump.

## SHOULD-FIX
## Success Criteria — testability: "allocation looks right" is not checkable → name the assertion and its fixture.

## CONSIDER
## Change Set — simplicity: new `AllocationVisitor` has one implementation → inline it until a second arrives.

## Shorter Path
None — the plan is already minimal.
```

`## Axis Coverage` exists so a skipped axis is visible: without it, "no findings on edge cases" and "never looked at edge cases" read identically.

## Adjudication

Your orchestrator assigns one verdict per actionable claim:

| Verdict | Criterion |
|---------|-----------|
| **Accept** | The requirement or a repository rule confirms the defect |
| **Reject** | The plan or cited code contradicts the claim, or it is already planned |
| **Downgrade** | Real but trivial — style, taste, or speculative |
| **Disputed** | Hinges on intent, an unverified external figure, or a deliberate trade-off |

Accepted `MUST-FIX` items are **edited into the plan file**, not just reported — the plan on disk is what the implementer reads. Disputes go to you before anything is written.

**Evidence over votes.** When several delegates review the same plan, findings dedupe to one per `## <Section>` + claim and each is judged against the requirement and repository rules. A finding confirmed by requirements or code is accepted however few delegates raised it; a finding refuted is rejected even if every delegate raised it. Provider agreement is context, never evidence.

## Project conventions

The delegate reads your project's conventions directly from `AGENTS.md` / `CLAUDE.md` in the workspace and falls back to industry best practices. No setup needed — it reads your docs, not a variable you have to fill.

## Pairs with

- `dispatch` — the runner. Required.
- `dispatch-code-review` — the same loop, after the code exists.
