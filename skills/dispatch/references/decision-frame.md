# Decision Frame

Investigate before consulting the user. Present four parts:

1. **Conflict or blocker:** State the pending decision.
2. **Verified facts:** Cite inspected code, tests or artifacts.
3. **Recommendation:** Propose an action with technical rationale.
4. **Consequences:** Give trade-offs and the effect of alternatives.

## User Gate Boundaries

At medium and above, implementation approval is one approval tuple of spec hash, plan hash and optional design hash, recorded with `by: "user"` and a verbatim quote. Waivers, manual completion and selection of xhigh/max also require verbatim user quotes.

Other user gates are changed intent or settled decisions, a suspected user mistake that changes the outcome, a new external dependency or runtime prerequisite, and discarded accepted work. Technical repairs, review adjudication and non-intent plan/design edits within approved scope are orchestrator decisions. Preserve evidence and continue independent work.

## Templates by trigger

Use the four-part format above with the following concrete content.

### Spec approval

Present the canonical path/hash, stated and assumed intent separately, core REQs, settled DECs, unresolved material questions and the `plan` or `design` recommendation from the scope check. Follow [spec confirmation](spec-stage.md#resolve-and-author) and [approval provenance](spec-stage.md#approval).

### Plan or design approval

Present current artifact paths/hashes, strategy, task or increment sequence, scope, verification and the proposed level with its reason under [Run level](spec-stage.md#run-level). Recommend the bounded unit and confirm the level. Explain delivery risk and alternatives. Record approval under [spec approval rules](spec-stage.md#approval) and the [tuple contract](toolkit.md#approval).

### Intent finding

Present the claim, governing REQs/DECs and inspected source. Recommend a settled-evidence rejection or a specific intent change. Explain scope and verification effects; follow [intent rulings](review-rules.md#intent-and-findings).

### Writer scope request

Present the needed paths, rationale, verified ownership and interface impact. Approve routine additive scope by editing the plan and notifying affected writers. Escalate only when a user gate applies; recommend a bounded alternative.

### Red baseline

Present exact failed commands, logs and root cause. Recommend repair, retained known failure or stop, with confidence limits. A known failure is not a pass or a criterion waiver.

### Failed task

Present the failed behavior, retained candidate, logs and verified cause. Recommend bounded repair, clarified scope, retry or stop. Preserve completed independent work; use [manual completion](toolkit.md#manual-complete) only with criterion evidence.

### Optional findings

Present bounded options, affected paths and benefits. Recommend which to select and explain cost or risk. Record unselected work as follow-up; user selection authorizes adjacent work.

### Concerns

Separate observed limitations from claims needing investigation. Present evidence, impact and a recommendation to repair, accept a bounded limitation or stop. Escalate only material intent decisions.

### Review escalation

Present the recurring finding, prior accepted fixes, inspected feasibility and remaining uncertainty. Recommend keeping, relaxing or splitting the requirement, with concrete alternatives. Intent changes follow [spec operation](spec-stage.md#revision-protocol).

A `review-ceiling` refusal is the ceiling branch of the [continuation rule](review-rules.md#review-provenance-and-applicability). Present the recurring findings, each prior accepted fix, and why that fix failed, verified against current artifacts. Recommend exactly one option from the evidence:

- Re-author the artifact from current knowledge under a different approach.
- Raise the level, or use a higher model or effort, for one more round.
- Relax or split the failing requirement.
- Defer remaining accepted MUST findings as follow-ups. Offer this only for plan and design reviews, and only when no MUST rejection is pending.

Record the user decision as a resolved ceiling escalation: `{kind: "escalation", by: "user", quote, key: "ceiling:<review>:<ceiling>:resolved", data: {id: "ceiling:<review>:<ceiling>", state: "resolved", summary: "<re-author|model-effort|relax-split|defer>: <evidence>"}}`. See the [escalation record](toolkit.md#escalation).
