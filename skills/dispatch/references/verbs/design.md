# Design verb contract

Load this reference for design approval, increment selection, amendments, and final integration.

## Approval

A technical design is a governed scratch artifact for work with multiple increments, shared boundaries, or material dependency and rollback risk. Review its architecture, dependencies, migration, and rollback. Approval is explicit, user-attributed, and bound to normalized governed content. Execution status and review history are excluded from that hash; any other edit clears approval.

Approval records design revision, ledger identity, and highest-priority ready increment, then stops at `design-approved-stop` before production writes. Disabled or unavailable external review is disclosed and never represented as consensus.

## Increments

One invocation runs one ledger-selected increment. Its segment binds the approved design revision, increment ID, settled plan hash, plan path, and walkthrough path. Author the plan with technical-design traceability and bounded approved-design context. Decision-changing discoveries enter amendment; local refinements stay in the plan.

The ledger, never filenames or user choice, selects the highest-priority healthy ready increment. Open its segment after plan settlement and before baseline. Run ordinary baseline, implementation, verification, code-review, and handoff phases; update the execution-status mirror without changing the governed hash; close the segment and report the exact next action and resume command. A selected adjacent-fix cluster is the only same-invocation exception.

## Amendments

A design-changing discovery pauses further writes. Keep the approved design authoritative while an OS-temp candidate records changes and affected increments. Review the candidate's changed sections. The ledger records `proposed`, `reviewed`, `prepared`, and `activated`, or a terminal rejection/abort.

After explicit approval the driver activates the candidate atomically and recovers an interrupted activation; ambiguous state preserves every copy and enters reconciliation. Activation alone invalidates affected work and dependants. Caller-owned changes are never removed automatically.

## Final integration

After every increment is complete, a later invocation runs integration over the ledger-owned path union from the recorded design baseline through current Git and working-tree state. A non-ancestor baseline, unreconstructable ownership, or empty owned intersection fails closed. Record fresh cross-increment verification and any enabled scoped review in the integration walkthrough.

A defect inside an approved increment reopens it. Missing scope or a changed shared contract enters amendment. Completion requires all reopened/amended work and a later integration gate to settle. Then relocate the design-run scratch artifacts with every destination reported; never relocate the ledger.
