# Governing spec operation

Use for design, plan, implement and every review kind. Ask needs no spec. The [spec template](templates/spec.md) owns format; [review rules](review-rules.md#intent-and-findings) owns intent adjudication.

## Resolve and author

Spec authoring follows the [authoring sequence](spec-authoring.md#resolve-and-author): ground, critique, author, and confirm. Confirmed specs proceed to the [scope round](grounding.md#scope-round) for standalone plans and designs.

## Approval

Confirm new-spec intent under [Resolve and author](#resolve-and-author) before planning. At medium and above, implementation needs the user [approval tuple](decision-frame.md#user-gate-boundaries). Design approval precedes increment planning and is recorded with the first plan's tuple. At low, show governing artifacts in the report. Standalone review settlement does not add an approval gate. See [approval records](toolkit.md#approval).

## Run level

Preserve an explicit level. Otherwise, after the plan or design is authored and linted, propose a level with a reason and present it for user confirmation in the Plan or design approval Decision Frame. Record the selected level as an orchestrator `level` ledger entry before the first review so `review run` uses it. For design, set the level before design review and carry it to increment plans.

When review or implementation finds more complexity, raise the level up to `high` and record it in the ledger. Never lower it mid-run; `xhigh` and `max` require user selection. `ask` and standalone review resolve the level from explicit input, then the ledger, then `medium`. See the [level rubric](readme/configuration.md#understand-levels-and-pins).

## Readers and document layers

Spec owns intent, REQ acceptance, constraints and user DEC decisions. Design owns strategy, architecture and AD choices. Plan owns tactics, task paths, criteria and commands. Walkthrough owns delivered behavior, evidence, deviations and findings. Cite upstream IDs instead of restating their layer.

Authors, reviewers and writers read the whole governing spec. Writers also read shared plan context, their task, criteria and verification commands. Host rules govern first; the quality bar supplements them.

## Revision protocol

An intent edit requires a recorded user quote; record the decision in the spec, record a new `confirm` for the revised spec hash, and obtain a new approval tuple where applicable. Clarifications are orchestrator edits. Follow the [toolkit edit contract](toolkit.md#edit) for canonical hashes, diff references, rationale and confirmed pre-bind revision order.

Bind spec/design before recording design revisions; when a plan exists, bind the complete spec/plan/design set. Edit canonical artifacts in place and append an `edit` ledger record for each revision that admits a validated bound edit chain; for a confirmed standalone spec revision that cannot, use the [note fallback](toolkit.md#note), which grants no edit or approval authority; continue with unaffected writers. Notify only affected writers through the implementation rules. Preserve candidates, live handles, evidence and review history. Update dependent intent references and verification obligations before their next use; report changes in walkthrough deviations.
