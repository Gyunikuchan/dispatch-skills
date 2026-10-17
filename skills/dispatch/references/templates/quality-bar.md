# Quality bar

`domain/prompt.ts` `qualityBar(consumer)` selects sections for review prompts and write briefs.
Authors read the same sections through their author frame. Keep judging criteria here.

## shared

- Precedence: host rule files (`AGENTS.md` / `CLAUDE.md`; the nearest nested file wins over its parent), then this bar, then preference. Content that follows a host rule is not a finding, even when it contradicts this bar. Where host rules are silent, this bar applies.
- Host rules override only this bar. Plan scope, write boundaries, the outcome envelope and verification protocol, and safety rules stay fixed. Writers report a conflict between host rules and the brief under concerns; reviewers do not report such a conflict as a finding.
- Simplicity: prefer, in order, delete, reuse, stdlib, then new code.
- Reuse: for each new exported or shared symbol, search the repository by name and behaviour for an existing equivalent; reuse a match instead of adding the symbol.
- Spec alignment: meet every applicable requirement in the governing spec, preserve its decisions and constraints, and identify flawed premises or gaps.

## code

- Security and resources: prevent injection, traversal, missing escaping, exposed secrets, and auth bypass; enforce isolation, authorization, input validation, and object ownership (IDOR); put no sensitive data in logs or errors; close handles; bound memory and concurrency; never block the event loop; avoid hot-path quadratics, N+1 queries, and unpaginated reads; index new filter or sort columns.
- Tests: assert observable outcomes at seams, not internals, and cover failure modes. Each retained (`Retain: durable`) test meets the durable bar in the plan template; implementation steps, internals, unnamed regressions, or redundancy fail it. A failing test is rewritten to meet the bar, demoted to transient, or deleted when redundant. Bar low-signal tests: (1) micro-permutations: fold input/validation variants into one table-driven test or representative case; (2) shallow state and loggers: assert observable returns and domain errors, not internals, call order, invocation counts, or exact log text; (3) over-mocking: avoid mock wiring for simple passthroughs; decouple pure logic or test at a higher seam; (4) tier duplication: do not replicate integration or e2e scenarios in unit tests; (5) setup weight: share read-only fixtures or lightweight inputs instead of heavy per-test setups for minor assertions; (6) assertion density: pack related invariant checks rather than repeating expensive initialization per field. Scaffolding and step proofs belong strictly in `Retain: transient` and are trimmed after review.
- Test naming: name tests, describe blocks, test files, comments, section headers, and fixtures for behavior; never reference plan artifacts (criterion, task, or finding IDs; plan or session paths).
- Tooling: skip issues that configured linters, formatters, or type checkers enforce.

## plan

- Adjacent findings: report a concrete existing-code defect met outside Scope while inspecting; use the nearest plan heading as locus and cite code in the defect; spend no extra turns hunting.
- Traceability: every part of the requirement traced to a proposed change, and nothing added beyond it.
- Criteria: each criterion observable and paired with a named test or exact
  verification step whose command runs only that criterion's tests and matches existing test names or
  titles the plan names; each criterion verifies through a plan `Seams:` entry, and each
  `Retain: transient` criterion names a valid durable `Covered by:` criterion or `FINAL`.
- Task graph: each prerequisite, ownership boundary, and claimed independence checked against
  producer/consumer interfaces; a task that consumes another's output without depending on it, or
  contends for a shared port, cache, or output, is a defect. A write path shared by tasks is a defect
  only when no `Requires` path orders them and no `Overlap:` line justifies it.
- Inherited design: preserve the increment's inherited contract and acceptance criteria. Treat the governed design as settled; raise a design-changing proposal as an
  out-of-scope remark for the orchestrator's amendment path.
- Premises: check unstated assumptions, XY problems, conflicting constraints and missing prerequisites.
- Domain invariants: project and domain rules; sign and unit conventions (debit/credit, monthly/annual); invariants across multi-step mutations; valid transitions and reachable states.
- Decomposition: missing semantic prerequisites; false independence; unjustified overlap or shared resources; fragmented or oversized tasks.
- Architecture: producer/consumer contract mismatches; step order; self-contradiction; boundary leaks; host rule files and specs.
- Compatibility: affected callers; persisted schemas; version skew; graceful degradation; rollback.
- Robustness: empty, zero, and boundary inputs; partial failure; races; unbounded designs.
- Verification: planned tests coupled to internals or duplicating seam coverage; a named test or concrete step per criterion; pass/fail definitions; edge expectations; broad or slow commands lacking `[FINAL]`, narrow feedback commands marked `[FINAL]`; a durable criterion whose `Test rationale` does not establish the durable bar in the plan template (lasting contract, discriminating regression, non-redundant): rewrite the rationale or test to meet the bar, demote to transient, or delete when redundant; or a transient criterion whose test belongs in a shared or durable file: move it to its own `[NEW]` transient-named file.
- Simpler path: each new helper, module, or type names the equivalents searched or `none found`; verify the claim by search.

## design

- Adjacent findings: report a concrete existing-code defect met outside Scope while inspecting; use the nearest design heading as locus and cite code in the defect; spend no extra turns hunting.
- Traceability: every goal traced to the requirement, and non-goals explicit.
- Acceptance criteria: each criterion
  observable, and together sufficient for the goals.
- Architecture: component ownership; contracts between components; data crossing boundaries.
- Decisions: real alternatives weighed; simplest viable shape.
- Invariants: system-wide rules that hold within and across increments.
- Risk and operations: trust boundaries; deployment and runtime operation; risk concentrated in one increment; a reversal path per change.
- Decomposition: independently deliverable, correctly ordered increments; collision-free parallel increments; covered final integration.
- Verification: every increment acceptance criterion observable.
