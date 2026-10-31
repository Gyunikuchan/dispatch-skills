# Review rules

Preserve complete findings, sources, required changes, duplicate relations, reviewed revision, scope and rulings in linked review artifacts. The toolkit regenerates each bound plan or design's findings section after every completed review round and ruling, with a link to each round's full findings. Walkthroughs render their findings summary from the ledger. Keep resolution rationale in ruling records; do not edit generated sections. Standalone reviews retain a complete report. Consult raw provider output when evidence is disputed; a summary never replaces source inspection.

Review prompts carry the settled governing spec path and hash. Plan and design review prompts also name the session context map as a pre-change index when it exists; code review prompts never receive it, because the pre-change map is stale for code. Every reviewer reads the whole spec. Inspect the relevant host standards and [quality bar](templates/quality-bar.md); the [shared review prompt](templates/review-prompt.md) owns adjacent discovery.

## Intent and findings

Read the full result file before adjudication. Check intent and spec findings first against REQs and DECs. Use spec for defects in governing text and testing for missing verification coverage. Verify every claim against current source and governing outcomes; accept demonstrated defects regardless of vote counts.

A settled DEC may resolve an intent claim autonomously: cite it in the rationale. For changed intent, a new external dependency/runtime prerequisite or discarded work, use the [user gate](decision-frame.md#user-gate-boundaries). Record changed intent through [spec operation](spec-stage.md#revision-protocol).
For an accepted unrequested-behaviour `intent` finding, the orchestrator removes the behaviour; keeping it changes intent and requires a recorded user quote through the [user gate](decision-frame.md#user-gate-boundaries).

## Review provenance and applicability

Keep the actual reviewed revision and scope. After edits, choose continued review coverage from changed paths, accepted fixes and disputed claims; do not imply that a previous review covered newer bytes. Preserve earlier findings and rulings. A failed provider or missing coverage remains visible.

Level policy selects roster and round caps. The cap bounds quality rounds. An accepted MUST fix or a pending MUST rejection earns continuation past the cap. Recurrence and rejection escalations stop non-converging loops.

After round 1, `review run` sets the round roster at round start. It launches the full configured roster when the previous completed round has an accepted MUST, or an accepted SHOULD from a round below the cap. Otherwise it launches one target: the first non-reserve slot of the previous round's saved roster; configured reserves stay as fallbacks. Slots that own pending MUST rejection requests stay assigned.

For the final completed review round at or above the configured cap, apply accepted SHOULD findings from that round and record each correction with its current verification. This also covers the final round after a MUST-driven continuation. These fixes need no review solely for themselves; keep the completed review as the reviewed baseline and report corrections as verified but not re-reviewed. Use this exception only for recorded fixes of accepted SHOULD findings from that round; unrelated edits and unverified fixes require review. Accepted MUST fixes still require review, and pending MUST rejections still require confirmation. CONSIDER handling is unchanged.

## Rulings and fix scope

Append a ledger `ruling` record with subject `review:<review>:<finding>` and `ruling` set to `accepted`, `rejected`, `duplicate` or `deferred`, and evidence-backed rationale. Use the review identifier and finding ID from the result. Reject a repeated settled claim without new evidence by citing the prior ruling.

A rejected MUST remains pending until each original logical source slot, or its configured reserve/native substitute, explicitly agrees with an evidence-backed rationale. For a tool-only finding, use the first non-reserve reviewer in its original saved roster; if none exists, stop with `review-confirmation-required`. The next review sends each slot its own captured requests. Missing, malformed, failed or unattributed replies leave rejection pending; omission from ordinary findings is not agreement. SHOULD and CONSIDER rejections need no confirmation.

A second consecutive explicit disagreement, or a second consecutive completed round past the cap without a valid attributed reply from an assigned source for a pending rejection, opens `rejection:<review>:<finding>` and blocks review launches in that series. Count no-response attempts per original finding and assigned logical source across target and ruling edits. Agreement resets the disagreement count; a valid reply resets only that source's no-response count. Failed replies reset neither count, and target/rationale edits do not resolve escalation.

Escalate through the [Decision Frame](decision-frame.md#review-escalation); retain the user decision evidence in a resolved escalation ledger record before retrying. Resolution re-arms confirmation, retains the disagreement count, and starts a new bounded no-response attempt. The next explicit disagreement can reopen escalation. Accepting the finding for repair removes the rejection obligation.

Delivery and report completion require confirmed applicable MUST rejections. Bound plan/design and current integration-base reviews retain obligations across content edits and disabled phases. Duplicate rulings cannot close a pending original. Later target edits do not reopen a confirmed unchanged ruling. Rejection of the same finding under a new ruling needs fresh confirmation.

Apply accepted fixes directly within governing scope. Identify every source, test, fixture, helper and generated path needed before editing. Verify fixes and record the resulting evidence. Resolve related findings as a coherent change; dependency ordering must follow actual interfaces. For a defective predicate, fix the predicate so every failing state passes; do not patch only the listed case.

Adjacent work and optional findings need user opt-in when outside approved scope; preserve unselected findings as follow-ups. In-scope acceptance supplies opt-in only for the selected bounded work. A recurring finding after an accepted fix escalates through the [Decision Frame](decision-frame.md#review-escalation).

Malformed, empty, truncated or refused provider reports use [provider fallback](providers.md). Unknown nonempty tags remain usable as uncategorized with originalTag; do not silently drop their claims. A failed fix or failed check stays open with logs and options.
