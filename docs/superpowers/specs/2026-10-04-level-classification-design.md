# Dispatch level classification design

**Status:** Conversational design approved on 2026-10-04; written specification awaits user review. The user asked to compact before implementation, so this document does not authorize implementation.

## Purpose

Restore a useful, evidence-based level classification for dispatch. Classify once when dispatch starts, then reassess the settled implementation scope once before the first product-changing writer. The final level should select proportionate assurance for the entire run, not fluctuate between phases.

Keep an explicitly selected level. If the pre-implementation assessment is higher, recommend that the user raise it and wait for their choice before any write. For automatically classified work, use the new assessment as the final level.

## Historical basis

The plan in commit f7f15692ce2e2a2c490b67961ace9155520ea63b proposed an invocation classification and one optional reassessment before implementation for automatically classified work. It treated an explicit user selection as fixed and expected the resulting level to shape later writers and reviews.

The earlier implementation, represented by 15bf71e, used structural anchors: low for leaf, documentation, or pure-test work; medium for subsystem, flag, or lint work; and high for wire protocols, persisted state, or write boundaries. The major rewrite in 443439a removed the second classification point and those concrete rubric examples. The current design restores the useful parts without adding a classification at every phase.

The historical sample was read-only and judgment-based. It included dispatch and the adjacent agak-finance repository:

- Low anchor: dispatch guide linking and splitting in a677ad8.
- Medium anchors: reviewer attribution and failure accounting in dispatch commit 8f44514; shared form properties in agak-finance commit 4e728e9; bounded rate fallback in agak-finance commit f66e996.
- High anchors: isolated parallel-writer worktrees and their write boundary in dispatch commit 38b0cb6; rate precision and integrity in agak-finance commit e8afb8f.
- Breadth counterexample: the reversible accessibility floor across 18 files in agak-finance commit 033a62b. File count alone did not make that work high.

These examples test the boundaries of the rubric; they are not a statistical estimate of the repository's level distribution.

## Classification lifecycle

### At dispatch invocation

Record the requested level and its source. If the user supplied a level, preserve it. Otherwise, classify from the information available at invocation. Automatic classification may select low, medium, or high; xhigh and max remain user-selected levels.

Use the invocation level for planning and dispatch setup. Do not repeat classification during design increments, retries, reviews, or other phases.

### Once before implementation

After the implementation scope, applicable authorization, and baseline are settled, assess the complete remaining implementation scope immediately before its first product-changing write. This is the second and final classification point in the dispatch invocation.

For an automatically classified run, this assessment becomes the final level. It may raise or lower the invocation level when the settled scope supports that change.

For an explicitly leveled run, retain the selected level. If the assessment is higher, show the level, the concrete risk evidence, and the reason the higher level would improve assurance. Pause for the user to either adopt the recommendation or retain their explicit level. Do not write until the user chooses. An assessment at or below the explicit level does not prompt or lower it.

This is one gate, even when it presents a recommendation. A user's choice at that gate is not another classification.

For a direct or inline implementation without a separate plan, run the same assessment after its objective and boundaries are clear and immediately before its first product-changing write.

### After the gate

Freeze the final level for the invocation. Apply it consistently to all implementation increments, retries, and the later code review. Do not reclassify at individual phases.

If new evidence shows that the approved scope expanded or contains a materially different risk, stop before further writes. Surface the evidence and require a newly scoped dispatch invocation; do not silently run a third classification or continue under a stale decision.

## Classification rubric

Level measures the assurance and recovery needed for the work, not its size. Classify from concrete behavior, consequences, boundaries, and recovery options.

Apply these rules in order:

1. **High** only when a concrete, consequential risk makes a mistake materially harmful or difficult to detect or recover. Examples include data integrity or financial-calculation errors; persisted-state, replay, or resume corruption; security, authorization, or write-authority boundaries; materially harmful external protocol or compatibility breaks; or changes whose recovery crosses difficult system boundaries. Record the specific risk and affected mechanism.
2. **Low** when work is localized, readily reversible, behavior-neutral, and has little integration or recovery risk. Examples include documentation-only edits, guide organization, leaf changes, and pure tests that do not alter behavior.
3. **Medium** for the remaining bounded work and as the default. Examples include a contained feature or subsystem change, flags and configuration, validation or form behavior, a behavior-preserving refactor, backward-compatible integration, or moderate uncertainty with practical verification and recovery paths.

Do not classify high solely because of file count, a broad domain label, unfamiliarity, or uncertainty stated without an impact and recovery path. When no high trigger is evidenced and the work is not clearly low, choose medium. This makes medium the ordinary choice while reserving high for specific consequential risks.

## Scope assessed at the gate

The pre-implementation assessment must cover the complete remaining implementation, not only the next increment. Capture a scope snapshot containing:

- the objective and governing invariants;
- criterion identifiers and their obligations;
- approved write paths;
- verification commands mapped to those criteria and baseline evidence;
- required writer and review obligations; and
- the remaining increment graph, dependencies, paths, and acceptance conditions.

Use this same snapshot to choose the final level and assurance obligations. Persist enough evidence to explain the decision and to detect a change in scope.

When adopting a design or plan revision, compare the revised criteria and obligations as well as paths and commands. If the revision adds work, expands a boundary, or leaves containment uncertain, stop before resuming a writer and require a newly scoped dispatch. A path-only or command-only comparison is insufficient.

## Persistence and compatibility

Journal the invocation level, whether it was explicit or automatic, the pre-implementation assessment, the final level, the scope snapshot or its stable fingerprint, and any user's choice to retain or raise an explicit level. Make gate completion replay-safe so a resumed run neither reclassifies nor asks the same question again.

Bump the journal protocol to revision 4 for this decision and scope state. Reject unsupported revisions. Do not migrate revision 3 journals; resume them by starting a new dispatch invocation. Older binaries must fail closed on revision 4.

## Acceptance criteria

- Each dispatch invocation has an invocation classification and no more than one pre-implementation assessment.
- The second assessment occurs after the implementation scope and baseline are settled and before the first product-changing write.
- Automatically classified work uses the second assessment as its final level.
- An explicit level is preserved. A higher assessment produces a concrete recommendation and blocks writes until the user raises or retains the selected level.
- The rubric gives medium a clear default and requires concrete consequential-risk evidence for high.
- The final level governs all remaining increments, retries, and code review without phase-by-phase reclassification.
- The assessment uses the complete remaining scope and design or plan revisions cannot bypass scope comparison.
- Replay preserves the decision and user's choice without repeating classification or prompting.
- Revision 4 journals are handled according to the fail-closed compatibility policy.
- Tests cover classification boundaries, both timing points, explicit-level recommendation and choice, complete-scope assessment, revision adoption, replay, and protocol compatibility.

## Out of scope

- Classifying from file count, path count, or domain names alone.
- Reclassifying before every phase.
- Automatically overriding an explicit level.
- Adding probabilistic or learned classification.
- Changing the adjacent agak-finance repository.
- Implementing this design before the written specification and subsequent implementation plan have passed their review gates.
