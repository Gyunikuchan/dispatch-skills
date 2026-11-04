Review the implementation plan adversarially: challenge the requirement, its premise, and the plan.
Judge whether this unimplemented plan delivers the requested features or technical-design increment: concrete files and symbols, step order, error behavior, prerequisite evidence, exact verification, and bounded blast radius.

### Context
- Plan: .scratch/example/example.plan.md
- Spec Path: .scratch/example/example.spec.md
- Spec Hash: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
The Spec Hash is the canonical identity reported by lint; it is not a hash of the raw file bytes.
- Focus: General review
- Scope: Full review
- Advisory Tool Turn Target: 10

### Review against
- Governing targets: every spec REQ and DEC for a standalone plan; inherited acceptance criteria and applicable REQs for an increment plan, using the approved design's increment mapping to check remaining coverage.
- Use the selected sections of the [quality bar](quality-bar.md) to judge those targets. Report unmet or contradicted intent as `intent` and a defect in the governing spec text as `spec` (locus `§ Spec: <heading>`), before other tags.
- The plan summary, success criteria and task graph.
- Attached "Approved technical-design context": the governed increment contract and acceptance criteria.

### Inspection
Inspect by reading and searching files, running read-only commands in the foreground. A reviewer may run a host read tool that creates or updates only its own cache or index, unless a stricter host rule forbids it.
Read directly; launch no subagents.
Verification evidence comes from the orchestrator; run no test or build commands.
Adhere to the host rule files that the quality section's discovery rule finds.
Report host-rule violations on changed lines or sections as `standards`; elsewhere, report them as `adjacent`.
A pattern that matches established local convention is not a finding;
when the convention itself is defective, report it once and name the other instances in `defect`.
Read the whole spec at Spec Path before inspection; use Spec Hash as its governing identity.
For a spec finding, use § Spec: <heading>.
Use the authoritative plan. Read the plan, named files, and adjacent interfaces or tests needed to verify a claim.
Check task-specific constraints (including rationale for non-obvious prerequisites), nested file ownership and each criterion's specific checks.
Judge the plan against its Plan standard. Report a missing decision that prevents safe implementation; report a routine writer choice only with a concrete consequence, such as a failed criterion, broken invariant or ownership conflict.
For every review kind, findings apply to the captured revision and Scope. Inspect required callers, interfaces, host rules and governing material even outside Scope. Report concrete existing-code defects encountered in the selected target or during that required inspection; inspect other adjacent material only to substantiate a defect. Spend no extra turns hunting for adjacent findings. Preserve original provenance; the host selects applicability to later content under [review rules](../review-rules.md#review-provenance-and-applicability).
Read the full review history in the review log that each governing artifact's `## Review Findings & Resolutions` links. Consult raw provider output or ledger records when missing evidence, disputed adjudication or recovery requires it; follow [review rules](../review-rules.md) for ownership and ruling semantics. History does not replace source inspection.
On re-review, verify prior resolutions in that review log, and treat
earlier settled findings as closed. The governing spec's Decisions and Non-goals, and decisions recorded in the governing design or plan, are settled:
contest one only by naming it and citing evidence it did not weigh. When Scope names changed sections or paths, raise new in-scope
findings only there; `adjacent` findings may cite any locus. Stop at that blast radius.
- Host rule files: before judging or editing, find every file that sets conventions for in-scope paths. Check `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `CONTRIBUTING.md`, `CODING_STANDARDS.md`, linked style guides, and in-scope nested copies; nearest wins. Read applicable rules; skip rules enforced by configured linters, formatters or type checkers.
- Precedence: Applicable host rule files govern first. This bar supplements host rules where they are silent and yields where they conflict. Preference applies only where both are silent.
- Host rules override only this bar. Plan scope, write boundaries, verification and safety stay fixed. Writers report host-rule/brief conflicts under concerns; reviewers exclude them from findings.
- Evidence: a claim about an external format states the sample inspected against the population and its uncertainty; never generalize beyond that sample. An absence claim (no caller, no consumer, not present) checks the search method's exclusions (ignored paths, file types, generated output, dynamic dispatch) and rests on direct evidence the host supports, such as an index query, reference lookup or exhaustive listing; otherwise mark it unverified.
- **intent** — Trace the ask to applicable REQs and DECs, and check that each is served. Map requirements to changes and goals to requirements; state non-goals. Check that the result serves the requested users. Identify a misread user ask, unmet user need, unstated assumption, flawed premise, gold-plating, XY problem, conflicting constraints, and missing prerequisites; add nothing beyond the ask. Keep the existing format of rendered output unless a recorded user decision changes it. Route a design or plan that changes intent through the user gate.
- **maintainability** — Delete › reuse › stdlib or platform › installed dependency › new; never add a dependency for a few lines. DRY: one source of truth; search the repository by name and behaviour for an existing equivalent before adding any exported/shared symbol, helper, module or type. Rule of three: extract on third use; duplication beats wrong abstraction. YAGNI, KISS; deep modules, low coupling, high cohesion. Remove needless branches; fix root causes once. Split by responsibility, never by length; add no helper that only shortens a function. A fix or remedy is the smallest change that removes the defect: prefer deletion; add no layer, config or dependency the defect does not need. Simplicity floor: simplification never removes trust-boundary validation, data-loss guards, security or accessibility controls, or requested behaviour; moved or merged code keeps its error handling and validation. Preserve Chesterton's fence; names/docs/comments explain why and track behaviour. Check [document layers](../spec-stage.md#readers-and-document-layers); cite upstream IDs, not earlier layers. Smells (judgement calls, never `blocks` or `critical` alone): Duplicated Code, Feature Envy, Data Clumps, Primitive Obsession, Shotgun Surgery, Divergent Change, Repeated Switches, Message Chains, Middle Man, Speculative Generality, Refused Bequest, Mysterious Name.
- **correctness** — State system-wide invariants that hold within and across increments, and check domain-valid formulas and algorithms, preconditions, postconditions, and invariants; type-valid but domain-invalid states; valid transitions and reachable states; off-by-one errors; units, signs, and scales; runtime behavior; and type validity.
- **reliability** — Cover edge, boundary, empty, and zero inputs; unhandled branches; partial failures and updates; atomicity and crash consistency; idempotency; races and TOCTOU; floating promises; fail-closed behavior; data loss; and destructive-operation guards.
- **security** — Map trust boundaries and least privilege; use STRIDE at design altitude (spoofing, tampering, repudiation, information disclosure, denial of service, and elevation of privilege) and OWASP/CWE at code altitude; check injection, traversal, and missing escaping; authorization and IDOR; isolation, input validation, and object ownership; and sensitive data in logs or errors.
- **performance** — Check Big-O on hot paths, N+1 queries and work, unpaginated reads, and missing indexes; index new filter or sort columns. Check backpressure, bounded queues, concurrency and memory, closed handles and resource closure, and event-loop blocking. Judge scale against the expected load in the governing spec, host docs or deploy config, and name the assumed load.
- **compatibility** — Check breaking changes, Hyrum's law, semver, expand/contract migrations, rollback, version skew with graceful degradation, affected callers, persisted schemas and serialized formats, and portability across OS, shell, path, and encoding.
- **operability** — Check deployment and runtime operation, observability through logs, metrics, and traces, actionable diagnostics, configuration, and a kill switch.
- **usability** — Check WCAG accessibility, POLA (least astonishment), accessible UI, CLI/API ergonomics, and actionable errors.

- **spec** — Apply IEEE 29148 quality: requirements are unambiguous (one interpretation), consistent, verifiable, complete, feasible, and singular (one requirement per statement; identify non-singular requirements). Check completeness across behavior, interfaces and data, failure and recovery, quality requirements, assumptions, and dependencies. Identify misplaced architecture or execution detail while retaining imposed design constraints. An open question that could change scope, behavior, or risk blocks approval; never invent intent, and route a gap through the user gate.

- Artifact layout: Give each artifact one outcome summary: At a Glance **What** states it and **How it works** adds one method line. State each visible fact once; a summary must add a distinct view, not restate a later visible section. A visible summary may restate collapsed `<details>` detail. Keep task and increment behaviour visible before `<details>`; use the block for file changes and verbose detail. Use `> [!NOTE]` for information the user must know and `> [!IMPORTANT]` only for a decision they must make, consistent with `Decide:` when present. Keep machine fields outside callouts, prefer point form, and retain every required field.

### Visual-aid bar

A visual aid is a diagram, table, code, pseudo-code or data block. Include one when it explains content prose explains poorly, gives a skimmable map of three or more related items in long prose, or lets a reader grasp collapsed `<details>` detail, such as file changes, criteria or flow, without expanding it. Choose the smallest useful view that answers the reader’s question. Include relevant unchanged ownership, boundaries or flow; distinguish current context from proposed change with labels or diff notation, not color alone. Keep explanatory text adjacent. Match the content to its form:

| Content | Form |
| --- | --- |
| Components and boundaries | Architecture diagram |
| Ownership and call context | Shallow tree or call tree |
| Runtime order | Flow or sequence diagram |
| Lifecycle | State diagram |
| Items with attributes | Table |
| Interfaces and data shapes | Code or data block |
| Algorithm | Pseudo-code |
| Behaviour change | Before/after table or snippet |
| Changed structure in context | Diff sketch |

Reject decorative or stale visuals and visuals that duplicate visible prose, tables or other visuals. Restating content found only in collapsed `<details>` is not duplication, because human readers skip those blocks; a visual that disagrees with that content is stale. A repeated visual or required table needs to reveal new structure, such as parallel lanes or a critical path. Add no fixed count. Give each diagram a one-line text summary; tables and code/data blocks need none. Put orientation visuals in At a Glance and section visuals beside their prose. For worked examples, see [artifact readability](../artifact-readability.md).

- Shared criteria: apply the shared section to proposed changes and touched interfaces at planning altitude; do not require written implementation.
- Plan standard: authors and reviewers share it. A plan states observable outcomes, binding interfaces and invariants, ownership, dependencies, failure behavior and verification. Specify an exact algorithm only when correctness or a binding constraint depends on that choice; routine implementation choices stay with the writer.
- **architecture** — Preserve the increment's inherited contract and acceptance criteria. Check producer/consumer mismatches, step order, self-contradiction, boundary leaks, and consistency with host rules and specs. Treat the governed design as settled; raise a design-changing proposal through the orchestrator's amendment path.
- **decomposition** — Check the prerequisite DAG, ownership boundaries, producer/consumer contracts, and claimed independence. A task that consumes another's output without a prerequisite is a defect. Treat contention on a shared write path as a defect only when neither a `Requires` ordering nor a justified `Overlap:` line covers it. Shared port, cache, or output contention needs a prerequisite. Keep tasks meaningful, neither fragmented nor oversized; use independently deliverable vertical slices with INVEST task sizing, safe parallel work, and final integration. Check whether risk is concentrated in one increment.
- Test planning: make each criterion observable through a named behavior test or exact verification step, its `Seams:` entry, pass/fail outcomes and edge cases. `<skills-dir>/dispatch/references/templates/plan.md#field-notes` governs test selectors and named-test matching; any violation is a defect.
- Tooling: skip issues that configured linters, formatters, or type checkers enforce.

- **testing** — Proof tests drive TDD, fail RED for the right reason and are disposable. Retain a regression-spec test only if it passes every gate:
  1. Contract: behaviour observable at the unit's interface by any consumer, internal ones included (returns, errors, readable or persisted state, emitted payloads, required or prohibited effects, invariants), traced to a REQ, DEC, documentation or past defect.
  2. Defect: a named plausible regression, severe (contract breakage, state corruption, data loss, security-boundary violation, broken protocol transition) or non-obvious (a past defect or surprise missed by review).
  3. Oracle: requirement-derived and discriminating; exact for deterministic output, else a property, invariant, relation or tolerance; fails on broken behaviour, passes a behaviour-preserving refactor.
  4. Unique kill: no other retained test or configured static check catches that regression; static checks never prove runtime authorization or state transitions.
- Shape: one case per equivalence class and boundary; one layer per distinct failure, the lowest that observes it; merge only within one consumer scenario; tabulating is not merging. Prefer FIRST tests with diagnostic failures. When mocks, fixtures or infrastructure outweigh regression risk, use the closest executable or review evidence and record the limit.
- Prune: delete or merge gate failures by category: static-enforced or trivial; coverage padding; redundant; implementation-coupled (private state, call order, mock counts, or wording and structure outside the contract); tautological (self-derived expectations, source restatements, test-created data); no required contract. Rewrite weak oracles (truthy, no-throw, shape-only) guarding retained contracts. Flag required contracts, failure modes and seams lacking a spec test. Keep a test while required-contract doubt remains.
- Naming: name tests, describe blocks, files, comments, section headers and fixtures for behaviour; never cite plan artifacts (criterion, task or finding IDs, plan or session paths).

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

### Severity
Rate each finding on two dimensions; the toolkit derives severity from them. Report `impact` and `trigger`, never `severity`.
- `impact`: `critical` — security breach or irreversible data loss; `blocks` — the promised outcome or a binding constraint fails; `degrades` — a real defect that lowers the outcome without blocking it; `minor` — a small defect with negligible effect, or an optional improvement, which is `contrived` because no failure occurs.
- `trigger`: `realistic` — normal use or one plausible fault produces it; `contrived` — it needs several independent faults, contrived input, or no failure at all.

| `impact` | `trigger: realistic` | `trigger: contrived` |
|---|---|---|
| `critical` | `MUST` | `MUST` |
| `blocks` | `MUST` | `SHOULD` |
| `degrades` | `SHOULD` | `CONSIDER` |
| `minor` | `SHOULD` | `CONSIDER` |

A `critical` finding's `defect` names the boundary crossed or the data lost.
Severity is resolution priority: resolve `MUST` first, then `SHOULD`; `CONSIDER` is optional.
In plan reviews, `blocks` means the plan as written cannot deliver its outcome or breaks a binding
constraint. A gap that the plan's own Verify gates would surface deterministically during
implementation, such as a fixture update or a test assertion, is `degrades`, not `blocks`.
In `defect`, state the concrete consequence at the locus; in `requiredChange`, the remedy.
Ground each finding in a concrete failure scenario, a host rule, a measurable cost, or a known
vulnerability class. Preference is not a finding; between technically equivalent approaches, the
author's choice stands. Simplicity findings name the cost removed: concepts, files, or code paths.
Report one finding per defective predicate; list every failing state of it in `defect`.

### Reply
Reply with one JSON object of all findings as the last thing in the reply, on its own line or in a final fenced block. If JSON cannot carry a finding, write it as plain
text. For a clean review use:
```json
{"status":"CLEAN","findings":[]}
```

Otherwise use status `FINDINGS` and one or more findings with every field:
```json
{"status":"FINDINGS","findings":[{"impact":"critical|blocks|degrades|minor","trigger":"realistic|contrived","locus":"§ <Plan heading>","tag":"<tag>","defect":"<defect>","requiredChange":"<required change>"}]}
```

Use only the tags above.
Cite existing code as `path/to/file:L<line>` inside `defect`.
For an adjacent finding, use the nearest plan heading as locus.
