# Walkthrough template

Toolkit report tools render this reviewer-first debrief. See [review rules](../review-rules.md) for findings and resolution records.

````markdown
# <task title>

## At a Glance

- **What:** <plan At a Glance What, or integration status>
- **Artifacts:** [spec](<relative href>) · [plan](<relative href>)[ · [design](<relative href>)]
- **Summary:** <satisfied>/<total> criteria satisfied · <n> files changed · <n> open findings · <n> deferred follow-ups

<details>
<summary>Detailed counts</summary>

- **Counts:** <satisfied>/<total> criteria (verified <n> · manual <n> · waived <n> · missing <n>); <n> files (<n> new · <n> modified · <n> deleted); <n> recorded edits; <n> unplanned paths; <n> open escalations; <n> deferred rulings; <n> deferred escalations; <n> findings (<n> open)

</details>

## Visuals

See [plan visuals](<relative href>#at-a-glance).

## Review Focus

- <Risk; one-line pointers to items needing human attention; authored focus bullets cite evidence.>

## Behaviour Changes

### T<n> — <task title>

- <Task Map outcome> ([plan task](<relative href>#<task heading slug>))

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

## Runtime Proof

Not recorded.

## Deviations & Follow-ups

- Follow-up: <open escalation or follow-up>

<details>
<summary>Deviations (<n>)</summary>

- Deviation: <recorded plan edit and diff reference>

</details>

## Review Findings & Resolutions

<n> findings across <n> rounds (<n> open)

- <coverage status, if applicable>

<details>
<summary>Findings table (<n>)</summary>

| Review | ID | Round | Severity | Source | Status | Ruling |
| --- | --- | --- | --- | --- | --- | --- |
| <review ID> | R1-F001 | 1 | MUST | <model/effort> | Accepted | <first ruling line> |

- Round <n> (<review ID>): <n> findings — [findings](<relative path>)

</details>

## Appendix

<details>

<summary>Audit records</summary>

### Provenance

- Spec: [<path>](<relative href>) · sha256:<12-character hash>
- Plan: [<path>](<relative href>) · sha256:<12-character hash>
- Design: [<path>](<relative href>) · sha256:<12-character hash> (when bound)
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

- Layout: follow the skeleton's section order and [authoring rules](quality-bar.md#spec). Keep one visible Summary line and one Counts line under Detailed counts.
- Visuals: render a recorded `focus.visual` replacement; otherwise link plan At a Glance visuals, or parent design visuals when the plan has none. State `None.` when neither has a visual. Task/section-local views are not collected. Check linked visuals against delivered state and replace stale or misleading views through `focus.visual`. Distinguish proposed diagrams from observed delivery; cite actual before/after evidence when useful without inventing a baseline. Keep one-line text summaries with diagrams.
- Review Focus: after Risk, list open escalations, deferred rulings and escalations, open findings, manual/waived/missing criteria, review fixes marked verified but not re-reviewed or not verified, unplanned paths, rejected MUST/SHOULD findings, downgraded findings, and intent-class edits as one-line pointers to their owning sections. Keep authored `focus` bullets with evidence links. When no derived item applies, state on the Risk line that delivery matched the plan and all criteria are verified.
- Behaviour Changes: give each task its `### T<n> — <task title>` heading and one visible Task Map outcome linked to its plan task, followed by a label-free `<details>` block with compact `path · action` lines. Do not add per-file headings or repeat task titles. Put unplanned paths under Unplanned changes; omit empty entries.
- Verification: show one status line. Keep Manual, Waived and Missing criteria visible outside `<details>`; omit empty subsections. Keep verified evidence in the Appendix.
- Runtime Proof: list the outcome, proved HEAD, reason, evidence links and later fixes.
- Deviations & Follow-ups: show open escalations, deferred rulings and deferred escalations first. Collapse recorded edits with diff references, unplanned paths, and review fixes with their status under Deviations when present. Use `None.` when both lists are empty.
- Review Findings & Resolutions: show the summary and coverage outside details. Collapse rows and round links under Findings table when rows exist. With no rows, keep round links or the no-review message visible.
- Appendix: keep verified evidence, user-attributed records and quotes, and provenance with linked spec, plan and bound design paths, 12-character hashes, and integration source/ref. Keep wrapper tags on separate lines with blank lines after the opening tag and before the closing tag.
