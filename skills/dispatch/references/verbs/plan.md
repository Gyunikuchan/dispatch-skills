# Plan

Settle the governing spec through [spec operation](../spec-stage.md) before tactical authoring. Read the whole spec and follow every emitted `data.read` path and section as the required quality input, including for nested increment plans. A standalone plan Parent pins the spec path and hash; an increment plan pins its design increment, whose design pins the spec. Give each criterion `Satisfies: REQ-<n>` traceability. Keep tactics here and intent in the spec; use the [revision protocol](../spec-stage.md#revision-protocol) for intent changes.

Use the canonical template's hierarchy: current context, plain-language task outcomes, nested file details, then verification and reviews.

Use `start plan --session-dir <dir> --orchestrator <platform> -- <objective>`. Follow the [plan template](../templates/plan.md): author task outcomes, their prerequisite graph, and criterion assignments once in its ID-keyed Task Map, then add matching task headings and execution detail. Resolve emitted lint defects before review; inspect semantic dependencies and claimed independence against producer/consumer interfaces. The settled plan is an implementation input; author/review replies follow [the contract](../..).

During plan review, when findings in one area (one requirement, task, or plan section) recur after their accepted fix, do not apply another fix round to that area. Rule the recurring finding `needs-user` and present a requirement-feasibility [Decision Frame](../decision-frame.md#intent-findings-needs-user): keep, relax, or split the requirement, citing each prior fix and its recurrence. Apply an answer that changes intent through the [revision protocol](../spec-stage.md#revision-protocol).

Before authoring criteria, choose `Seams:` from existing public test entry points and record them directly under Verification Plan, before its first subsection; check each criterion's Verify against them. Use `Seams: none` when no test seam applies. Automated criteria with absent or empty seams emit an advisory warning on stderr; parsing and review continue. This needs no user confirmation.
