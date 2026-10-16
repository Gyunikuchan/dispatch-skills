# Code review prompt block

Kind block for `review-prompt.md`.

- `<Task Summary>` — intent from the governing spec.
- `<Spec Path>` — path to the settled governing spec, or `None`.
- `<Spec Hash>` — settled spec hash, or `None`.
- `<Walkthrough Path>` — path to the attached walkthrough.
- `<Plan Path>` — path to the attached plan, or `None`.
- `<Review Scope>` — preparation-supplied scope string: `Full review` on a first review. On a re-review, `Re-review round <n> — changed paths: <changed paths>; <range>`, or `Re-review round <n> — walkthrough body changed; review full selected range (<range>)`.

## opener

Review the implementation adversarially: challenge the requirement, the author's mental model, and
the diff. The implementation is complete: judge whether it delivers the original ask and meets its
success criteria well, not merely whether it matches the plan.

## context

- Task: <Task Summary>
- Spec Path: <Spec Path>
- Spec Hash: <Spec Hash>
- Walkthrough: <Walkthrough Path>
- Plan: <Plan Path>

## against

- The governing spec's REQs and DECs, the plan's `## Success Criteria`, and the walkthrough's
  `## Verification` table: every criterion row demonstrably met by the diff and its tests. A goal
  missed or met only on paper, such as a test passing without exercising it, is `intent`.
- With a plan, an absent or unfilled table is a `test-gap`; a plan-less walkthrough carries only its `Final gate:` line.
- An attached "Approved technical-design context" section: the increment's acceptance criteria.

## inspection

Read the whole spec at Spec Path before inspection; use Spec Hash as its governing identity.

Obey an explicit Git range in Scope. Otherwise inspect unstaged, staged, and untracked
source/text files, excluding `.scratch/`, generated, vendored, and binary paths. When those are
empty, use only the caller-supplied merge-base-to-`HEAD` range. Never substitute `HEAD~1`.
Inspect changed hunks plus adjacent call sites, interfaces, and tests needed to verify a claim.
Read the full review history in the review log that each governing artifact's `## Review Findings & Resolutions` links. Consult raw provider output or journals
when missing evidence, disputed adjudication or recovery requires it; follow
`references/review-rules.md` for ownership and ruling semantics. History does not replace source inspection.

## tags

- intent: `intent`, `scope-creep` — misses, misreads, or exceeds the ask
- correctness: `correctness`, `domain-logic`, `invariant`, `runtime`, `type` — domain rules and invariants; domain-valid formulas and algorithms; type-valid, domain-invalid states; sign, unit, and scale (monthly/annual, fraction/percent); off-by-one
- robustness: `edge-case`, `partial-failure`, `race` — boundary inputs; unhandled branches; unguarded indexing; partial updates; floating promises; races
- security/resources: `security`, `auth`, `resource-leak`, `perf` — violations of the quality bar's security and resource rules
- compatibility: `compatibility`, `breaking`, `migration` — callers and serialized formats; migrations
- simplicity: `shallow`, `seam`, `coupling`, `yagni`, `reuse`, `root-cause` — pass-through modules; speculative seams (one adapter is hypothetical); departures from the quality bar's simplicity order; `reuse`: an existing equivalent found by the quality bar's search, anchored on the new symbol, with the existing `path:L<line>` in `defect`; shared root-cause fixes
- tests/UX: `test-gap`, `test-leak`, `ui`, `a11y` — `test-gap`: missing seam or failure-mode coverage; `test-leak`: retained tests that fail the quality bar's test or naming rules, with the bar's remedy as `requiredChange` (tests owned only by `Retain: transient` criteria are trimmed after review and are not `test-leak`); touched UI, a11y, CLI/API ergonomics
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
