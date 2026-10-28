# Governing spec operation

Use for design, plan, implement and every review kind. Ask needs no spec. The [spec template](templates/spec.md) owns format; [review rules](review-rules.md#intent-and-findings) owns intent adjudication.

## Resolve and author

Follow a supplied plan or design's Parent pins to the governing spec; an increment plan follows its design. An explicit review spec must agree with settled governing intent. Otherwise reuse the single session spec. Investigate ambiguity before selecting a file.

When none exists, author `<session>/<slug>.spec.md` from the full chat and inspected artifacts. Preserve constraints, alternatives, rejected options and actual user decisions; label inferred requirements. Lint the spec and resolve parse errors before downstream authoring. Preserve an existing canonical spec's path.

Before authoring a spec, design or plan, ground any domain that needs many files read using [grounding guidance](grounding.md).

Direct other planning skills' output into this canonical owner. Merge stray material before removing it; deleting tracked work follows the user gate.

## Approval

Confirm new-spec intent with the user before planning. At medium and above, implementation uses one approval tuple for the current spec, plan and optional design hashes, with actual user words. Design approval precedes increment planning and is recorded with the first plan's tuple. At low, show governing artifacts in the report. Standalone review settlement does not add an approval gate. See [approval records](toolkit.md#approval).

## Readers and document layers

Spec owns intent, REQ acceptance, constraints and user DEC decisions. Design owns strategy, architecture and AD choices. Plan owns tactics, task paths, criteria and commands. Walkthrough owns delivered behavior, evidence, deviations and findings. Cite upstream IDs instead of restating their layer.

Authors, reviewers and writers read the whole governing spec. Writers also read shared plan context, their task, criteria and verification commands. Host rules govern first; the quality bar supplements them.

## Revision protocol

An intent edit requires a recorded user quote; record the decision in the spec and obtain a new approval tuple where applicable. Clarifications are orchestrator edits. Record the before/after hashes, classification, diff reference and rationale in a ledger edit record.

Edit canonical artifacts in place; continue with unaffected writers. Notify only affected writers through the implementation rules. Preserve candidates, live handles, evidence and review history. Update dependent intent references and verification obligations before their next use; report changes in walkthrough deviations.
