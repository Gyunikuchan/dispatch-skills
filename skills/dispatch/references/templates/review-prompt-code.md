# Code review prompt block

Kind block for `review-prompt.md`.

- `<Task Summary>` — intent from the governing spec.
- `<Spec Path>` — path to the settled governing spec, or `None`.
- `<Spec Hash>` — settled spec hash, or `None`.
- `<Plan Path>` — path to the attached plan, or `None`.
- `<Review Scope>` — preparation-supplied scope string: `Full review` on a first review. On a re-review, `Re-review round <n> — changed paths: <changed paths>; <range>`.

## opener

Review the implementation adversarially: challenge the requirement, the author's mental model, and
the diff. The implementation is complete: judge whether it delivers the original ask and meets its
success criteria well, not merely whether it matches the plan.

## context

- Task: <Task Summary>
- Spec Path: <Spec Path>
- Spec Hash: <Spec Hash>
- Plan: <Plan Path>

## against

- The governing spec's REQs and DECs and, when supplied, the plan's `## Success Criteria`:
  assess each applicable criterion from the selected diff and tests. A goal missed or met only
  on paper, such as a test passing without exercising it, is `intent`.
- Behaviour the diff adds that no REQ asks for at a consumer boundary (public API or CLI surface, outputs, persisted data, side effects, dependencies) is an `intent` finding; internal helpers and refactors are not.
- Code review does not establish that verification commands ran or final gates passed.
  Execution evidence and final verification remain separate workflow gates.
- With a plan, its `## Key Decisions & Context` entries are settled, like the spec's DECs. Do not
  propose an alternative to a settled decision as a fix; report a contradiction with one only as
  `intent`, and cite the decision in `defect`.
- An attached "Approved technical-design context" section: the increment's acceptance criteria.

Judge quality using the selected sections of the [quality bar](quality-bar.md).
Anchor reuse findings on the new symbol and cite the existing equivalent as `path:L<line>` in `defect`. Reuse searches do not count toward the target.
Anchor a code `spec` finding on the changed code line and cite `§ Spec: <heading>` in `defect`.

## inspection

Read the whole spec at Spec Path before inspection; use Spec Hash as its governing identity.

Obey an explicit Git range in Scope. Otherwise inspect unstaged, staged, and untracked
source/text files, excluding `.scratch/`, generated, vendored, and binary paths. When those are
empty, use only the caller-supplied merge-base-to-`HEAD` range. Never substitute `HEAD~1`.
Inspect changed hunks plus adjacent call sites, interfaces, and tests needed to verify a claim.
On a `Full review`, when the diff changes a shared invariant, contract, or signature, list every
caller of it and inspect each one in this round, so later rounds do not find them one at a time.
Use the repository's code-graph index (for example CodeGraph callers) when one exists; otherwise
search the repository.
Read the full review history in the review log that each governing artifact's `## Review Findings & Resolutions` links. Consult raw provider output or ledger records
when missing evidence, disputed adjudication or recovery requires it; follow
`references/review-rules.md` for ownership and ruling semantics. History does not replace source inspection.

## tags

- `intent`
- `spec`
- `correctness`
- `reliability`
- `security`
- `performance`
- `compatibility`
- `maintainability`
- `operability`
- `testing`
- `usability`
- `standards`
- `adjacent`

## severity

## budget

## locus

<relative-file>:L<line>

## closing

Anchor every in-scope finding on a line the diff adds or changes; a finding anchored anywhere else
is `adjacent`.
For an `adjacent` finding, cite code at its real `path:L<line>` locus.
