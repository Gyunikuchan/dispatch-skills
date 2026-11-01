# Artifact readability examples

Use these examples with the [visual-aid bar](templates/quality-bar.md#visual-aid-bar) and the field notes for each artifact.

## Context and change

A plan proposes a cache between an API and its existing store. A view of `cache` alone hides the boundary it changes. This compact diff shows the relevant unchanged flow and the proposed addition:

```diff
 Client (unchanged)
   -> API (existing; read path changes)
+    -> Cache (proposed)
       -> Store (existing, unchanged)
```

The tree answers where the change sits without assigning the client or store to the writer. Put shared orientation in the plan's shared range; place a task's local details beside its behavior. For a trivial spelling fix, omit the visual: the corrected text explains the change.

## Evidence by stage

In a plan, say: “Proposed: repeated reads use the cache. Planned verification: run the read-path test.” In the walkthrough, report observed results with their evidence: “Read-path test passed (`test.log`); load test unrun.” Cite a measured before/after only when both observations exist. This distinction prevents a proposed result or missing baseline from appearing verified.

## Reversibility and consumers

In the existing risk or rollback section, explain the affected boundary: “API readers use the new cache. Reverting the API restores direct reads; cached entries persist until expiry and must be cleared if stale.” This makes the rollback and its remaining effect actionable without a separate risk block. State only effects supported by the actual design and evidence.
