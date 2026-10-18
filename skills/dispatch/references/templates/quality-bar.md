# Quality bar

`domain/prompt.ts` `qualityBar(consumer)` selects sections for review prompts and write briefs.
Authors read the same sections through their author frame. Keep judging criteria here.

## shared

- Precedence: Applicable host rule files govern first. For nested `AGENTS.md` files, the nearest file wins over its parent. This bar supplements host rules where they are silent and yields where they conflict. Preference applies only where both are silent.
- Host rules override only this bar. Plan scope, write boundaries, the outcome envelope and verification protocol, and safety rules stay fixed. Writers report a conflict between host rules and the brief under concerns; reviewers do not report such a conflict as a finding.
- Simplicity: prefer, in order, delete, reuse, stdlib, then new code.
- Reuse: for each new exported or shared symbol, helper, module, or type, search the repository by name and behaviour for an existing equivalent; reuse a match instead of adding it.
- Spec alignment: meet every applicable requirement in the governing spec, preserve its decisions and constraints, and identify flawed premises or gaps.

## code

- Correctness and domain invariants: check domain-valid formulas and algorithms, type-valid but domain-invalid states, sign conventions (debit/credit), unit conventions and scales (monthly/annual, fraction/percent), off-by-one errors, invariants across multi-step changes, valid transitions and reachable states, runtime behavior, and type validity.
- Robustness and compatibility: handle empty, zero, and boundary inputs; unhandled branches, unguarded indexing, partial failures, floating promises, partial updates, races, and unbounded designs. Check affected callers, persisted schemas, and serialized formats. Verify migrations. Handle version skew with graceful degradation and rollback.
- Security and resources: prevent injection, traversal, missing escaping, exposed secrets, and auth bypass; enforce isolation, authorization, input validation, and object ownership (IDOR); put no sensitive data in logs or errors; close handles; bound memory and concurrency; never block the event loop; avoid hot-path quadratics, N+1 queries, and unpaginated reads; index new filter or sort columns.
- Interface quality: for touched interfaces, check accessible UI and ergonomic CLI/API behavior.
- Naming and structure: use clear names; remove unnecessary branches; avoid pass-through modules, speculative seams (one adapter is hypothetical), excess coupling, and abstractions without a concrete need; fix shared root causes once.
- Tests: Apply one behavioral bar to new, changed, and retained tests. Imagine two edits: break promised behavior, such as returning a wrong result or skipping or repeating an effect; then restructure internals while preserving behavior. A useful test fails the first edit and passes the second. Exercise a consumer interface, derive expected results from requirements, and assert what the consumer can observe: returned values, errors it uses, readable state, external payloads, prohibited or duplicate effects, or required invariants. Self-derived expectations, source-text restatements, and assertions on test-created data do not prove runtime behavior unless that artifact is itself the contract. Preserve meaningful failure modes. Judge counts, exact wording, structure, and external calls by the contract. Keep similar tests at different layers only when they detect distinct failures; group related outcomes of one consumer scenario, not unrelated behavior. Moving unchanged cases into a table does not reduce executed work. Prefer useful existing checks; when a durable regression needs brittle mocks, broad unrelated fixtures, or costly infrastructure without proportional value, use the closest useful executable or review evidence and record the limitation. Rewrite tests for required behavior, delete hollow or redundant tests, or mark step checks transient and trim them after review. Resolve uncertainty about a required contract before deletion.
- Test naming: name tests, describe blocks, test files, comments, section headers, and fixtures for behavior; never reference plan artifacts (criterion, task, or finding IDs; plan or session paths).
- Tooling: skip issues that configured linters, formatters, or type checkers enforce.

## plan

- Code criteria: apply the code section to proposed changes and touched interfaces at planning altitude; do not require written implementation.
- Traceability: trace every part of the requirement to a proposed change, and add nothing beyond it.
- Criteria: make each criterion observable and pair it with a named test or exact verification step that runs only its tests and matches existing test names or titles the plan names; each criterion uses a plan `Seams:` entry, and each `Retain: transient` criterion names a valid durable `Covered by:` criterion or `FINAL`.
- Task graph: check prerequisites and ownership boundaries; claimed independence checked against producer/consumer interfaces. A task that consumes another's output without depending on it, or contends for a shared port, cache, or output, is a defect. A write path shared by tasks is a defect only when no `Requires` path orders them and no `Overlap:` line justifies it.
- Inherited design: preserve the increment's inherited contract and acceptance criteria. Treat the governed design as settled; raise a design-changing proposal as an out-of-scope remark for the orchestrator's amendment path.
- Premises: check unstated assumptions, XY problems, conflicting constraints, and missing prerequisites.
- Decomposition: check semantic prerequisites, false independence, justified overlap or shared resources, and fragmented or oversized tasks.
- Architecture: check producer/consumer contract mismatches, step order, self-contradiction, boundary leaks, and consistency with host rule files and specs.
- Verification: reject tests coupled to internals or duplicating seam coverage; require a named test or concrete step per criterion, pass/fail definitions, and edge expectations. Mark broad or slow commands `[FINAL]` and leave narrow feedback commands unmarked; flag either mistake as a defect. For a durable criterion whose `Test rationale` does not meet the canonical test policy in the code section: rewrite the rationale or test to meet the bar, demote to transient, or delete when redundant. For a transient criterion whose test belongs in a shared or durable file: move it to its own `[NEW]` transient-named file.
- Simpler path: apply the shared simplicity order and reuse criteria and the code abstraction criteria. Verify each plan reuse claim by repository search; record search evidence in the plan template's `Reuse:` field.

## design

- Traceability: trace every goal to a requirement, and state non-goals explicitly.
- Acceptance criteria: make each criterion observable and together sufficient for the goals.
- Architecture: define component ownership, contracts between components, and data crossing boundaries.
- Decisions: real alternatives weighed; choose the simplest viable shape.
- Invariants: state system-wide rules that hold within and across increments.
- Risk and operations: check trust boundaries, deployment and runtime operation, risk concentrated in one increment, and a reversal path per change.
- Decomposition: choose independently deliverable, correctly ordered increments with collision-free parallel increments and covered final integration.
- Verification: make every increment acceptance criterion observable.
