# Plan

Use the canonical template's hierarchy: current context, plain-language task outcomes, nested file details, then verification and reviews. State shared constraints once and retain the technical detail needed to implement and review each task.

Use `start plan --session-dir <dir> --orchestrator <platform> -- <objective>`. Author meaningful task outcomes, their prerequisite graph, scoped file changes, exhaustive criteria, discriminating commands, and rollback boundary using [the plan template](../templates/plan.md). Resolve emitted lint defects before review; inspect semantic dependencies and claimed independence against producer/consumer interfaces. The settled plan is an implementation input; author/review replies follow [the contract](../..).

Before authoring criteria, choose `Seams:` from existing public test entry points and record them directly under Verification Plan, before its first subsection; check each criterion's Verify against them. Use `Seams: none` when no test seam applies. Automated criteria with absent or empty seams emit an advisory warning on stderr; parsing and review continue. This needs no user confirmation.
