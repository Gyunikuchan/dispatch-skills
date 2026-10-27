# Walkthrough template

Toolkit report tools render these walkthrough fields. See [review rules](../review-rules.md) for findings and resolution records.

````markdown
# <task title>

> **Delivered:** <plan At a Glance What, plan TL;DR, or integration status, in that order>
>
> **Integration:** <tasks integrated, source branch and ref>
>
> **Spec:** <spec path> · <spec hash>
>
> **Plan:** <plan path>
>
> **Status:** <satisfied>/<total> SC satisfied (verified <n> · manual <n> · waived <n>)
>
> **Deviations:** none

## At a Glance
- **Delivered:** <same delivered value as the summary box>
- **How it works:** <plan How it works text, when present>
- **Criteria:** <satisfied>/<total> satisfied (verified <n> · manual <n> · waived <n> · missing <n>)
- **Changes:** <n> files (<n> new · <n> modified · <n> deleted)
- **Deviations:** <n> recorded edits · <n> unplanned paths
- **Follow-ups:** <n> open escalations · <n> deferred rulings
- **Review:** <n> findings (<n> open)

## Changes Made

### T<n> — <task title>

- <plan behaviour bullets, or the Task Map Outcome>

<details>

#### [MODIFY] `<relative-path>`

- Changes: <task ID> — <task title>

</details>

### Unplanned changes

<details>

#### [MODIFY] `<relative-path>`

- Changes: unplanned

</details>

## Verification

### Verified
| SC | Evidence |
| --- | --- |
| SC1 | <eligible recorded evidence> |

### Manual
None.

### Waived
None.

### Missing
| SC | Evidence |
| --- | --- |
| SC2 | no eligible evidence |

## Deviations & Follow-ups
None.

## User-Attributed Records

None.

## Review Findings & Resolutions

| Review | ID | Round | Severity | Status | Ruling |
| --- | --- | --- | --- | --- | --- |
| <review ID> | R1-F001 | 1 | MUST | Accepted | <first ruling line> |

- Round 1 (<review ID>): 1 findings — [findings](<relative path>)
````

## Field notes

- Human layout: apply the [quality bar's authoring rules](quality-bar.md#spec). At a Glance repeats Delivered, shows How it works when the plan provides it, and reports toolkit counts in the shown order.
- Delivered: use the plan's At a Glance What, then its TL;DR, then the integration status. Put that value in the summary box and At a Glance; keep integration details on their separate box line.
- Callouts: the renderer emits at most one `> [!IMPORTANT]` for open escalations needing a user decision, then at most one `> [!NOTE]` listing missing, manual or waived criteria, unplanned paths, recorded deviations and deferred rulings when present. Callouts sit after At a Glance bullets and contain no machine fields.
- Changes Made: each task keeps behaviour visible and its reported paths, actions and owner inside a label-free `<details>` block. Unplanned paths have their own entry. Keep wrapper tags on separate lines with blank lines after the opening tag and before the closing tag. Empty Changes Made is `None.` without wrappers.

- Verification: separate Verified, Manual and Waived sections; include Missing only when criteria lack evidence. Each nonempty section holds SC and Evidence columns; an empty section is `None.`.
- Review Findings & Resolutions: toolkit renders the table and round links from findings and rulings. Each completed round, including CLEAN rounds with 0 findings, gets `- Round <n> (<review>): <k> findings — [findings](<relative path>)`. Show `*No reviews conducted yet.*` only before a round completes.
- Status: verified, manual and waived criteria count as satisfied; missing criteria do not.
- Deviations & Follow-ups: `- Deviation: …` and `- Follow-up: …` bullets (unapplied SHOULD / CONSIDER, reasoned), or `None.`. The Deviations box counts recorded edits. Unplanned paths also appear in this section.

- User-Attributed Records: recorded user decisions, waivers and evidence, or `None.`.
- Retain the Verification sections and recorded evidence; link evidence only when a recorded artifact exists. Omit optional empty prose within required sections. Use no fixed word limit or second authored summary.
