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

Judge quality using the selected sections of the [quality bar](quality-bar.md). The tags below classify findings; they do not add judging criteria.

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
- correctness: `correctness`, `domain-logic`, `invariant`, `runtime`, `type`
- robustness: `edge-case`, `partial-failure`, `race`
- security/resources: `security`, `auth`, `resource-leak`, `perf`
- compatibility: `compatibility`, `breaking`, `migration`
- simplicity: `shallow`, `seam`, `coupling`, `yagni`, `reuse`, `root-cause` — for `reuse`, cite an existing equivalent anchored on the new symbol, with the existing `path:L<line>` in `defect`
- tests/UX: `test-gap`, `test-leak`, `ui`, `a11y` — `test-gap`: missing seam or failure-mode coverage; `test-leak`: a retained test that fails the quality bar, with its remedy in `requiredChange` (tests owned only by `Retain: transient` criteria are trimmed after review and are not `test-leak`)
- standards: `standards` — violations of the host rule files above on changed lines; elsewhere, report as `adjacent`
- out of scope: `adjacent` — follow the shared Inspection rule; cite code at its real `path:L<line>` locus

## severity

## budget

If unspecified, target `8 + 2 × changed files`; on re-review count files changed since the prior
round only. Reuse searches do not count toward the target.

## locus

<relative-file>:L<line>

## closing

Anchor every in-scope finding on a line the diff adds or changes; a finding anchored anywhere else
is `adjacent`.
