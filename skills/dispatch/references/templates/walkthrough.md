# Walkthrough template

Toolkit report tools render these walkthrough fields. See [review rules](../review-rules.md) for findings and resolution records.

````markdown
# <task title>

> **Delivered:** <what changed, in one sentence>
>
> **Spec:** <spec path> · <spec hash>
>
> **Plan:** <plan path>
>
> **Status:** <satisfied>/<total> SC satisfied (verified <n> · manual <n> · waived <n>)
>
> **Deviations:** none

## At a Glance
- **Delivered:** <same delivered sentence as the summary box>
- **Criteria:** <satisfied>/<total> satisfied (verified <n> · manual <n> · waived <n> · missing <n>)
- **Changes:** <n> files (<n> new · <n> modified · <n> deleted)
- **Deviations:** <n> recorded edits · <n> unplanned paths
- **Follow-ups:** <n> open escalations · <n> deferred rulings
- **Review:** <n> findings (<n> open)

## Changes Made

Changed 1 files; expand for file paths and task owners.

<details>
<summary>1 files (0 new · 1 modified · 0 deleted)</summary>

#### [MODIFY] `<relative-path>`

- Changes: <task ID> — <task title>

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

Findings: <recorded findings path>
````

## Field notes

- Human layout: apply the [quality bar's authoring rules](quality-bar.md#spec). At a Glance repeats the delivered sentence and reports toolkit counts in the shown order.
- Callouts: the renderer emits at most one `> [!IMPORTANT]` for open escalations needing a user decision, then at most one `> [!NOTE]` listing missing, manual or waived criteria, unplanned paths, recorded deviations and deferred rulings when present. Callouts sit after At a Glance bullets and contain no machine fields.
- Collapsed changes: use the rendered file count as `<summary>`. Keep tags on separate lines, with blank lines after `</summary>` and before `</details>` for Markdown rendering. Empty Changes Made is `None.` without wrappers.

- Changes Made: every reported path, action and owning task; an unowned path has Changes `unplanned`.
- Verification: separate Verified, Manual and Waived sections; include Missing only when criteria lack evidence. Each nonempty section holds SC and Evidence columns; an empty section is `None.`.
- Review Findings & Resolutions: rendered by toolkit report tools from recorded findings and rulings. The table shows review, finding, round, severity, ruling and reason; recorded findings paths follow it. Before any review: `*No reviews conducted yet.*`.
- Status: verified, manual and waived criteria count as satisfied; missing criteria do not.
- Deviations & Follow-ups: `- Deviation: …` and `- Follow-up: …` bullets (unapplied SHOULD / CONSIDER, reasoned), or `None.`. The Deviations box counts recorded edits. Unplanned paths also appear in this section.

- User-Attributed Records: recorded user decisions, waivers and evidence, or `None.`.
- Retain the Verification sections and recorded evidence; link evidence only when a recorded artifact exists. Omit optional empty prose within required sections. Use no fixed word limit or second authored summary.
