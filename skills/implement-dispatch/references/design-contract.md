# Technical-design contract

The design foundation treats a technical design as a governed, scratch-only artifact. Activation is evidence-based for work with multiple increments, shared boundaries, or material dependency and rollback risk. The design is reviewed with the architectural rubric, and approval is explicit, user-attributed, and bound to the normalized governed content hash.

Execution status and review history are excluded from the governed hash. Status-only or review-log edits therefore preserve approval; any governed edit clears approval and requires re-review. External review being disabled or unavailable is disclosed at approval and never represented as consensus.

Approval records the design revision, root-slug ledger identity, and the highest-priority ready increment, then appends `run-complete` with `design-approved-stop`. The invocation stops before authoring increment plans or modifying production files. Resume uses the design path and reports increment execution unavailable until a later capability exists.

If writes occurred before promotion, the ordinary segment is closed as `aborted`; the live diff is fingerprinted and reconciled as candidate initial-increment or abandoned work, then attributed state is bound into the design baseline. Approved design artifacts remain in `.scratch/` for durable resume; ordinary successful handoff relocation remains unchanged.
