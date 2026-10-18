Review the implementation plan adversarially: challenge the requirement, its premise, and the plan.
An implementation plan is the lower-level plan for building the requested features or a
technical-design increment: concrete files and symbols, step order, error behavior, prerequisite
evidence, exact verification, and bounded blast radius. No code has been written yet; judge whether
executing the plan as written delivers the requirement.

### Context
- Plan: .scratch/example/example.plan.md
- Spec Path: .scratch/example/example.spec.md
- Spec Hash: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
- Focus: General review
- Scope: Full review
- Advisory Tool Turn Target: Unspecified

### Review against
- First check governing intent and premises. A standalone plan must cover every spec REQ.
  An increment plan must meet its inherited acceptance criteria and applicable REQs; check remaining
  requirement coverage through the approved design's increment mapping. Preserve all governing constraints and DECs.
  Report unmet intent, spec ambiguity, contradiction, or a missing constraint as `intent-gap` before other tags.
  `spec-gap` is a test-spec gap, distinct from `intent-gap`.
- The plan summary, success criteria and task graph.
- Attached "Approved technical-design context": the governed increment contract and acceptance criteria.

Apply the selected quality bar to these governing targets.

### Inspection
Inspect by reading and searching files, running read-only commands in the foreground.
Verification evidence comes from the orchestrator; run no test or build commands.
Adhere to this project's conventions: read `AGENTS.md`, including nested ones on
reviewed paths, and flag violations as `standards`. A pattern that matches established local convention is not a finding;
when the convention itself is defective, report it once and name the other instances in `defect`.
Read the whole spec at Spec Path before inspection; use Spec Hash as its governing identity.
For a spec finding, use § Spec: <heading>.
Read the plan, named files, and adjacent interfaces or tests needed to verify a claim.
Check task-specific constraints (including rationale for non-obvious prerequisites), nested file ownership and each criterion's specific checks.
Use the authoritative plan and the full review history in the review log that its `## Review Findings & Resolutions` links. Consult raw provider output or journals
when missing evidence, an adjudication dispute or recovery requires it; follow
`references/review-rules.md` for ownership and ruling semantics. History does not replace source inspection.
Findings apply to the captured revision and Scope. Preserve original provenance; the host selects applicability to later content under [review rules](../review-rules.md#review-provenance-and-applicability).
On re-review, verify prior resolutions in the review log that `## Review Findings & Resolutions` links, and treat
earlier settled findings as closed. Decisions recorded in the governing design or plan are settled:
contest one only by naming it and citing evidence its rationale did not weigh. When Scope names changed sections or paths, raise new in-scope
findings only there; `adjacent` findings may cite any locus. Stop at that blast radius.
- Precedence: host rule files (`AGENTS.md`; the nearest nested file wins over its parent), then this bar, then preference. Content that follows a host rule is not a finding, even when it contradicts this bar. Where host rules are silent, this bar applies.
- Host rules override only this bar. Plan scope, write boundaries, the outcome envelope and verification protocol, and safety rules stay fixed. Writers report a conflict between host rules and the brief under concerns; reviewers do not report such a conflict as a finding.
- Simplicity: prefer, in order, delete, reuse, stdlib, then new code.
- Reuse: for each new exported or shared symbol, search the repository by name and behaviour for an existing equivalent; reuse a match instead of adding the symbol.
- Spec alignment: meet every applicable requirement in the governing spec, preserve its decisions and constraints, and identify flawed premises or gaps.

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
- Verification: planned tests coupled to internals or duplicating seam coverage; a named test or concrete step per criterion; pass/fail definitions; edge expectations; broad or slow commands lacking `[FINAL]`, narrow feedback commands marked `[FINAL]`; a durable criterion whose `Test rationale` does not meet the canonical test policy in the code section: rewrite the rationale or test to meet the bar, demote to transient, or delete when redundant; or a transient criterion whose test belongs in a shared or durable file: move it to its own `[NEW]` transient-named file.
- Simpler path: each new helper, module, or type names the equivalents searched or `none found`; verify the claim by search.

- Security and resources: prevent injection, traversal, missing escaping, exposed secrets, and auth bypass; enforce isolation, authorization, input validation, and object ownership (IDOR); put no sensitive data in logs or errors; close handles; bound memory and concurrency; never block the event loop; avoid hot-path quadratics, N+1 queries, and unpaginated reads; index new filter or sort columns.
- Tests: Apply one behavioral bar to new, changed, and retained tests. Imagine two edits: break promised behavior, such as returning a wrong result or skipping or repeating an effect; then restructure internals while preserving behavior. A useful test fails the first edit and passes the second. Exercise a consumer interface, derive expected results from requirements, and assert what the consumer can observe: returned values, errors it uses, readable state, external payloads, prohibited or duplicate effects, or required invariants. Self-derived expectations, source-text restatements, and assertions on test-created data do not prove runtime behavior unless that artifact is itself the contract. Preserve meaningful failure modes. Judge counts, exact wording, structure, and external calls by the contract. Keep similar tests at different layers only when they detect distinct failures; group related outcomes of one consumer scenario, not unrelated behavior. Moving unchanged cases into a table does not reduce executed work. Prefer useful existing checks; when a durable regression needs brittle mocks, broad unrelated fixtures, or costly infrastructure without proportional value, use the closest useful executable or review evidence and record the limitation. Rewrite tests for required behavior, delete hollow or redundant tests, or mark step checks transient and trim them after review. Resolve uncertainty about a required contract before deletion.
- Test naming: name tests, describe blocks, test files, comments, section headers, and fixtures for behavior; never reference plan artifacts (criterion, task, or finding IDs; plan or session paths).
- Tooling: skip issues that configured linters, formatters, or type checkers enforce.

### Tags
- intent gap: `intent-gap`
- intent: `intent`, `user-gap`, `scope-creep`
- domain invariants: `correctness`, `domain-logic`, `invariant`, `state-machine`
- decomposition: `dependency-graph`, `parallel-safety`
- architecture: `architecture`, `coherence`, `approach`, `standards`
- trust boundaries: `security`, `auth`, `validation`
- compatibility: `compatibility`, `blast-radius`, `migration`, `rollback`
- robustness: `edge-case`, `partial-failure`, `race`, `perf`
- verification: `verification`, `testability`, `spec-gap`, `test-leak`
- simpler path: `simplicity`, `yagni`
- out of scope: `adjacent`

### Budget
The tool-turn target is advisory: stop early when grounded; exceed it only for an evidenced
in-scope risk.
If unspecified, target `8 + proposed-change entries`, at most 24; on re-review count changed entries only.

### Severity
Severity is resolution priority. `MUST`: blocks the promised outcome or breaks a binding
constraint. `SHOULD`: real defect that degrades the outcome without blocking it. `CONSIDER`: optional
improvement; no defect.
In plan reviews, MUST means the plan as written cannot deliver its outcome or breaks a binding
constraint. A gap that the plan's own Verify gates would surface deterministically during
implementation, such as a fixture update or a test assertion, is SHOULD.
In `defect`, state the concrete consequence at the locus; in `requiredChange`, the remedy.
Ground each finding in a concrete failure scenario, a host rule, a measurable cost, or a known
vulnerability class. Preference is not a finding; between technically equivalent approaches, the
author's choice stands. Simplicity findings name the cost removed: concepts, files, or code paths.

### Reply
Reply with one JSON object of all findings. If JSON cannot carry a finding, write it as plain
text. For a clean review use:
```json
{"status":"CLEAN","findings":[]}
```

Otherwise use status `FINDINGS` and one or more findings with every field:
```json
{"status":"FINDINGS","findings":[{"severity":"MUST|SHOULD|CONSIDER","locus":"§ <Plan heading>","tag":"<tag>","defect":"<defect>","requiredChange":"<required change>"}]}
```

Use only the tags above.
Cite existing code as `path/to/file:L<line>` inside `defect`.
