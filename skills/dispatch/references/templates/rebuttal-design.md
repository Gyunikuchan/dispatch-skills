# Design rebuttal block

Kind block for `rebuttal.md`.

- `<Design Path>` — bounded design review view path.
- `<Review Scope>` — supplied finding keys, optionally followed by non-actionable `Design lint warnings:` context; respond only to supplied keys.

## opener

Review only the supplied unsettled design findings.

## context

- Design view: <Design Path>

## inspection

Read the packet and verify each claim against the design view and cited repository evidence, with
source-affine architectural reasoning.

## notes

Design-lint warnings in Scope are context only; respond to supplied finding keys and no others.
