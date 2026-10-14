# Review rules

Owning plans, designs and walkthroughs retain complete structured findings, required changes, dispositions, sources, duplicate relations and exact recorded rulings inline. A missing ruling means no rationale was recorded. Accepted obligations belong in governing design/plan sections. Reviews without an owning artifact use a complete standalone report; owned reviews produce no separate rendered report. Preserve prior history and retained evidence. Consult raw provider output or journals when missing evidence, disputed adjudication or recovery requires it; review history never replaces source inspection. Standalone reports lead with the recorded summary and an action overview from unresolved dispositions and failed coverage; neither an empty findings list nor a missing action proves approval or complete coverage.

[Dispatch](..) owns `start review`, `send`, and eight awaits. Reviews apply fixes only with `--fix`. The driver records findings in the owning design, plan, or walkthrough's `## Review Findings & Resolutions`, preserving prior runs; reviews without an owning document use a standalone report.

Review prompt context composes two channels: semantic intent prioritizes explicit `--context` (or distilled chat intent/deviations), falling back to Git commit log (`git log --format="%s%n%b" <range>`) for commit ranges and defaulting to `Review the selected changes.`; structural baseline prioritizes explicit governing paths, discovering unique `<slug>.plan.md` and `<slug>.walkthrough.md` in active `sessionDir` and leaving ambiguous or absent deliverables as `None`.

Verify findings against source and governing outcomes. Accept demonstrated defects regardless of votes; reject unsupported claims with evidence. Recorded user decisions govern until new defects warrant reopening.

## Intent and findings

Read `data.findingsPath` when present; use inline `data.findings` otherwise. The file contains the current round's full findings; inline summaries identify them.

Rule intent with `needs-user`, `{ ruling: accept|reject, quote: <user words> }`, or `{ ruling: accept|reject, by:orchestrator, reason: <settled decision> }`. The orchestrator route requires a nonblank reason citing the settled decision. Use the user gate (`needs-user` or a user quote) for changed intent, a new external dependency or runtime prerequisite, or discarded work.

## Review provenance and applicability

Findings and rulings retain the actual reviewed revision and scope, including in-flight results whose live target changed after launch. Changes attach advisory review observations; they do not supersede findings, invalidate accepted fixes, launch another review or consume a round. See [change handling](change-handling.md) for write boundaries.

At a review await, select applicability with `REVIEW_USE`. Bind `observationId` and `afterHash`, give a rationale, and choose `reuse`, `targeted` (with `paths`) or `full`. Omission permits the normal reply. The rendered history separates original coverage from host applicability; reuse never claims those newer bytes were reviewed.

```json
{"type":"REVIEW_USE","observationId":"change-1","afterHash":"current-revision","action":"reuse","rationale":"Only the report title changed."}
```

Only launched review waves consume rounds. Selected targeted/full review keeps earlier findings and rulings. A targeted wave reviews the selected paths, including unchanged paths, together with required fix and dispute continuation coverage. A required full wave retains full coverage. The configured cap and existing MUST/delta/disputes continuation policy remain; at exhaustion report retained findings and unresolved coverage through the existing escalation choices.

## Rulings and fix scope

Rounds policy owns threshold, cap, MUST continuation, convergence, affinity, and full/delta/disputes-only scope. Beyond the cap, fixed MUST findings continue through delta review; pending rejected MUST findings continue through disputes-only review. Follow `data.scope` and its conditional `data.continuationReason`; continuation does not raise the cap.

Reply to every pending finding through the frame's `events` envelope. Rejection and downgrade rulings require a nonblank reason. Locus paths are suggestions: declare complete source, test, fixture, helper, and generated edit scope before `RULINGS` in `fix.affectedPaths`, including outputs verification regenerates. Receipt paths do not extend that scope. Send `RULINGS` before editing the reviewed target; edit only in the fix turn. When the user reverses an accepted finding before `FIXES_APPLIED`, list it in its applied cluster's `withdrawn: [{ findingId, quote }]`; it is recorded as rejected, not fixed. In plan reviews, downgrade a MUST to SHOULD when the plan's own Verify gate would surface the gap during implementation; the reason names that gate. Rejections carry reasons forward; omission closes them only after usable responsible-source or substitute coverage. Missing coverage fails by name. Below-threshold closure requires host evidence. Cap-ending fixes may be `fixedUnreviewed`; never claim another review occurred. Later rounds show reviewers the settled rulings; a finding that re-raises a settled point without new evidence is ruled `reject` with a reason citing the settled finding ID.

If edits already preceded `RULINGS`, the driver admits them as a pending fix only in `--fix` mode when every pending finding is accepted, the complete changed-path delta stays within accepted fix scope, and comparison identity is unchanged. The reviewed baseline stays bound; `FIXES_APPLIED` checks those edits again before verification. Other changes follow [change handling](change-handling.md).

`FIXES_APPLIED` admits only the applied clusters' authorized paths; failed clusters grant no edit scope. Comparison identity changes or edits outside that scope stop the fix before verification. Code verification can regenerate declared paths in the applied scope. If successful verification changes that candidate, retain the new scoped candidate and repeat verification within the existing attempt budget; complete only after a successful pass leaves it unchanged. Keep the reviewed baseline bound until then. Artifact parsing grants no additional edit scope. Ordinary target drift outside fix admission remains advisory under [change handling](change-handling.md).

For an authorized `--fix` run, ruling metadata names `affectedPaths`, `dependsOn`, and `verification`. Apply only accepted bounded clusters. Host acceptance of an in-scope `CONSIDER` finding with nonempty `affectedPaths` supplies opt-in. Remaining accepted `CONSIDER` findings without paths, accepted adjacent findings, and unresolved `needs-user` `CONSIDER` findings are offered through the user opt-in decision; adjacent work requires explicit user selection. Unselected findings remain recorded; the driver lists accepted adjacent findings as follow-ups. Report relevant unselected concerns with their disposition. One parser handles native/provider reports; refusal, truncation, empty output, missing coverage, and loose loci trigger fallback per [providers](providers.md); a nonempty tag outside the kind's vocabulary keeps an otherwise valid report usable: its finding arrives as category `uncategorized` with the sanitized reviewer tag as `originalTag`, stays in scope outside the intent gate, and takes an ordinary ruling. Malformed or missing fields, including an empty tag, still fail per providers. Runs that already failed on an unknown tag stay failed; recovery is not retroactive.

Failed apply or verification attempts consume cluster budgets. Aggregate verification defects charge each applied cluster once; pending apply failures retain their remaining budgets. Mark fixes complete only after verification passes. Exhaustion stops selected fixes, including opt-in fixes, names unresolved work, and retains verified fixes.
