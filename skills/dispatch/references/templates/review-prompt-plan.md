# Plan review prompt block

Kind block for `review-prompt.md`. This is an implementation-plan review, not a technical-design
review: require concrete files, symbols, sequence, error behavior, prerequisite evidence, exact
verification, and bounded blast radius.

- `<Plan Path>` — path to the attached plan.
- `<Requirement>` — original user ask, verbatim.
- `<Review Scope>` — preparation-supplied scope string: `Full review` on a first review. On a re-review, `Re-review round <n> — changed sections: <changed sections>`. An optional `Plan lint warnings:` suffix is read delegate context.

## opener

Review the plan adversarially: challenge the requirement, its premise, and the plan. No code has
been written yet.

## context

- Plan: <Plan Path>
- Requirement: <Requirement>

## inspection

Read the plan, named files, and adjacent interfaces or tests needed to verify a claim.
Inspect by reading and searching files or with read-only code-exploration tools; run no test or build commands.
On re-review, verify the resolutions logged under `## Review Findings & Resolutions` and treat
earlier settled sections as closed. When Scope names changed sections, raise new in-scope findings
only there; `adjacent` findings may cite any locus. Stop at that blast radius.

When the preparation attaches an "Approved technical-design context" section, the plan is an
implementation plan for exactly one approved increment: judge the concrete files and symbols,
sequencing, error behavior, prerequisite evidence, exact verification, and bounded blast radius
against that increment's inherited contract and acceptance criteria; do not re-litigate the
governed design, and treat a design-changing proposal as an out-of-scope remark routed to the
orchestrator's amendment path.

## tags

Check these tags:
- intent: `intent`, `user-gap`, `scope-creep` — requirement traceability; unstated assumptions; flawed premises, XY problems, conflicting constraints, missing prerequisites; gold-plating
- domain invariants: `correctness`, `domain-logic`, `invariant`, `state-machine` — project and domain rules; sign and unit conventions (debit/credit, monthly/annual); invariants across multi-step mutations; valid transitions and reachable states
- architecture: `architecture`, `coherence`, `approach`, `standards` — producer/consumer contract mismatches; step order; self-contradiction; boundary leaks; host rule files and specs
- trust boundaries: `security`, `auth`, `validation` — credential exposure, isolation, authorization, input validation, injection, traversal
- compatibility: `compatibility`, `blast-radius`, `migration`, `rollback` — affected callers; persisted schemas; version skew; graceful degradation; rollback
- robustness: `edge-case`, `partial-failure`, `race`, `perf` — empty, zero, and boundary inputs; partial failure; races; unbounded designs
- verification: `verification`, `testability`, `spec-gap` — a named test or concrete step per criterion; pass/fail definitions; edge expectations
- simpler path: `simplicity`, `yagni` — delete, reuse, stdlib, then new code
- out of scope: `adjacent` — a concrete existing-code defect you meet outside Scope while inspecting; nearest plan heading as locus, code cited in the defect; spend no extra turns hunting

## budget

If unspecified, target `8 + 2 × proposed-change entries`; on re-review count changed entries only.

## locus

§ <Plan heading>

## closing

Every finding needs a verifiable claim and a `§ <Plan heading>` locus. Cite existing code as
`path/to/file:L<line>` inside `defect`. Use only the tags above. Omit praise, summaries,
and next steps.
