# Review rules

Preserve complete findings, sources, required changes, duplicate relations, reviewed revision, scope and rulings in linked review artifacts. The toolkit regenerates each bound plan or design's findings section after every completed review round and ruling, with a link to each round's full findings. Walkthroughs render their findings summary from the ledger. Keep resolution rationale in ruling records; do not edit generated sections. Standalone reviews retain a complete report. Consult raw provider output when evidence is disputed; a summary never replaces source inspection.

Review prompts carry the settled governing spec path and hash. Plan and design review prompts also name the session context map as a pre-change index when it exists; code review prompts never receive it, because the pre-change map is stale for code. Every reviewer reads the whole spec. Inspect the relevant host standards and [quality bar](templates/quality-bar.md); the [shared review prompt](templates/review-prompt.md) owns adjacent discovery.

## Intent and findings

Read the full result before adjudication. Check intent and spec findings first against REQs and DECs. Use spec for governing-text defects and testing for missing verification. Verify every claim against current source and governing outcomes; accept demonstrated defects regardless of vote counts. Locate a finding marked `unresolved-locus:` from its defect text before ruling; it never matches by location. Rate findings with the shared [severity rubric](templates/review-severity.md). Reject a maintainability or performance finding against a writer-reported shortcut after verifying its stated limit, citing the report, unless the expected load crosses that limit. A shortcut that removes a simplicity-floor protection is a defect, not a shortcut.

