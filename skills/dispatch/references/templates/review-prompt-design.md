# Design review prompt block

Kind block for `review-prompt.md`.

- `<Design Path>` — path to the attached technical design.
- `<Spec Path>` — path to the settled governing spec, or `None`.
- `<Spec Hash>` — settled spec hash, or `None`.
- `<Review Scope>` — preparation-supplied scope string: `Full review` on Round 1; on a rerun, `Full review — changed: <changed sections>; comparison: <sha256>` when the prior snapshot has changed sections, otherwise `Full review — comparison: <sha256>`; `Re-review round <n> (full|narrowed) — changed: <changed sections>; comparison: <prev>..<curr>` on Round <n> > 1 when sections changed, otherwise `Re-review round <n> (full|narrowed) — comparison: <prev>..<curr>`, optionally followed by `Design lint warnings:` context.
- `<Context Map>` — `Context Map:` bullet naming the session context map, or empty when the session has none.

## opener

Review the technical design adversarially: challenge the requirement, its premise, and the design.
Review the unimplemented architecture and its increments, each later delivered through an implementation plan. Raise architectural issues; leave file-by-file and symbol-level detail to plan reviews. Inspect the architecture critically; when the design is sound and no grounded defect exists, return `CLEAN` — a clean review on sound work is the expected high-signal outcome.

## context

- Design: <Design Path>
- Spec Path: <Spec Path>
- Spec Hash: <Spec Hash><Context Map>

## against

- Governing targets: every spec REQ and DEC, the design, and its per-increment acceptance criteria.
- Use the quality criteria below to judge those targets. Report unmet or contradicted intent as `intent` and a defect in the governing spec text as `spec` (locus `§ Spec: <heading>`), before other tags.

## inspection

Read the whole spec at Spec Path before inspection; use Spec Hash as its governing identity.
For a spec finding, use § Spec: <heading>.
Read the design and the direct repository contracts needed to verify a claim; verify feasibility
without demanding implementation detail.

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
