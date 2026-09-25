# Walkthrough template

Strict rendering of the [minimum walkthrough contract](../review.md#minimum-walkthrough-contract).

````markdown
# Walkthrough — <Goal Description>

> **TL;DR:** <what changed>
> **Status:** 0/1 SC passing
> **Deviations:** none

## Changes Made

### <Component Name>
- **[NEW]** `<relative-path>` — Purpose and interface.
- **[MODIFY]** `<relative-path>` — Changes and preserved invariants.
- **[DELETE]** `<relative-path>` — Removed symbols.

## Verification & Validation
### Automated Tests
- Command: `<test command>` — exit <status>; results.
### Manual Verification
- Per `verify`/`review` criterion: class, revision, scenario/result, limitations.

## Outcome Traceability
| SC | Behavior | Production path | Evidence |
| --- | --- | --- | --- |
| SC1 | <delivered observable behavior> | `<relative-path>` | <fresh record> |

## Key Deviations
None.

## Review Findings & Resolutions
<!-- Populated during code review cycles -->
<!-- Rounds use the source-map and entry format in dispatch references/review.md § Resolution log. -->
*No reviews conducted yet.*

## Follow-ups
None.
````

## Field notes

- Status: passing rows (Evidence not `Pending`, `Deferred to final gate`, or missing validated) over criteria. Plan-less: traceability `None — no governing plan.`, Status `n/a`.
- Deviations: one-line summary unless Key Deviations is `None.`.
- Follow-ups: unapplied SHOULD / CONSIDER items, reasoned.
