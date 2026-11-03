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

- <Risk; one-line pointers to items needing human attention; authored focus bullets cite evidence.>

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

## Deviations & Follow-ups

- Deviation: <recorded plan edit and diff reference>
- Follow-up: <open escalation or follow-up>

## Review Findings & Resolutions

| Review | ID | Round | Severity | Source | Status | Ruling |
| --- | --- | --- | --- | --- | --- | --- |
| <review ID> | R1-F001 | 1 | MUST | <model/effort> | Accepted | <first ruling line> |

- Round <n> (<review ID>): <n> findings — [findings](<relative path>)

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

</details>
````

## Field notes

- Layout: follow the skeleton's section order and [authoring rules](quality-bar.md#spec); keep one Counts line.
- Visuals: copy only orientation visuals from plan At a Glance, or parent design visuals when the plan has none; task/section-local views are not collected. A recorded `focus.visual` replaces the entire set. Check copied visuals against delivered state and replace stale or misleading views through `focus.visual`. Distinguish proposed diagrams from observed delivery; cite actual before/after evidence when useful without inventing a baseline. Keep one-line text summaries with diagrams.
- Review Focus: after Risk, list open escalations, open findings, manual/waived/missing criteria, cap-ending SHOULD fixes verified without re-review or not verified, unplanned paths, rejected MUST/SHOULD findings, downgraded findings, and intent-class edits as one-line pointers to their owning sections. Keep authored `focus` bullets with evidence links. When no derived item applies, state on the Risk line that delivery matched the plan and all criteria are verified.
- Behaviour Changes: give each task its `### T<n> — <task title>` heading and visible behaviour bullets, followed by a label-free `<details>` block with compact `path · action` lines. Do not add per-file headings or repeat task titles. Put unplanned paths under Unplanned changes; omit empty entries.
- Verification: show one status line. Keep Manual, Waived and Missing criteria visible outside `<details>`; omit empty subsections. Keep verified evidence in the Appendix.
- Deviations & Follow-ups: list recorded edits with diff references, unplanned paths, cap-ending SHOULD fixes, open escalations and deferred rulings, or `None.`.
- Appendix: keep verified evidence, user-attributed records and quotes, and provenance with spec/plan paths, 12-character hashes, and integration source/ref. Keep wrapper tags on separate lines with blank lines after the opening tag and before the closing tag.
