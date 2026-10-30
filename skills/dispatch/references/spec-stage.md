# Governing spec operation

Use for design, plan, implement and every review kind. Ask needs no spec. The [spec template](templates/spec.md) owns format; [review rules](review-rules.md#intent-and-findings) owns intent adjudication.

## Resolve and author

Follow a supplied plan or design's Parent pins to the governing spec; an increment plan follows its design. An explicit review spec must agree with settled governing intent. Otherwise reuse the single session spec. Investigate ambiguity before selecting a file.

When a verb needs a new spec, including `review` when no spec exists, use this sequence:

1. **Ground.** Ground the domain under [grounding guidance](grounding.md) before intent refinement. Derive explorer questions from the request. Propose no solution, scope or option before grounding completes.
2. **Critique and refine.** For `plan`, `design`, or an `implement` that authors its plan or design, critique the request against grounded facts before detailed questions; skip it for `review` without a spec. Check four lenses: **problem** (the right problem or a symptom), **approach** (a simpler path or an existing mechanism), **scope** (trim or split independent subsystems), **cost and risk** (dependencies, compatibility and user-gate effects). Present an alternative only when it is materially better on a lens and not worse on intent; otherwise state in one line that the premise holds, with the reason. When the host provides `grilling`, invoke it by name after grounding at every level and ask the critique as its first-round premise questions, each with a recommended answer. Use context maps or follow-up explorers for facts, not grilling subagents. Continue until no user decision is open; map its output into the canonical spec as best effort. If `grilling` is unavailable, carry the critique in the Confirm exchange and add no other clarification round.
3. **Author.** Write `<session>/<slug>.spec.md` from the full chat, grounding and grilling output. Preserve constraints, alternatives, rejected options and actual user decisions; label inferences as `(assumption)` constraints or put them in Open Questions. For each alternative you present, record a DEC with `Options`, `Rejected` and the user's actual quote. The user's choice governs; the critique alone never blocks progress. Lint the spec and resolve parse errors before downstream authoring. Preserve an existing canonical spec's path.
4. **Confirm.** In one exchange, present stated and assumed intent separately and recommend `plan` or `design` from the scope check; when `grilling` was unavailable, use grounded scope and present the critique in this Confirm exchange. Keep an explicit user verb unless that scope contradicts it; if so, explain and recommend the other verb. If the reply settles a presented alternative in this fallback, first update the canonical spec and its DEC with the user's actual quote, then lint the updated spec. If the reply changes intent beyond the presented alternative, follow the [revision protocol](#revision-protocol), which records the new confirmation; otherwise:

   Record the user's reply as a `confirm` ledger record with the spec hash ([toolkit](toolkit.md#confirm)) once, using the resulting hash if this fallback update ran, or the current spec hash otherwise. In this fallback, the reply is both the decision and confirmation, so add no extra exchange.

Direct other planning skills' output into this canonical owner. Merge stray material before removing it; deleting tracked work follows the user gate.

## Approval

Confirm new-spec intent at the end of [Resolve and author](#resolve-and-author), before planning. At medium and above, implementation uses one approval tuple for the current spec, plan and optional design hashes, with actual user words. Design approval precedes increment planning and is recorded with the first plan's tuple. At low, show governing artifacts in the report. Standalone review settlement does not add an approval gate. See [approval records](toolkit.md#approval).

## Run level

Preserve an explicit level. Otherwise, after the plan or design is authored and linted, propose a level with a reason and present it for user confirmation in the Plan or design approval Decision Frame. Record the selected level as an orchestrator `level` ledger entry before the first review so `review run` uses it. For design, set the level before design review and carry it to increment plans.

When review or implementation finds more complexity, raise the level up to `high` and record it in the ledger. Never lower it mid-run; `xhigh` and `max` require user selection. `ask` and standalone review resolve the level from explicit input, then the ledger, then `medium`. See the [level rubric](readme/configuration.md#understand-levels-and-pins).

## Readers and document layers

Spec owns intent, REQ acceptance, constraints and user DEC decisions. Design owns strategy, architecture and AD choices. Plan owns tactics, task paths, criteria and commands. Walkthrough owns delivered behavior, evidence, deviations and findings. Cite upstream IDs instead of restating their layer.

Authors, reviewers and writers read the whole governing spec. Writers also read shared plan context, their task, criteria and verification commands. Host rules govern first; the quality bar supplements them.

## Revision protocol

An intent edit requires a recorded user quote; record the decision in the spec, record a new `confirm` for the revised spec hash, and obtain a new approval tuple where applicable. Clarifications are orchestrator edits. Record the before/after hashes, classification, diff reference and rationale in a ledger edit record.

Edit canonical artifacts in place; continue with unaffected writers. Notify only affected writers through the implementation rules. Preserve candidates, live handles, evidence and review history. Update dependent intent references and verification obligations before their next use; report changes in walkthrough deviations.
