# Plan review prompt block

Kind block for `review-prompt.md`.

- `<Plan Path>` — path to the attached plan.
- `<Requirement>` — original user ask, verbatim.
- `<Review Scope>` — preparation-supplied scope string: `Full review` on a first review. On a re-review, `Re-review round <n> (full artifact) — review the whole artifact; changed sections for context: <changed sections>`, or `Re-review round <n> (delta) — changed sections: <changed sections>`. An optional `Plan lint warnings:` suffix is read delegate context.

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
- The plan's summary box and detailed `## Success Criteria` entries: each criterion observable and paired with a named test or exact
  verification step whose command runs only that criterion's tests and matches existing test names or
  titles the plan names; each criterion verifies through a plan `Seams:` entry, and each
  `Retain: transient` criterion names a valid durable `Covered by:` criterion or `FINAL`.
- The task graph: each prerequisite, ownership boundary, and claimed independence checked against
  producer/consumer interfaces; a task that consumes another's output without depending on it, or
  contends for a shared port, cache, or output, is a defect. A write path shared by tasks is a defect
  only when no `Requires` path orders them and no `Overlap:` line justifies it.
- An attached "Approved technical-design context" section: the increment's inherited contract and
  acceptance criteria. Treat the governed design as settled; raise a design-changing proposal as an
  out-of-scope remark for the orchestrator's amendment path.

## inspection

Read the plan, named files, and adjacent interfaces or tests needed to verify a claim.
Check task-specific constraints (including rationale for non-obvious prerequisites), nested file ownership and each criterion's specific checks.
Use the authoritative plan and the full review history in the review log that its `## Review Findings & Resolutions` links. Consult raw provider output or journals
when missing evidence, an adjudication dispute or recovery requires it; follow
`references/review-rules.md` for ownership and ruling semantics. History does not replace source inspection.

## tags

- intent: `intent`, `user-gap`, `scope-creep` — requirement traceability; unstated assumptions; flawed premises, XY problems, conflicting constraints, missing prerequisites; gold-plating
- domain invariants: `correctness`, `domain-logic`, `invariant`, `state-machine` — project and domain rules; sign and unit conventions (debit/credit, monthly/annual); invariants across multi-step mutations; valid transitions and reachable states
- decomposition: `dependency-graph`, `parallel-safety` — missing semantic prerequisites; false independence; unjustified overlap or shared resources; fragmented or oversized tasks
- architecture: `architecture`, `coherence`, `approach`, `standards` — producer/consumer contract mismatches; step order; self-contradiction; boundary leaks; host rule files and specs
- trust boundaries: `security`, `auth`, `validation` — credential exposure, isolation, authorization and object ownership, input validation, injection, traversal, sensitive data in logs
- compatibility: `compatibility`, `blast-radius`, `migration`, `rollback` — affected callers; persisted schemas; version skew; graceful degradation; rollback
- robustness: `edge-case`, `partial-failure`, `race`, `perf` — empty, zero, and boundary inputs; partial failure; races; unbounded designs; N+1 access, unpaginated reads, and unindexed new queries
- verification: `verification`, `testability`, `spec-gap`, `test-leak` — planned tests coupled to internals or duplicating seam coverage; a named test or concrete step per criterion; pass/fail definitions; edge expectations; broad or slow commands lacking `[FINAL]`, narrow feedback commands marked `[FINAL]`; a durable criterion whose `Test rationale` does not establish the durable bar in the plan template (lasting contract, discriminating regression, non-redundant): rewrite the rationale or test to meet the bar, demote to transient, or delete when redundant; or a transient criterion whose test belongs in a shared or durable file: move it to its own `[NEW]` transient-named file
- simpler path: `simplicity`, `yagni` — delete, reuse, stdlib, then new code; each new helper, module, or type names the equivalents searched or `none found`; verify the claim by search
- out of scope: `adjacent` — a concrete existing-code defect you meet outside Scope while inspecting; nearest plan heading as locus, code cited in the defect; spend no extra turns hunting

## quality

Host rule files take precedence over dispatch defaults: content that follows a host rule is not a finding, even when it contradicts a dispatch default. Where host rules are silent, dispatch defaults apply.

## severity

In plan reviews, MUST means the plan as written cannot deliver its outcome or breaks a binding
constraint. A gap that the plan's own Verify gates would surface deterministically during
implementation, such as a fixture update or a test assertion, is SHOULD.

## budget

If unspecified, target `8 + proposed-change entries`, at most 24; on re-review count changed entries only.

## locus

§ <Plan heading>

## closing

Cite existing code as `path/to/file:L<line>` inside `defect`.
