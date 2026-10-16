# Design

Settle the governing spec through [spec operation](../spec-stage.md) before strategy authoring. Read its whole content and every emitted `data.read` path/section before drafting. The design maps REQs to components and increments and records architectural AD decisions; intent and user decisions remain in the spec's DEC log. Use the spec's path/hash Parent pin and the [revision protocol](../spec-stage.md#revision-protocol) for changed intent.

Use the [design template](../templates/design.md) for strategy, grouped component/increment outcomes and single-sourced constraints with local exceptions.

Use `start design --session-dir <dir> --orchestrator <platform> -- <objective>`. Author from the emitted template, resolve lint and reviews, and obtain user approval bound to the governed design revision. Design ends at approval. A later `implement -- <design-path>` delivers its graph in priority order; [the contract](../..) owns host replies.
