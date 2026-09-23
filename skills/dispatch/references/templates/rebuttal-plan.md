# Plan rebuttal block

Kind block for `rebuttal.md`.

- `<Plan Path>` — bounded review view path.
- `<Review Scope>` — supplied finding keys, optionally followed by `Plan lint warnings:` context.

## opener

Review only the supplied unsettled implementation-plan findings. An implementation plan details how the
requested features or increment are built: concrete files, symbols, step order, and exact
verification.

## context

- Plan view: <Plan Path>

## inspection

Read the packet and verify each claim against the plan view and cited repository evidence.

## notes

`Plan lint warnings:` in Scope are context, not findings.
