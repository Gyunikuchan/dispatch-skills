# Walkthrough template

Toolkit report tools render this reviewer-first debrief. See [review rules](../review-rules.md) for findings and resolution records.

````markdown
# <task title>

## At a Glance
- **What:** <plan At a Glance What, or integration status>
- **How it works:** <plan How it works text, when present>
- **Counts:** <satisfied>/<total> criteria (verified <n> · manual <n> · waived <n> · missing <n>); <n> files (<n> new · <n> modified · <n> deleted); <n> recorded edits; <n> unplanned paths; <n> open escalations; <n> deferred rulings; <n> findings (<n> open)

## Visuals

<Plan visuals, or parent design visuals when the plan has none; a recorded replacement takes precedence. `None.` when no visual is available.>

## Review Focus

- <Risk and derived departures; authored focus bullets cite evidence. When Risk is the only derived item, state that delivery matched the plan and all criteria are verified.>

## Behaviour Changes

### T<n> — <task title>

- <observable behavior from this task>

<details>

- `<relative-path>` · <created | modified | deleted>
- `<relative-path>` · <created | modified | deleted>

</details>

### Unplanned changes

- <observable behavior, or None.>

<details>

- `<relative-path>` · <created | modified | deleted>

</details>

## Verification

- **Status:** <complete | exceptions recorded>

### Manual

- <SC> · <reason>

### Waived

- <SC> · <reason>

### Missing

- <SC> · <reason>

## Appendix

<details>

<summary>Audit records</summary>

### Provenance

- Spec: <path> · sha256:<12-character hash>
- Plan: <path> · sha256:<12-character hash>
- Integration: <source branch and ref>

### Verified Evidence

| SC | Evidence |
| --- | --- |
| SC<n> | <eligible recorded evidence> |

### User-Attributed Records

- <record with verbatim quote, or None.>

### Deviations & Follow-ups

- Deviation: <recorded plan edit and diff reference>
- Follow-up: <open escalation or follow-up>

### Review Findings & Resolutions

| Review | ID | Round | Severity | Status | Ruling |
| --- | --- | --- | --- | --- | --- |
| <review ID> | R1-F001 | 1 | MUST | Accepted | <first ruling line> |

- Round <n> (<review ID>): <n> findings — [findings](<relative path>)

</details>
````

## Field notes

- Layout: apply the [quality bar's authoring rules](quality-bar.md#spec). Order sections as What/How and one counts line, visuals, Review Focus, per-task Behaviour Changes, Verification, and the collapsed Appendix.
- What and How: use the plan's At a Glance What and How it works. If the plan has no What, use integration status.
- Counts: state criterion counts once, include changed-file counts, and list aggregate deviation and review counts on this one line.
- Visuals: copy all plan At a Glance visuals, or the parent design visuals when the plan has none. A recorded `focus.visual` replaces the copied visuals. Keep one-line text summaries with diagrams.
- Review Focus: list the plan Risk and any recorded edits, manual/waived/missing criteria, rejected or deferred findings, cap-ending SHOULD fixes verified without re-review, unplanned paths, open escalations or follow-ups, and authored `focus` bullets with evidence links. When Risk is the only derived item, state in one line that delivery matched the plan and all criteria are verified.
- Behaviour Changes: give each task its `### T<n> — <task title>` heading and visible behaviour bullets, followed by a label-free `<details>` block with compact `path · action` lines. Do not add per-file headings or repeat task titles. Put unplanned paths under Unplanned changes; omit empty entries.
- Verification: show one status line. Keep Manual, Waived and Missing criteria visible outside `<details>`; omit empty subsections. Keep verified evidence in the Appendix.
- Appendix: keep verified evidence, user-attributed records and quotes, deviations with diff references, the findings table and round links, and provenance with spec/plan paths, 12-character hashes, and integration source/ref. Keep wrapper tags on separate lines with blank lines after the opening tag and before the closing tag.
