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
- Governing targets: every spec REQ and DEC for a standalone plan; inherited acceptance criteria and applicable REQs for an increment plan, using the approved design's increment mapping to check remaining coverage.
- Use the selected sections of the [quality bar](quality-bar.md) to judge those targets. Report unmet intent, spec ambiguity, contradiction, or a missing constraint as `intent-gap` before other tags. `spec-gap` remains a test-spec gap, distinct from `intent-gap`.
- The plan summary, success criteria and task graph.
- Attached "Approved technical-design context": the governed increment contract and acceptance criteria.

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
Findings apply to the captured revision and Scope. Report a concrete existing-code defect encountered while inspecting the selected target and interfaces or call sites needed to verify it; those interfaces or call sites may be outside Scope only as needed to substantiate the defect. Spend no extra turns hunting for adjacent findings. Apply this discovery rule to every review kind. Preserve original provenance; the host selects applicability to later content under [review rules](../review-rules.md#review-provenance-and-applicability).
On re-review, verify prior resolutions in the review log that `## Review Findings & Resolutions` links, and treat
earlier settled findings as closed. The governing spec's Decisions and Non-goals, and decisions recorded in the governing design or plan, are settled:
contest one only by naming it and citing evidence it did not weigh. When Scope names changed sections or paths, raise new in-scope
findings only there; `adjacent` findings may cite any locus. Stop at that blast radius.
- Precedence: Applicable host rule files govern first. For nested `AGENTS.md` files, the nearest file wins over its parent. This bar supplements host rules where they are silent and yields where they conflict. Preference applies only where both are silent.
- Host rules override only this bar. Plan scope, write boundaries, the outcome envelope and verification protocol, and safety rules stay fixed. Writers report a conflict between host rules and the brief under concerns; reviewers do not report such a conflict as a finding.
- Simplicity: prefer, in order, delete, reuse, stdlib, then new code.
- Reuse: for each new exported or shared symbol, helper, module, or type, search the repository by name and behaviour for an existing equivalent; reuse a match instead of adding it.
- Spec alignment: meet every applicable requirement in the governing spec, preserve its decisions and constraints, and identify flawed premises or gaps.

- Code criteria: apply the code section to proposed changes and touched interfaces at planning altitude; do not require written implementation.
- Traceability: trace every part of the requirement to a proposed change, and add nothing beyond it.
- Criteria: make each criterion observable and pair it with a named behavior test or exact verification step, its plan `Seams:` entry, pass/fail outcomes, and edge expectations. All plan consumers must read the template's field notes at `<skills-dir>/dispatch/references/templates/plan.md#field-notes` for test selectors and named-test matching, `[FINAL]` gate classification, and transient-test placement; treat any violation as a defect. Assess test coupling and duplicate seam coverage under the code section's test policy. For durable tests, require a `Test rationale:` that meets the code section's test policy; repair the rationale or test, demote the criterion to transient, or remove it when redundant.
- Task graph: check prerequisites and ownership boundaries; check claimed independence against producer/consumer interfaces. A task that consumes another's output without depending on it, or contends for a shared port, cache, or output without a prerequisite, is a defect. A write path shared by tasks is a defect only when no `Requires` path orders them and no justified `Overlap:` line covers it. Combine same-file or tightly coupled changes. Keep tasks meaningful, neither fragmented nor oversized.
- Inherited design: preserve the increment's inherited contract and acceptance criteria. Treat the governed design as settled; raise a design-changing proposal as an out-of-scope remark for the orchestrator's amendment path.
- Premises: check unstated assumptions, XY problems, conflicting constraints, and missing prerequisites.
- Architecture: check producer/consumer contract mismatches, step order, self-contradiction, boundary leaks, and consistency with host rule files and specs.
- Simpler path and reuse: apply the shared simplicity and reuse criteria and the code abstraction criteria. Verify each plan reuse claim by repository search; record search evidence in the plan template's `Reuse:` field.

- Correctness and domain invariants: check domain-valid formulas and algorithms, type-valid but domain-invalid states, sign conventions (debit/credit), unit conventions and scales (monthly/annual, fraction/percent), off-by-one errors, invariants across multi-step changes, valid transitions and reachable states, runtime behavior, and type validity.
- Robustness and compatibility: handle empty, zero, and boundary inputs; unhandled branches, unguarded indexing, partial failures, floating promises, partial updates, races, and unbounded designs. Check affected callers, persisted schemas, and serialized formats. Verify migrations. Handle version skew with graceful degradation and rollback.
- Security and resources: prevent injection, traversal, missing escaping, exposed secrets, and auth bypass; enforce isolation, authorization, input validation, and object ownership (IDOR); put no sensitive data in logs or errors; close handles; bound memory and concurrency; never block the event loop; avoid hot-path quadratics, N+1 queries, and unpaginated reads; index new filter or sort columns.
- Interface quality: for touched interfaces, check accessible UI and ergonomic CLI/API behavior.
- Naming and structure: use clear names; remove unnecessary branches; avoid pass-through modules, speculative seams (one adapter is hypothetical), excess coupling, and abstractions without a concrete need; fix shared root causes once.
- Tests: Apply one behavioral bar to new, changed, and retained tests. Imagine two edits: break promised behavior, such as returning a wrong result or skipping or repeating an effect; then restructure internals while preserving behavior. A useful test fails the first edit and passes the second. Exercise a consumer interface, derive expected results from requirements, and assert what the consumer can observe: returned values, errors it uses, readable state, external payloads, prohibited or duplicate effects, or required invariants. Self-derived expectations, source-text restatements, and assertions on test-created data do not prove runtime behavior unless that artifact is itself the contract. Preserve meaningful failure modes. Judge counts, exact wording, structure, and external calls by the contract. Keep similar tests at different layers only when they detect distinct failures; keep each test within one consumer scenario, grouping related outcomes but not unrelated behaviors. Moving unchanged cases into a table does not reduce executed work. Prefer useful existing checks; when a durable regression needs brittle mocks, broad unrelated fixtures, or costly infrastructure without proportional value, use the closest useful executable or review evidence and record the limitation. Rewrite tests for required behavior, delete hollow or redundant tests, or mark step checks transient and trim them after review. Resolve uncertainty about a required contract before deletion.
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
For an adjacent finding, use the nearest plan heading as locus.