A settled DEC may resolve an intent claim autonomously: cite it in the rationale. For changed intent, a new external dependency/runtime prerequisite or discarded work, use the [user gate](decision-frame.md#user-gate-boundaries). Record changed intent through [spec operation](spec-stage.md#revision-protocol).
For an accepted unrequested-behaviour `intent` finding, the orchestrator removes the behaviour; keeping it changes intent and requires a recorded user quote through the [user gate](decision-frame.md#user-gate-boundaries).

## Review provenance and applicability

Retain reviewed revision, scope, findings, rulings and failed or missing coverage. After edits, choose continued coverage from changed paths, accepted fixes and disputed claims; never attribute newer bytes to an earlier review.

Level policy selects roster and round caps. The cap bounds quality rounds; every round saves the round-1 cap, so a later level change moves neither the cap nor the ceiling. An accepted MUST fix or a pending MUST rejection earns continuation past the cap up to the ceiling: the round-1 cap + 2 + 2 per user-resolved grant. A `review-ceiling` refusal opens `ceiling:<review>:<ceiling>` and blocks new rounds until a user-quoted resolution records `re-author:`, `model-effort:` or `relax-split:` for 2 more rounds, or `defer:` for no rounds (plan and design only, and only with no pending MUST rejection). Route that refusal through the [review escalation Decision Frame](decision-frame.md#review-escalation) and preserve its resolution record. Result and status `budget` reports the saved cap, ceiling and whether the next round would be admitted, using the launch policy; reporting a boundary opens no escalation and grants no admission or resolution, and an unruled MUST is not an accepted continuation. Recurrence and rejection escalations stop non-converging loops.

After round 1, `review run` sets the round roster at round start. It launches the full configured roster when the previous completed round has an accepted MUST, or an accepted SHOULD from a round below the cap. Otherwise it launches one target: the first non-reserve slot of the previous round's saved roster; configured reserves stay as fallbacks. Label a re-review `(full)` when selection keeps the configured primary roster, or `(narrowed)` when it selects the previous round's first target. In a `code-integration` review, an open slot replaces that target and the label is `(coverage)`; see [failed-slot coverage](#failed-slot-coverage). All completed forms satisfy delivery identity. Slots that own pending MUST rejection requests stay assigned and do not change the primary-roster label.

For the final completed review round at or above the configured cap, apply accepted SHOULD findings from that round and record each correction with its current verification. This also covers the final round after a MUST-driven continuation. These fixes need no review solely for themselves; keep the completed review as the reviewed baseline and report corrections as verified but not re-reviewed. A finding corrected from a higher rating to CONSIDER counts as SHOULD here, because its fix stays required. Use this exception only for recorded fixes of accepted SHOULD findings from that round; unrelated edits and unverified fixes require review. Accepted MUST fixes still require review, and pending MUST rejections still require confirmation. CONSIDER handling is unchanged.

### Failed-slot coverage

Worktree reviews keep their failed-slot handling. A failed plan or design slot at the cap gets no extra round; its reduced coverage goes in the approval [Decision Frame](decision-frame.md), where the user decides. The rest of this section applies to `code-integration` only: the toolkit derives coverage from saved rounds and user records; it writes nothing.

- **Open:** a logical slot that fails in any round is open, including when every slot of the round failed and no findings file exists. A later failure reopens a closed slot.
- **Closed:** the slot, or its reserve or native substitute, completes a round at whole-target scope (`Full review` or `(coverage)`). A changed-path completion does not close it; a later round that omits the slot does not close it.
- **Rerun:** a slot that failed again in a whole-target attempt after its first failure. A passing rerun closes the slot.

The `decision` follows from the open slots:

| Decision | Condition | Delivery |
| --- | --- | --- |
| `none` | No open slot, no incomplete round | Continues |
| `rerun` | An open slot has no rerun, or a round is incomplete | Refuses |
| `majority` | Every open slot has a rerun and more than half of the saved target slots completed | Continues; the walkthrough records the reduced coverage |
| `user` | Every open slot has a rerun and half or fewer of the target slots completed | Refuses until the user decides |

**Rounds.** A coverage round runs the open slots only, or the full roster when an accepted finding keeps it, at whole-target scope with configured reserve and native fallback. Past the cap, one coverage round is free per review when no accepted MUST or pending MUST rejection admits a round. A round that an accepted MUST or pending rejection admits is a normal continuation: it reruns open slots, uses no free round and needs no grant. An open-only coverage round or a narrowed round with every slot failed finalizes with no findings and counts as used; the next round takes the next number and reruns the open slots at whole-target scope. A full-roster round with every slot failed, including a full-roster coverage round, keeps its number for the retry. Coverage rounds stay within the ceiling. Their findings follow the ruling, MUST and final-round SHOULD rules. At decision `user`, coverage rounds stop, within the cap or past it, until the user records a grant.

**User decisions.** Present both options through the [review escalation Decision Frame](decision-frame.md#review-escalation): accept reduced coverage, or grant one more coverage round. Record each as a resolved `coverage:<review>:<key>` escalation by the user with a quote; the ledger refuses any other author. `accept: <slot>[, <slot>]*` covers the named open slots for failures recorded before it, at any time; a later failure reopens the slot. `grant: <reason>` stays usable until a coverage round consumes it.

**Enforcement.** `review run` refuses `coverage-decision` for the `user` case and the `requires-coverage-decision` budget state reports it. Past the ceiling, a slot at decision `rerun` or `user` gets the same refusal; only `accept:` settles it, because no round fits. `worktree deliver` refuses `coverage-required` at decision `rerun` or `user` and when coverage state cannot be read, before any caller write; an interrupted delivery recovers under existing rules. Verification of an accepted SHOULD fix refuses at decision `rerun` or `user` and on unreadable state; otherwise the last round may hold failed slots that are open or overridden. The walkthrough lists open slots, reduced coverage accepted under the majority rule, overridden slots with the user quote, and coverage rounds.

## Rulings and fix scope

Append a ledger `ruling` record with subject `review:<review>:<finding>` and `ruling` set to `accepted`, `rejected`, `duplicate` or `deferred`, and evidence-backed rationale. Use result review/finding IDs.

Correct a wrong rating on an `accepted` ruling with corrected `impact` and `trigger` under the same rubric; the rationale names each changed dimension. The fix stays required and no reviewer confirmation is needed. A current `critical` cannot be lowered by correction: use the rejection route. A correction to `critical` names the boundary crossed or the data lost in its rationale. A later ruling without values leaves the correction in force. A rejected finding takes the higher of its original and latest corrected severities. A downgrade appears in the walkthrough attention list. Reject repeated settled claims without new evidence by citing the prior ruling.

A rejected MUST remains pending until each original logical source slot, or its configured reserve/native substitute, explicitly agrees with an evidence-backed rationale. For a tool-only finding, use the first non-reserve reviewer in its original saved roster; if none exists, stop with `review-confirmation-required`. The next review sends each slot its own captured requests. Missing, malformed, failed or unattributed replies leave rejection pending; omission from ordinary findings is not agreement. SHOULD and CONSIDER rejections need no confirmation.

A second consecutive explicit disagreement, or a second consecutive completed round past the cap without a valid attributed reply from an assigned source for a pending rejection, opens `rejection:<review>:<finding>` and blocks review launches in that series. Count no-response attempts per original finding and assigned logical source across target and ruling edits. Agreement resets the disagreement count; a valid reply resets only that source's no-response count. Failed replies reset neither count, and target/rationale edits do not resolve escalation.

Escalate through the [Decision Frame](decision-frame.md#review-escalation); retain the user decision evidence in a resolved escalation ledger record before retrying. Resolution re-arms confirmation, retains the disagreement count, and starts a new bounded no-response attempt. The next explicit disagreement can reopen escalation. Accepting the finding for repair removes the rejection obligation.

Delivery and report completion require confirmed applicable MUST rejections. Bound plan/design and current integration-base reviews retain obligations across content edits and disabled phases. Duplicate rulings cannot close a pending original. Later target edits do not reopen a confirmed unchanged ruling. Rejection of the same finding under a new ruling needs fresh confirmation.

Apply accepted fixes directly within governing scope. Identify every source, test, fixture, helper and generated path needed before editing. Verify fixes and record the resulting evidence. Resolve related findings as a coherent change; dependency ordering must follow actual interfaces. For a defective predicate, fix the predicate so every failing state passes; do not patch only the listed case.

Adjacent work and optional findings need user opt-in when outside approved scope; preserve unselected findings as follow-ups. In-scope acceptance supplies opt-in only for the selected bounded work. A recurring finding after an accepted fix escalates through the [Decision Frame](decision-frame.md#review-escalation).

Malformed, empty, truncated or refused provider reports use [provider fallback](providers.md). Unknown nonempty tags remain usable as uncategorized with originalTag; do not silently drop their claims. A failed fix or failed check stays open with logs and options.
