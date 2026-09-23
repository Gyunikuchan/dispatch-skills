# Plan review prompt block

Kind block for `review-prompt.md`.

- `<Plan Path>` — path to the attached plan.
- `<Requirement>` — original user ask, verbatim.
- `<Review Scope>` — preparation-supplied scope string: `Full review` on a first review. On a re-review, `Re-review round <n> — changed sections: <changed sections>`. An optional `Plan lint warnings:` suffix is read delegate context.

## opener

Review the implementation plan adversarially: challenge the requirement, its premise, and the plan.
An implementation plan is the lower-level plan for building the requested features or a
technical-design increment: concrete files and symbols, step order, error behavior, prerequisite
evidence, exact verification, and bounded blast radius. No code has been written yet; judge whether
executing the plan as written delivers the requirement.

## context

- Plan: <Plan Path>
- Requirement: <Requirement>

## against

- The requirement: every part traced to a proposed change, and nothing added beyond it.
- The plan's `## Success Criteria`: each criterion observable and paired with a named test or exact
  verification step.
- An attached "Approved technical-design context" section: the increment's inherited contract and
  acceptance criteria. Treat the governed design as settled; raise a design-changing proposal as an
  out-of-scope remark for the orchestrator's amendment path.

## inspection

Read the plan, named files, and adjacent interfaces or tests needed to verify a claim.

## tags

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
`path/to/file:L<line>` inside `defect`. Use only the tags above. Omit praise, summaries, and next
steps.
