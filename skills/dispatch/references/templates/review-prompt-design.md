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

- First check that every governing spec REQ is met, no DEC is contradicted, and no premise is flawed.
  Report unmet intent, spec ambiguity, contradiction, or a missing constraint as `intent-gap` before other tags.
- The design and its per-increment acceptance criteria.

Apply the selected quality bar to these governing targets.

## inspection

Read the whole spec at Spec Path before inspection; use Spec Hash as its governing identity.
For a spec finding, use § Spec: <heading>.
Read the design and the direct repository contracts needed to verify a claim; verify feasibility
without demanding implementation detail.
Read the full review history in the review log that each governing artifact's `## Review Findings & Resolutions` links. Consult raw provider output or journals
when missing evidence, disputed adjudication or recovery requires it; follow
`references/review-rules.md` for ownership and ruling semantics. History does not replace source inspection.

## tags

- intent gap: `intent-gap`
- intent: `intent`, `scope`
- architecture: `architecture`, `boundaries`, `interfaces`, `data-flow`
- decisions: `alternatives`, `simplicity`
- invariants: `correctness`, `invariant`
- risk and operations: `security`, `operations`, `risk`, `migration`, `rollback`
- decomposition: `dependency-graph`, `parallel-safety`, `integration`
- verification: `testability`
- standards: `standards`
- out of scope: `adjacent`

## severity

## budget

## locus

§ <Design heading>

## closing

Cite existing code as `path/to/file:L<line>` inside `defect`.
