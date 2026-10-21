# Plan review prompt block

Kind block for `review-prompt.md`.

- `<Plan Path>` — path to the attached plan.
- `<Spec Path>` — path to the settled governing spec, or `None`.
- `<Spec Hash>` — settled spec hash, or `None`.
- `<Review Scope>` — preparation-supplied scope string: `Full review` on a first review. On a re-review, `Re-review round <n> (full artifact) — review the whole artifact; changed sections for context: <changed sections>`, or `Re-review round <n> (delta) — changed sections: <changed sections>`. An optional `Plan lint warnings:` suffix is read delegate context.

## opener

Review the implementation plan adversarially: challenge the requirement, its premise, and the plan.
An implementation plan is the lower-level plan for building the requested features or a
technical-design increment: concrete files and symbols, step order, error behavior, prerequisite
evidence, exact verification, and bounded blast radius. No code has been written yet; judge whether
executing the plan as written delivers the requirement.

## context

- Plan: <Plan Path>
- Spec Path: <Spec Path>
- Spec Hash: <Spec Hash>

## against

- Governing targets: every spec REQ and DEC for a standalone plan; inherited acceptance criteria and applicable REQs for an increment plan, using the approved design's increment mapping to check remaining coverage.
- Use the selected sections of the [quality bar](quality-bar.md) to judge those targets. Report unmet or contradicted intent as `intent` and a defect in the governing spec text as `spec` (locus `§ Spec: <heading>`), before other tags.
- The plan summary, success criteria and task graph.
- Attached "Approved technical-design context": the governed increment contract and acceptance criteria.

## inspection

Read the whole spec at Spec Path before inspection; use Spec Hash as its governing identity.
For a spec finding, use § Spec: <heading>.
Read the plan, named files, and adjacent interfaces or tests needed to verify a claim.
Check task-specific constraints (including rationale for non-obvious prerequisites), nested file ownership and each criterion's specific checks.
Use the authoritative plan and the full review history in the review log that its `## Review Findings & Resolutions` links. Consult raw provider output or journals
when missing evidence, an adjudication dispute or recovery requires it; follow
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
- `architecture`
- `decomposition`
- `operability`
- `testing`
- `usability`
- `standards`
- `adjacent`

## severity

In plan reviews, MUST means the plan as written cannot deliver its outcome or breaks a binding
constraint. A gap that the plan's own Verify gates would surface deterministically during
implementation, such as a fixture update or a test assertion, is SHOULD.

## budget

If unspecified, target `8 + proposed-change entries`, at most 24; on re-review count changed entries only.

## locus

§ <Plan heading>

## closing

Cite existing code as `path/to/file:L<line>` inside `defect`.
For an adjacent finding, use the nearest plan heading as locus.
