# Design rebuttal block

Kind block for `rebuttal.md`.

- `<Design Path>` — bounded design review view path.
- `<Review Scope>` — supplied finding keys, optionally followed by `Design lint warnings:` context.

## opener

Review only the supplied unsettled technical-design findings. A technical design fixes architecture
and increment decomposition; file-level detail belongs to later implementation plans.

## context

- Design view: <Design Path>

## inspection

Read the packet and verify each claim against the design view and cited repository evidence, at
the design's architectural altitude.

## notes

`Design lint warnings:` in Scope are context, not findings.
