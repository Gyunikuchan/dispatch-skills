# Walkthrough template

The driver renders these walkthrough fields. See [review rules](../review-rules.md) for findings and resolution records.

````markdown
# <task title>

> **Delivered:** <what changed, in one sentence>
>
> **Parent:** <plan path, or user request>
>
> **Status:** 0/1 SC passing
>
> **Deviations:** none

## Context
- Ask: <original request>
- Decisions: <choice> (user)
- Assumptions: <assumption>
- Out of scope: <excluded item>
- Focus: <review focus>

## Changes Made
- #### [MODIFY] `<relative-path>`
  - Changes: <what changed in this file>

## Verification
| SC | Outcome | Evidence |
| --- | --- | --- |
| SC1 | <delivered observable behavior> | <fresh record> |

Final gate: `<command>` exit <status>

## Deviations & Follow-ups
None.

## Review Findings & Resolutions
*No reviews conducted yet.*
````

## Field notes

- Context: only when Parent is `user request`; omit empty bullets. A plan or design parent already holds the context.
- Changes Made: every file changed in the session. Note precedence: writer `files[].note`, then the plan's Proposed Changes line, then `+N −M`; review fixes append `fixes <IDs>`.
- Verification: Evidence is `red→green` plus the command for red criteria, or `<class>; <scenario>; <result>` for verify/review. Plan-less: only the `Final gate:` line, Status `n/a`.
- Revision Log: `## Revision Log` before Review Findings & Resolutions, only when revisions occurred.
- Review Findings & Resolutions: driver-rendered and machine-managed.
- Status: passing rows (Evidence not `Pending`, `Deferred to final gate`, or missing validated) over criteria.
- Deviations & Follow-ups: `- Deviation: …` and `- Follow-up: …` bullets (unapplied SHOULD / CONSIDER, reasoned), or `None.`. The Deviations box is a one-line summary exactly when a `- Deviation:` bullet exists.

- Lead with delivered behavior and verification status. Keep file detail beneath its file entry; preserve existing multiline notes with indented continuations.
- Retain the Verification table, exact commands and recorded evidence; link evidence only when a recorded artifact exists. Omit optional empty prose within required sections. Use no fixed word limit or second authored summary.
