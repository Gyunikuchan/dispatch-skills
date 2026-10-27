# Design review prompt block

Kind block for `review-prompt.md`.

- `<Design Path>` — path to the attached technical design.
- `<Spec Path>` — path to the settled governing spec, or `None`.
- `<Spec Hash>` — settled spec hash, or `None`.
- `<Review Scope>` — full review or changed design sections, optionally followed by `Design lint warnings:` context.

## opener

Review the technical design adversarially: challenge the requirement, its premise, and the design.
A technical design is the higher-level architectural plan that breaks a large problem into smaller
increments, each later delivered through its own implementation plan. Review at that altitude:
raise architectural issues, and leave file-by-file and symbol-level detail to the plan reviews. No
code has been written yet.

## context

- Design: <Design Path>
- Spec Path: <Spec Path>
- Spec Hash: <Spec Hash>

## against

- Governing targets: every spec REQ and DEC, the design, and its per-increment acceptance criteria.
- Use the selected sections of the [quality bar](quality-bar.md) to judge those targets. Report unmet or contradicted intent as `intent` and a defect in the governing spec text as `spec` (locus `§ Spec: <heading>`), before other tags.

## inspection

Read the whole spec at Spec Path before inspection; use Spec Hash as its governing identity.
For a spec finding, use § Spec: <heading>.
Read the design and the direct repository contracts needed to verify a claim; verify feasibility
without demanding implementation detail.
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
- `architecture`
- `decomposition`
- `operability`
- `testing`
- `usability`
- `standards`
- `adjacent`

## severity

## budget

## locus

§ <Design heading>

## closing

Cite existing code as `path/to/file:L<line>` inside `defect`.
For an adjacent finding, use the nearest design heading as locus.
