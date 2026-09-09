# dispatch-code-review

Get a cross-agent second opinion on the changes you just made.

An external agent CLI inspects your working-tree diff across five axes and returns findings. Your orchestrating agent then verifies every finding against the cited lines, keeps what the code confirms, drops what it refutes, and escalates what it cannot settle.

The delegate's report is a **claim, not a verdict**. A reviewer reading a diff cold will flag things your codebase already handles; adjudication is what stops those reaching you.

## Install

```bash
npx skills add Gyunikuchan/dispatch-skills --skill dispatch-code-review
```

Requires the `dispatch` skill for the runner:

```bash
npx skills add Gyunikuchan/dispatch-skills --skill dispatch
```

## Usage

Ask your agent for a review once changes are in the working tree:

```
dispatch-code-review the current changes
```

```
Run dispatch-code-review, focus on the CPF allocation math and a11y
```

The agent resolves a walkthrough (orchestrator-supplied, platform-native, or bare `git diff`), populates the prompt template, dispatches read-only in the background, and reports back. Trailing words become the review's focus areas.

## The five axes

| Axis | Tags | Asks |
|------|------|------|
| Architecture & Module Design | `shallow` `deepen` `seam` `adapter` `test-leak` | Deep interfaces or shallow pass-throughs? Real seams or premature ports? |
| Correctness, Domain & Spec | `domain-drift` `unit` `math` `runtime` `type` `spec` | Sign conventions, unit alignment, unhandled branches, your repository's standards. |
| Simplicity & Anti-Bloat | `delete` `reuse` `native` `stdlib` `yagni` `root-cause` | Delete → reuse → stdlib → shortest diff. Fixed at the source or patched at call sites? |
| Security | `vuln` | High-confidence exploitable issues: injection, path traversal, escaping, secrets. |
| Web & UI Design | `layout` `a11y` `token` | Visual hierarchy, responsive layout, accessibility — when UI is touched. |

## Report format

The delegate returns a fixed skeleton, and every finding uses one grammar:

```
<file>:L<line> — <tag>: <defect> → <required change>
```

```markdown
## Verdict
Two blocking defects in the allocation path; the rest is sound.

## Axis Coverage
architecture: clean · correctness: 2 findings · simplicity: 1 finding
security: clean · ui: n/a

## MUST-FIX
src/domain/cpf.ts:L118 — unit: annual ceiling compared against a monthly wage → divide the ceiling by 12, or lift the wage to annual.
src/domain/cpf.ts:L204 — runtime: `tiers[0]` unguarded when the age falls below the lowest tier → return the floor tier explicitly.

## SHOULD-FIX
None.

## CONSIDER
src/features/plan/allocation-panel.tsx:L62 — reuse: reimplements `formatSgd` from shared/format → import it.

## Actionable Next Steps
1. Fix the unit mismatch at src/domain/cpf.ts:L118 and add a regression test.
2. Guard the tier lookup at src/domain/cpf.ts:L204.
```

`## Axis Coverage` exists so a skipped axis is visible: without it, "no security findings" and "never looked at security" read identically.

## Adjudication

Your orchestrator reads the cited lines and assigns one verdict per actionable claim:

| Verdict | Criterion |
|---------|-----------|
| **Accept** | Code confirms the defect and its stated impact |
| **Reject** | Cited code contradicts the claim, the line does not exist, or the fix is already present |
| **Downgrade** | Real but trivial — style, taste, or speculative |
| **Disputed** | Hinges on intent, an unverified external figure, or a convention cutting both ways |

Uncited, contradicted, or unverifiable claims are rejected.

**Evidence over votes.** When several delegates review the same change, findings dedupe to one per `<file>:L<line>` + claim and each is judged against the code. A finding the code confirms is accepted however few delegates raised it; a finding the code refutes is rejected even if every delegate raised it. Provider agreement is context, never evidence.

## Project conventions

The delegate reads your project's conventions directly from `AGENTS.md` / `CLAUDE.md` in the workspace and falls back to industry best practices. No setup needed — it reads your docs, not a variable you have to fill.

## Pairs with

- `dispatch` — the runner. Required.
- `dispatch-plan-review` — the same loop, before the code exists.
