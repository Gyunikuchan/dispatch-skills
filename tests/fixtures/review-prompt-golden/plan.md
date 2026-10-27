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
- Use the selected sections of the [quality bar](quality-bar.md) to judge those targets. Report unmet or contradicted intent as `intent` and a defect in the governing spec text as `spec` (locus `§ Spec: <heading>`), before other tags.
- The plan summary, success criteria and task graph.
- Attached "Approved technical-design context": the governed increment contract and acceptance criteria.

### Inspection
Inspect by reading and searching files, running read-only commands in the foreground.
Verification evidence comes from the orchestrator; run no test or build commands.
Adhere to this project's conventions: read `AGENTS.md`, including nested ones on reviewed paths.
Report host-rule violations on changed lines or sections as `standards`; elsewhere, report them as `adjacent`.
A pattern that matches established local convention is not a finding;
when the convention itself is defective, report it once and name the other instances in `defect`.
Read the whole spec at Spec Path before inspection; use Spec Hash as its governing identity.
For a spec finding, use § Spec: <heading>.
Read the plan, named files, and adjacent interfaces or tests needed to verify a claim.
Check task-specific constraints (including rationale for non-obvious prerequisites), nested file ownership and each criterion's specific checks.
Use the authoritative plan and the full review history in the review log that its `## Review Findings & Resolutions` links. Consult raw provider output or ledger records
when missing evidence, an adjudication dispute or recovery requires it; follow
`references/review-rules.md` for ownership and ruling semantics. History does not replace source inspection.
Findings apply to the captured revision and Scope. Report a concrete existing-code defect encountered while inspecting the selected target and interfaces or call sites needed to verify it; those interfaces or call sites may be outside Scope only as needed to substantiate the defect. Spend no extra turns hunting for adjacent findings. Apply this discovery rule to every review kind. Preserve original provenance; the host selects applicability to later content under [review rules](../review-rules.md#review-provenance-and-applicability).
On re-review, verify prior resolutions in the review log that `## Review Findings & Resolutions` links, and treat
earlier settled findings as closed. The governing spec's Decisions and Non-goals, and decisions recorded in the governing design or plan, are settled:
contest one only by naming it and citing evidence it did not weigh. When Scope names changed sections or paths, raise new in-scope
findings only there; `adjacent` findings may cite any locus. Stop at that blast radius.
- Precedence: Applicable host rule files govern first. For nested `AGENTS.md` files, the nearest file wins over its parent. This bar supplements host rules where they are silent and yields where they conflict. Preference applies only where both are silent.
- Host rules override only this bar. Plan scope, write boundaries, verification requirements, and safety rules stay fixed. Writers report a conflict between host rules and the brief under concerns; reviewers do not report such a conflict as a finding.
- **intent** — Trace the ask to applicable REQs and DECs, and check that each is served. Identify a misread user ask, unmet user need, unstated assumption, flawed premise, gold-plating, or XY problem; add nothing beyond the ask. Route a design or plan that changes intent through the user gate.
- **maintainability** — Prefer delete, reuse, stdlib, then new code. Keep one source of truth; search the repository by name and behaviour for an existing equivalent before adding a new exported or shared symbol, helper, module, or type. Apply the rule of three: extract on third use; duplication beats the wrong abstraction. Use YAGNI and KISS; prefer deep modules, clear seams, low coupling and high cohesion; avoid pass-through modules, speculative seams (one adapter is hypothetical), excess coupling, and abstractions without a concrete need. Remove unnecessary branches and fix root causes once. Preserve Chesterton's fence, and make names, docs, and comments explain why and change with behavior. Judge content against the [document layers](../spec-stage.md#readers-and-document-layers), and cite upstream IDs instead of restating an earlier layer.

- **spec** — Apply IEEE 29148 quality: requirements are unambiguous (one interpretation), consistent, verifiable, complete, feasible, and singular (one requirement per statement; identify non-singular requirements). Check completeness across behavior, interfaces and data, failure and recovery, quality requirements, assumptions, and dependencies. Identify misplaced architecture or execution detail while retaining imposed design constraints. An open question that could change scope, behavior, or risk blocks approval; never invent intent, and route a gap through the user gate.

- **usability** — Open canonical artifacts with At a Glance: short plain-language bullets for what changes, why it matters and how it works. Keep task and increment behaviour visible in bullets before `<details>`; use the block for file changes and verbose detail. Use `> [!NOTE]` for information the user must know and `> [!IMPORTANT]` only for a decision they must make, consistent with `Decide:` when present. Keep machine fields outside callouts. Prefer point form over long prose. Use diagrams only when they explain flow, architecture or data better than text; pair each with a one-line text summary. Retain every required field.

- Code criteria: apply the code section to proposed changes and touched interfaces at planning altitude; do not require written implementation.
- **intent** — Trace every requirement to a proposed change, add nothing beyond it, and check unstated assumptions, XY problems, conflicting constraints, and missing prerequisites.
- **architecture** — Preserve the increment's inherited contract and acceptance criteria. Check producer/consumer mismatches, step order, self-contradiction, boundary leaks, and consistency with host rules and specs. Treat the governed design as settled; raise a design-changing proposal through the orchestrator's amendment path.
- **decomposition** — Check the prerequisite DAG, ownership boundaries, producer/consumer contracts, and claimed independence. A task that consumes another's output without a prerequisite is a defect. Treat contention on a shared write path as a defect only when neither a `Requires` ordering nor a justified `Overlap:` line covers it. Shared port, cache, or output contention needs a prerequisite. Keep tasks meaningful, neither fragmented nor oversized; use independently deliverable vertical slices with INVEST task sizing, safe parallel work, and final integration. Check whether risk is concentrated in one increment.
- **testing** — Make each criterion observable and pair it with a named behavior test or exact verification step, its `Seams:` entry, pass/fail outcomes, and edge expectations. Read `<skills-dir>/dispatch/references/templates/plan.md#field-notes` for test selectors and named-test matching, `[FINAL]` gate classification, and transient-test placement; treat any violation as a defect. For durable tests, require a `Test rationale:` that meets the code section's test policy; repair the rationale or test, demote the criterion to transient, or remove it when redundant. Assess test coupling and duplicate seam coverage under the code section's test policy.

- **spec** — Check the implementation against applicable requirements, decisions, and constraints. Treat ambiguous or contradictory governing text, an unverifiable requirement, or a missing constraint as a spec defect; do not invent intent.
- **correctness** — Check domain-valid formulas and algorithms, preconditions, postconditions, and invariants; type-valid but domain-invalid states; valid transitions and reachable states; off-by-one errors; units, signs, and scales; runtime behavior; and type validity.
- **reliability** — Check empty, zero, and boundary inputs; unhandled branches; partial failures and updates; atomicity and crash consistency; idempotency; races and TOCTOU; floating promises; fail-closed behavior; data loss; and destructive-operation guards.
- **security** — Check trust boundaries and least privilege; STRIDE at design altitude and OWASP/CWE at code altitude; injection, traversal, and missing escaping; authorization and IDOR; isolation, input validation, and object ownership; and sensitive data in logs or errors.
- **performance** — Check Big-O on hot paths, N+1 queries, unpaginated reads; index new filter or sort columns. Check backpressure, bounded queues, concurrency and memory, closed handles, and event-loop blocking.
- **compatibility** — Check breaking changes, Hyrum's law, semver, expand/contract migrations, rollback, version skew with graceful degradation, affected callers, persisted schemas and serialized formats, and portability across OS, shell, path, and encoding.
- **operability** — Check deployment and runtime operation, logs, metrics and traces, actionable diagnostics, configuration, and a kill switch.
- **testing** — Apply one behavioral bar to new, changed, and retained tests. Retain durable tests only for non-trivial contracts against plausible severe defects: consumer-facing contract breakage, state corruption, data loss, security-boundary violations, or broken protocol transitions. Each overlapping test must add distinct protection. Name the consumer, failure and distinct protection: a retrying client must not duplicate a committed payment; a serializer round-trip alone is trivial when it protects no consequential contract. Forego dedicated trivial or mechanical tests and tests duplicating guarantees actually provided by configured static checks (for example, a checked return type); static checks do not guarantee runtime authorization or state transitions. Imagine two edits: break promised behavior, then restructure internals while preserving behavior. A useful test fails the first and passes the second. Exercise a consumer interface, derive expected results from requirements, and assert observable values, used errors, readable state, external payloads, prohibited or duplicate effects, or invariants. Check test gaps at seams and failure modes, tautologies, change-detector tests (transient-only tests are exempt), and mutation-style break-it checks. Prefer FIRST tests (deterministic, isolated) and preserve meaningful failure modes. Self-derived expectations, source-text restatements, and assertions on test-created data do not prove runtime behavior unless that artifact is the contract. Judge counts, wording, structure, and external calls by the contract. Keep tests at multiple layers only for distinct failures; group one consumer scenario, not unrelated behavior. Moving unchanged cases into a table does not reduce executed work. Prefer useful existing checks; when durable regression tests need brittle mocks, broad unrelated fixtures, or costly infrastructure without proportional value, use the closest executable or review evidence and record the limit. Rewrite weak tests, delete hollow or redundant tests, or classify intermediate step, helper and branch-permutation checks as transient for removal after review. Use coverage only as optional local implementation feedback; percentages do not decide durable retention or gate pruning. Branch- or line-padding checks are transient. Resolve uncertainty about a required contract before deletion. Test naming: name tests, describe blocks, test files, comments, section headers, and fixtures for behavior; never reference plan artifacts such as criterion, task, or finding IDs, plan paths, or session paths.
- **usability** — Check WCAG accessibility, POLA (least astonishment), accessible UI, CLI/API ergonomics, and actionable errors.
- Tooling: skip issues that configured linters, formatters, or type checkers enforce.

### Tags
Tag each finding with one family; the quality bar's bold family bullets define each family and its hints.
- `intent`
- `spec`
- `correctness`
- `reliability`
- `security`
- `performance`
- `compatibility`
- `maintainability`
- `architecture`
- `decomposition`
- `operability`
- `testing`
- `usability`
- `standards`
- `adjacent`

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

When Pending MUST rejection confirmation assigns requests, add `confirmations` to this object. Answer each assigned request exactly once with exactly `requestId`, `decision` (`agree` or `disagree`) and a nonblank evidence-backed `rationale`. Keep ordinary `status` and `findings`. A pending MUST rejection is open until explicit agreement; omission is not confirmation.

Use only the tags above.
Cite existing code as `path/to/file:L<line>` inside `defect`.
For an adjacent finding, use the nearest plan heading as locus.
