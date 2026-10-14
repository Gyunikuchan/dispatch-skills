# Code review prompt block

Kind block for `review-prompt.md`.

- `<Task Summary>` — summary of the ask and the changes made.
- `<Walkthrough Path>` — path to the attached walkthrough.
- `<Plan Path>` — path to the attached plan, or `None`.
- `<Review Scope>` — preparation-supplied scope string: `Full review` on a first review. On a re-review, `Re-review round <n> — changed paths: <changed paths>; <range>`, or `Re-review round <n> — walkthrough body changed; review full selected range (<range>)`.

## opener

Review the implementation adversarially: challenge the requirement, the author's mental model, and
the diff. The implementation is complete: judge whether it delivers the original ask and meets its
success criteria well, not merely whether it matches the plan.

## context

- Task: <Task Summary>
- Walkthrough: <Walkthrough Path>
- Plan: <Plan Path>

## against

- The task, the plan's `## Success Criteria` (with no plan, the task alone), and the walkthrough's
  `## Verification` table: every criterion row demonstrably met by the diff and its tests. A goal
  missed or met only on paper, such as a test passing without exercising it, is `intent`.
- With a plan, an absent or unfilled table is a `test-gap`; a plan-less walkthrough carries only its `Final gate:` line.
- An attached "Approved technical-design context" section: the increment's acceptance criteria.

## inspection

Obey an explicit Git range in Scope. Otherwise inspect unstaged, staged, and untracked
source/text files, excluding `.scratch/`, generated, vendored, and binary paths. When those are
empty, use only the caller-supplied merge-base-to-`HEAD` range. Never substitute `HEAD~1`.
Inspect changed hunks plus adjacent call sites, interfaces, and tests needed to verify a claim.
Skip issues that configured linters, formatters, or type checkers enforce. For each new exported or
shared symbol, search the repository by name and behaviour for an existing equivalent; report a
match as `reuse` anchored on the new symbol, and cite the existing `path:L<line>` in `defect`.
Read the full review history in the review log that each governing artifact's `## Review Findings & Resolutions` links. Consult raw provider output or journals
when missing evidence, disputed adjudication or recovery requires it; follow
`references/review-rules.md` for ownership and ruling semantics. History does not replace source inspection.

## tags

- intent: `intent`, `scope-creep` — misses, misreads, or exceeds the ask
- correctness: `correctness`, `domain-logic`, `invariant`, `runtime`, `type` — domain rules and invariants; domain-valid formulas and algorithms; type-valid, domain-invalid states; sign, unit, and scale (monthly/annual, fraction/percent); off-by-one
- robustness: `edge-case`, `partial-failure`, `race` — boundary inputs; unhandled branches; unguarded indexing; partial updates; floating promises; races
- security/resources: `security`, `auth`, `resource-leak`, `perf` — injection, traversal, escaping, secrets, auth bypass; unchecked object ownership (IDOR); sensitive data in logs or errors; unclosed handles; unbounded memory/concurrency; blocked event loops; hot-path quadratics; N+1 queries; unpaginated reads; new filter or sort columns without an index
- compatibility: `compatibility`, `breaking`, `migration` — callers and serialized formats; migrations
- simplicity: `shallow`, `seam`, `coupling`, `yagni`, `reuse`, `root-cause` — pass-through modules; speculative seams (one adapter is hypothetical); delete, reuse, stdlib, then new code; shared root-cause fixes
- tests/UX: `test-gap`, `test-leak`, `ui`, `a11y` — observable outcomes at seams; missing failure-mode tests; `test-leak`: retained tests coupled to internals or duplicating seam coverage (tests owned only by `Retain: transient` criteria are trimmed after review and are not `test-leak`); retained tests that fail the durable bar in the plan template (implementation step, internals, no named regression, or redundant with another retained test), with `requiredChange` rewrite to meet it, demote to transient, or delete when redundant; test names, describe blocks, comments, section headers, or fixture names that reference plan artifacts (criterion, task, or finding IDs; plan or session paths); touched UI, a11y, CLI/API ergonomics
- standards: `standards` — violations of the host rule files above on changed lines; elsewhere, report as `adjacent`
- out of scope: `adjacent` — a concrete defect you meet outside Scope while inspecting; cite its real locus; spend no extra turns hunting

## severity

## budget

If unspecified, target `8 + 2 × changed files`; on re-review count files changed since the prior
round only. Reuse searches do not count toward the target.

## locus

<relative-file>:L<line>

## closing

Anchor every in-scope finding on a line the diff adds or changes; a finding anchored anywhere else
is `adjacent`.
