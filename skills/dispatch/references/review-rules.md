# Review rules

Preserve complete findings, sources, required changes, duplicate relations, reviewed revision, scope and rulings in linked review artifacts. Owning designs, plans and walkthroughs keep a compact findings summary with a link to full history. Standalone reviews retain a complete report. Consult raw provider output when evidence is disputed; a summary never replaces source inspection.

Review prompts carry the settled governing spec path and hash. Every reviewer reads the whole spec. Inspect the relevant host standards and [quality bar](templates/quality-bar.md); the [shared review prompt](templates/review-prompt.md) owns adjacent discovery.

## Intent and findings

Read the full result file before adjudication. Check intent and spec findings first against REQs and DECs. Use spec for defects in governing text and testing for missing verification coverage. Verify every claim against current source and governing outcomes; accept demonstrated defects regardless of vote counts.

A settled DEC may resolve an intent claim autonomously: cite it in the rationale. For changed intent, a new external dependency/runtime prerequisite or discarded work, use the [user gate](decision-frame.md#user-gate-boundaries). Record changed intent through [spec operation](spec-stage.md#revision-protocol).

## Review provenance and applicability

Keep the actual reviewed revision and scope. After edits, choose continued review coverage from changed paths, accepted fixes and disputed claims; do not imply that a previous review covered newer bytes. Preserve earlier findings and rulings. A failed provider or missing coverage remains visible.

Level policy selects roster and round caps. Follow the result's continuation and escalation state. A cap-ending fix remains unreviewed until another actual review covers it; do not invent coverage to close a finding.

## Rulings and fix scope

Append a ledger `ruling` record with subject `review:<review>:<finding>`, disposition `accepted`, `rejected`, `duplicate` or `deferred`, and evidence-backed rationale. Use the review identifier and finding ID from the result. Reject a repeated settled claim without new evidence by citing the prior ruling.

Apply accepted fixes directly within governing scope. Identify every source, test, fixture, helper and generated path needed before editing. Verify fixes and record the resulting evidence. Resolve related findings as a coherent change; dependency ordering must follow actual interfaces.

Adjacent work and optional findings need user opt-in when outside approved scope; preserve unselected findings as follow-ups. In-scope acceptance supplies opt-in only for the selected bounded work. A recurring finding after an accepted fix escalates through the [Decision Frame](decision-frame.md#review-escalation).

Malformed, empty, truncated or refused provider reports use [provider fallback](providers.md). Unknown nonempty tags remain usable as uncategorized with originalTag; do not silently drop their claims. A failed fix or failed check stays open with logs and options.
