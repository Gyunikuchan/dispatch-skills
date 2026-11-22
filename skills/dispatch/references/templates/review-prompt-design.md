# Design review prompt block

Kind block for `review-prompt.md`.

- `<Design Path>` — path to the attached technical design.
- `<Spec Path>` — path to the settled governing spec, or `None`.
- `<Spec Hash>` — settled spec hash, or `None`.
- `<Review Scope>` — preparation-supplied scope string: `Full review` on Round 1; on a rerun, `Full review — changed: <changed sections>; comparison: <sha256>` when the prior snapshot has changed sections, otherwise `Full review — comparison: <sha256>`; `Re-review round <n> (full|narrowed) — changed: <changed sections>; comparison: <prev>..<curr>` on Round <n> > 1 when sections changed, otherwise `Re-review round <n> (full|narrowed) — comparison: <prev>..<curr>`, optionally followed by `Design lint warnings:` context.
- `<Context Map>` — `Context Map:` bullet naming the session context map, or empty when the session has none.

## opener

Review the technical design adversarially: challenge the requirement, its premise, and the design.
Review the proposed architecture and its increments.

## context

- Design: <Design Path>
- Spec Path: <Spec Path>
- Spec Hash: <Spec Hash><Context Map>

## against

- Governing targets: every spec REQ and DEC, the design, and its per-increment acceptance criteria.
- Use the quality criteria below to judge those targets. Report unmet or contradicted intent as `intent` and a defect in the governing spec text as `spec` (locus `§ Spec: <heading>`), before other tags.

## inspection

For a spec finding, use § Spec: <heading>.
Read the design and the repository contracts needed to verify claims.
Treat increment `Grounding leads:` as advisory. Flag leads only if they conflict with a binding `REQ`, `DEC` or invariant, or are known dead ends. Leave lead investigation to increment grounding.

## severity

Feasibility and architectural contract defects are `blocks`.
Plan-level mechanics safely decidable during increment planning are out of altitude.

## budget

## locus

§ <Design heading>

## closing

Cite existing code as `path/to/file:L<line>` inside `defect`.
For an adjacent finding, use the nearest design heading as locus.
