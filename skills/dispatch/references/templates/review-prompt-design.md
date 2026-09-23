# Design review prompt block

Kind block for `review-prompt.md`.

- `<Design Path>` — path to the attached technical design.
- `<Requirement>` — original user ask, verbatim.
- `<Review Scope>` — full review or changed design sections, optionally followed by `Design lint warnings:` context.

## opener

Review the technical design adversarially: challenge the requirement, its premise, and the design.
A technical design is the higher-level architectural plan that breaks a large problem into smaller
increments, each later delivered through its own implementation plan. Review at that altitude:
raise architectural issues, and leave file-by-file and symbol-level detail to the plan reviews. No
code has been written yet.

## context

- Design: <Design Path>
- Requirement: <Requirement>

## against

- The requirement: every goal traced to it, and non-goals explicit.
- The design's goals, requirements, and per-increment acceptance criteria: each criterion
  observable, and together sufficient for the goals.

## inspection

Read the design and the direct repository contracts needed to verify a claim; verify feasibility
without demanding implementation detail.

## tags

- intent: `intent`, `scope` — goals traced to the ask; explicit non-goals; flawed premises
- architecture: `architecture`, `boundaries`, `interfaces`, `data-flow` — component ownership; contracts between components; data crossing boundaries
- decisions: `alternatives`, `simplicity` — real alternatives weighed; simplest viable shape
- invariants: `correctness`, `invariant` — system-wide rules that hold within and across increments
- risk and operations: `security`, `operations`, `risk`, `migration`, `rollback` — trust boundaries; deployment and runtime operation; risk concentrated in one increment; a reversal path per change
- decomposition: `dependency-graph`, `parallel-safety`, `integration` — independently deliverable, correctly ordered increments; collision-free parallel increments; covered final integration
- verification: `testability` — every increment acceptance criterion observable
- standards: `standards` — violations of the host rule files above
- out of scope: `adjacent` — a concrete existing-code defect you meet outside Scope while inspecting; nearest design heading as locus, code cited in the defect; spend no extra turns hunting

## budget

## locus

§ <Design heading>

## closing

Cite existing code as `path/to/file:L<line>` inside `defect`.
