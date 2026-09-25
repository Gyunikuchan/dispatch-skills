# Review finding priority and round triggers

## Purpose and current behavior

The user wants reviewers to apply MUST/SHOULD/CONSIDER consistently without weakening evidence-based adjudication or causing unnecessary review rounds. Today the shared delegate prompt lists the three labels but defines no classification rubric. `review/report.mjs` validates membership in the label set, not meaning. The host verifies claims and may relabel them. The driver treats accepted in-scope MUST/SHOULD as fixable under `--fix`, requires confirmation for rejected or downgraded MUST/SHOULD when consensus is enabled, and currently starts a new review round for either MUST or SHOULD within the initial round cap.

## Decisions and behavior

- Severity is **resolution priority**, not a proxy for confidence or impact alone. Every reported finding must have a verifiable locus, a concrete defect and consequence, and a required change; classification never substitutes for evidence.
- **MUST:** a verified defect blocks the promised outcome or violates a binding requirement or repository constraint. An outstanding MUST may start another review round; at the cap it retains the existing extension-or-user-ruling path.
- **SHOULD:** a verified defect warrants resolution but does not itself block the promised outcome or violate a binding constraint. An outstanding SHOULD requires adjudication, but never *by itself* starts another review round, including before the initial cap. Where edits are authorized and the host accepts the defect, fix it promptly; where the host refutes it, record the evidence and obtain citing-source confirmation under consensus; where the host cannot decide, escalate to the user. An accepted SHOULD in a report-only review is reported as work needed, without code edits.
- **CONSIDER:** optional advice, subject to the orchestrator's evidence-based adjudication. It is host-final and neither requires a fix nor starts another round.
- These labels apply across code, plan, and design reviews. The orchestrator owns verification, acceptance, rejection, downgrading, and escalation; delegates supply claims. Accepted adjacent findings stay follow-ups outside the main fix scope. The label does not override `--fix`, approved implementation write boundaries, or previously approved decisions.

## Design

Place one compact rubric in the shared delegate prompt (`skills/dispatch/references/templates/review-prompt.md`) so every review kind sees identical definitions; keep kind-specific tags and loci in the existing blocks. Put the matching host-facing decision rule in `skills/dispatch/references/review.md`, with a concise instruction at the adjudication branch if needed so the host sees it when ruling. Keep the report JSON schema unchanged: `severity`, `locus`, `tag`, `defect`, and `requiredChange` remain the fields. The parser validates shape and allowed labels only; neither it nor the driver infers truth from text.

In `skills/dispatch/scripts/driver/review-phase.mjs`, change the within-cap round trigger so an outstanding SHOULD alone does not launch another review. Preserve MUST cap extension, consensus rebuttal for rejected/downgraded MUST/SHOULD, change-triggered review after authorized fixes, and the existing fix queue for accepted in-scope MUST/SHOULD. In particular, the driver must not silently mark a disputed or unconfirmed SHOULD settled: unresolved claims still take the rebuttal/user-ruling path. Report-only reviews preserve the no-edit boundary.

## Verification

Use existing test infrastructure; no dependencies or report-schema migrations. Cover the shared prompt's generated content and delegate labels, host relabeling and fix queue, rejected/downgraded SHOULD confirmation with consensus, accepted SHOULD under `--fix` versus report-only, and round boundaries: SHOULD-only requires no new round; MUST still triggers review and cap extension; changes caused by fixes still trigger verification review. Run focused tests, then `npm test`; regenerate skill hashes if required. Check host-facing and delegate-facing descriptions for semantic consistency.

## Scope and rollback

Only the shared prompt, shared review reference, review driver's round decision (and any directly related human guidance), and focused tests should change. No new label, JSON field, persistent log format, external dependency, or change to adjacent-finding scope. Rollback restores the previous prompt/reference and driver trigger; existing logs remain parseable throughout.
