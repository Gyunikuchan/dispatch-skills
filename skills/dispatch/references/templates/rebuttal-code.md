# Code rebuttal block

Kind block for `rebuttal.md`.

- `<Walkthrough Path>` — bounded walkthrough review view path.
- `<Plan Path>` — bounded plan review view path, or `None`.
- `<Review Scope>` — supplied finding keys only.

## opener

Review only the supplied unsettled code findings. The implementation is complete; judge each claim
against the diff and its recorded verification.

## context

- Walkthrough view: <Walkthrough Path>
- Plan view: <Plan Path>

## inspection

Read the packet and verify each claim against the walkthrough view and the cited changed code.

## notes
