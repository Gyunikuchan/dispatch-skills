# Design review prompt block

Kind block for `review-prompt.md`: a technical-design review at high level, not file-by-file
implementation detail.

- `<Design Path>` — path to the attached technical design.
- `<Requirement>` — original user ask.
- `<Review Scope>` — full review or changed design sections, optionally followed by `Design lint warnings:` context.

## opener

Review the technical design adversarially at high level.

## context

- Design: <Design Path>
- Requirement: <Requirement>

## inspection

Inspect architecture, boundaries, interfaces, data flow, alternatives, security and operations,
migration and rollback, risk concentration, increment dependency-graph correctness, parallel
safety, and final integration. Verify repository feasibility without demanding file-by-file or
symbol-level implementation detail. Read the direct contracts needed to verify each claim. On
re-review, inspect changed sections and logged resolutions only. Stop at that blast radius.

## tags

Use these tags: `intent`, `scope`, `correctness`, `invariant`, `architecture`, `boundaries`,
`alternatives`, `interfaces`, `data-flow`, `security`, `operations`, `migration`, `rollback`,
`risk`, `dependency-graph`, `parallel-safety`, `integration`, `testability`, `simplicity`,
`standards`, or `adjacent`.

## budget

## locus

§ <Design heading>

## closing

Every finding needs a verifiable claim and exact `§ <Design heading>` locus. Cite repository code
inside `defect` when used. Omit praise and summaries.
