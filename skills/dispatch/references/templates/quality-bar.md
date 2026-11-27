# Quality bar

`domain/prompt.ts` `qualityBar(markdown, consumer, rotation, specStageMarkdown)` selects sections for review prompts and write briefs. Authors read the same sections through their author frame. Keep judging criteria here.

## shared

<!-- for: all -->

- Host rule files: before judging or editing, find every file that sets conventions for in-scope paths (`AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `CONTRIBUTING.md`, `CODING_STANDARDS.md`, linked style guides, in-scope nested copies; nearest wins); read applicable rules, skipping linter/formatter/type-checker-enforced checks.

<!-- for: all -->

- Precedence: Applicable host rule files govern first. This bar supplements host rules where they are silent and yields where they conflict. Preference applies only where both are silent. Host rules may tighten, never widen, scope, write boundaries, verification and safety.

<!-- for: writer,cleanup,verifier -->

- Report host-rule/brief conflicts under concerns or limits.

<!-- for: code,plan,design -->

- Exclude host-rule/brief conflicts from findings.

<!-- for: all -->

- Evidence: For external formats, limit claims to the sample inspected against the population and state its uncertainty. For absence claims, check the search method's exclusions (ignored paths, file types, generated output, dynamic dispatch) and cite direct evidence the host supports (index query, reference lookup, or exhaustive listing); else mark it unverified.
- Altitude: check [document layers](../spec-stage.md#readers-and-document-layers); cite upstream IDs, not earlier layers.
- **intent** — Trace the ask to applicable REQs and DECs and verify each is served; map goals to requirements to changes, and state non-goals. Serve the requested users; catch misread asks, unmet needs, unstated assumptions, flawed premises, gold-plating, XY problems, conflicting constraints, and missing prerequisites without adding beyond the ask. Keep the existing format of rendered output unless a recorded user decision changes it. Route intent changes through the user gate.

<!-- for: author -->

- Settled DECs, non-goals, and earlier accepted or rejected rulings follow [settled decisions](review-prompt.md#prompt-template) and [re-review closure](review-prompt.md#re-review-template).
- **maintainability** — Delete › reuse › stdlib or platform › installed dependency › new; never add a dependency for a few lines. DRY: one source of truth; search the repository by name and behaviour for an existing equivalent before adding an exported/shared symbol, helper, module or type. Rule of three: extract on third use; duplication beats wrong abstraction. YAGNI, KISS; deep modules, low coupling, high cohesion; drop needless branches, fix root causes. Split by responsibility, never by length; no length-only helpers. A fix or remedy is the smallest change that removes the defect: prefer deletion; add no layer, config or dependency the defect does not need. Simplicity floor: simplification never removes trust-boundary validation, data-loss guards, security or accessibility controls, or requested behaviour; moved or merged code keeps its error handling and validation. Preserve Chesterton's fence; names/docs/comments explain why and track behaviour. Flag coupling/cohesion defects (shotgun surgery, divergent change, leaky abstractions, CQS) only when the fix removes concrete concepts, files, or code paths; never `blocks` or `critical` alone.
- **correctness** — State system-wide invariants that hold within and across increments; check domain-valid formulas/algorithms, pre/postconditions, invariants, type-valid but domain-invalid states, valid transitions/reachable states, off-by-one errors, units/signs/scales, runtime behavior, and type validity.
- **reliability** — Cover edge/boundary/empty/zero inputs, unhandled branches, partial failures and updates, atomicity/crash consistency, idempotency, races/TOCTOU, floating promises, fail-closed behavior, data loss, and destructive-operation guards.
- **security** — Map trust boundaries and least privilege; apply STRIDE at design (spoofing, tampering, repudiation, information disclosure, denial of service, and elevation of privilege) and OWASP/CWE at code: check injection, traversal, escaping, authz/IDOR, isolation, input validation, object ownership, and sensitive data in logs/errors.
- **performance** — Check hot-path Big-O, N+1 work, unpaginated reads, missing indexes (index new filter or sort columns), backpressure, bounded queues, concurrency/memory, closed handles and resource closure, and event-loop blocking. Judge scale against the expected load in governing spec, host docs, or deploy config, and name the assumed load.
- **compatibility** — Check breaking changes, Hyrum's law, semver, expand/contract migrations, rollback, version skew with graceful degradation, affected callers, persisted schemas and serialized formats, and portability across OS, shell, path, and encoding.
- **operability** — Check deployment and runtime operation, observability through logs, metrics, and traces, actionable diagnostics, configuration, and a kill switch.
- **usability** — Check WCAG accessibility, POLA (least astonishment), accessible UI, CLI/API ergonomics, and actionable errors.

<!-- for: writer,cleanup -->

- Run no Git write commands (add, stash, commit, checkout, reset, restore).

## spec

- **spec** — Apply IEEE 29148 quality: requirements are unambiguous (one interpretation), consistent, verifiable, complete, feasible, and singular (one requirement per statement; identify non-singular requirements). Check completeness across behavior, interfaces and data, failure and recovery, quality requirements, assumptions, and dependencies. Flag misplaced architecture or execution detail while retaining imposed design constraints. An open question that could change scope, behavior, or risk blocks approval; never invent intent, and route a gap through the user gate.

- Visuals, summaries, and callouts: flag a visual aid or At a Glance summary when it is stale, contradicts governed or collapsed `<details>` content, or is decorative or duplicates visible prose/tables/visuals; flag `> [!NOTE]` (for information the user must know) or `> [!IMPORTANT]` (only for a decision they must make, consistent with `Decide:`) when misused or wrapping machine fields.

<!-- for: author -->

- Artifact layout: Give each artifact one outcome summary: At a Glance **What** states it and **How it works** adds one method line (except walkthroughs). State each visible fact once; a summary must add a distinct view, not restate a later visible section. A visible summary may restate collapsed `<details>` detail. Keep task and increment behaviour visible before `<details>` (except walkthroughs); use the block for file changes and verbose detail. Use `> [!NOTE]` for information the user must know and `> [!IMPORTANT]` only for a decision they must make, consistent with `Decide:` when present. Keep machine fields outside callouts, prefer point form, and retain every required field. For walkthroughs, show one outcome per task instead; link plan **How it works**, visuals and behaviour.

<!-- for: author -->

### Visual-aid bar

A visual aid is a diagram, table, code, pseudo-code or data block. Include one when it explains content prose explains poorly, gives a skimmable map of three or more related items in long prose, or lets a reader grasp collapsed `<details>` detail, such as file changes, criteria or flow, without expanding it. Choose the smallest useful view that answers the reader’s question. Include relevant unchanged ownership, boundaries or flow; distinguish current context from proposed change with labels or diff notation, not color alone. Keep explanatory text adjacent. Match the content to its form:

| Content                      | Form                          |
| ---------------------------- | ----------------------------- |
| Components and boundaries    | Architecture diagram          |
| Ownership and call context   | Shallow tree or call tree     |
| Runtime order                | Flow or sequence diagram      |
| Lifecycle                    | State diagram                 |
| Items with attributes        | Table                         |
| Interfaces and data shapes   | Code or data block            |
| Algorithm                    | Pseudo-code                   |
| Behaviour change             | Before/after table or snippet |
| Changed structure in context | Diff sketch                   |

Reject decorative or stale visuals and visuals that duplicate visible prose, tables or other visuals. Restating content found only in collapsed `<details>` is not duplication, because human readers skip those blocks; a visual that disagrees with that content is stale. A repeated visual or required table needs to reveal new structure, such as parallel lanes or a critical path. Add no fixed count. Give each diagram a one-line text summary; tables and code/data blocks need none. Put orientation visuals in At a Glance and section visuals beside their prose. For worked examples, see [artifact readability](../artifact-readability.md).

## code

- **spec** — Check the implementation against applicable requirements, decisions, and constraints. Treat ambiguous or contradictory governing text, an unverifiable requirement, or a missing constraint as a spec defect; do not invent intent.
- Naming & comments: one concept per term; give names domain meaning with units/qualifiers, avoiding filler (`data`, `info`, `manager`, `helper`, `util`, `temp`) and arbitrary numeric suffixes. Rename for meaning, never taste; keep external contracts (public APIs, exports, persisted schemas/keys, events, env vars, CLI flags) intact and align glossaries. Comment rationale or external facts only; lift facts into names before deleting narrating, non-host section-label, or dead-code comments, keeping host dividers (`// SECTION:`), active `TODO:`/`FIXME:`, and linter/doc directives.
- Safe DRY: match duplicates by intent, not text; drop pass-through wrappers and generic `utils`/`helpers` destinations. Unify only after verifying identical behavior across all five axes—boundaries/rounding/units, empty/null/invalid inputs, timezone/locale/text, errors, and side-effect ordering/logging—and testing call-site nuances before migrating callers. Leave copies separate and report them (never auto-unify or gate) when they differ on any axis, look coincidental, need >2–3 options, or touch high-stakes domains (money, auth/permissions, migrations, concurrency/locking).
- Tooling: skip issues that configured linters, formatters, or type checkers enforce.

## testing

- **testing** — Proof tests drive TDD and fail RED for the right reason. A durable regression-spec test changes only with intended behaviour, fails only on a real regression, and meets four gates:
  1. Contract: observable unit interface behaviour (returns, errors, persisted state, payloads, required/prohibited effects, invariants) for any consumer, internal included, traced to a REQ, DEC, doc or past defect.
  2. Defect: named plausible regression—severe (contract breakage, state corruption, data loss, security-boundary violation, broken protocol transition) or non-obvious (past defect or review-missed surprise).
  3. Oracle: requirement-derived and discriminating—exact for deterministic output, else a property, invariant, relation or tolerance; fails on broken behaviour, passes behaviour-preserving refactors.
  4. Unique kill: no other retained test or static check catches it; static checks never prove runtime authorization or state transitions.
- Shape: one case per equivalence class and boundary; push failures down the fastest-first ladder (pure logic > unit/service > integration/route/component > end-to-end/browser); merge only within one consumer scenario (tabulating is not merging). Use typed boundary fakes verified by shared contract/round-trip checks, asserting state over call counts, exact literal values, and format-pattern assertions over type-only matchers. Amortize expensive setup at the highest viable level (`Run > File > Test`); prefer FIRST tests with diagnostic failures; never add a browser/E2E harness to a repository without one. When setup or mocks outweigh regression risk, use closest executable or review evidence and record the limit.

<!-- for: writer -->

- Writer focus (task writers only; ignored by reviewers and test-cleanup): author failing RED proof tests first, implement to GREEN, and take free reign to author TDD/exploratory/proof tests, deferring pruning, merging, and tier downgrades to post-integration test cleanup.

<!-- for: code,plan,design,cleanup -->

- Prune: default-delete or downgrade unless a test positively passes all four gates at the cheapest layer (keep on doubt only if an undocumented external contract loses sole proof). Downgrade over-tiered tests in plan review, cleanup, and code review. Delete or merge: **the past** (stale tests for removed/moved/superseded spec or code); **nothing** (runtime/framework/type guarantees, self-mocked/self-derived/source-restated assertions, padding, duplicates); **the implementation** (mirrored logic, private state, call order, mock counts, non-contract wording); and dedicated tests for straight-line/lightly-branching glue or wrappers lacking nested control flow, compound booleans, regexes, parsers, math/date formulas, or simplicity-floor boundaries (security, auth, trust boundaries, persistence/atomicity, protocol transitions). Rewrite weak oracles (truthy, no-throw, key-shape-only without values) on retained contracts; flag uncovered contracts, failures, and seams for coverage, plus unused test-only production helpers for removal. Code review enforces this and never reverses bar-compliant pruning/downgrades.
- Naming: name tests, describe blocks, files, comments, headers and fixtures for behaviour; never cite plan artifacts (criterion, task or finding IDs, plan or session paths).

## plan

- Shared criteria: apply the shared section to proposed changes and touched interfaces at planning altitude; do not require written implementation.
- Plan standard: authors and reviewers share it. A plan states observable outcomes, binding interfaces and invariants, ownership, dependencies, failure behavior and verification. Specify an exact algorithm only when correctness or a binding constraint depends on that choice; routine implementation choices stay with the writer.
- Pins: each task names the tests, golden fixtures and byte or line ceilings that pin its touched files, with current headroom, and owns as [MODIFY] or [GENERATED] each golden, generated output or ceiling its change can exceed; a missing pin or headroom is a defect.
- **architecture** — Preserve the increment's inherited contract and acceptance criteria. Check producer/consumer mismatches, step order, self-contradiction, boundary leaks, and consistency with host rules and specs. Treat the governed design as settled; raise a design-changing proposal through the orchestrator's amendment path.
- **decomposition** — Check the prerequisite DAG, ownership boundaries, producer/consumer contracts, and claimed independence. A task that consumes another's output without a prerequisite is a defect. Treat contention on a shared write path as a defect only when neither a `Requires` ordering nor a justified `Overlap:` line covers it. Shared port, cache, or output contention needs a prerequisite. Keep tasks meaningful, neither fragmented nor oversized; use independently deliverable vertical slices with INVEST task sizing, safe parallel work, and final integration. Check risk concentration in one increment.
- Test planning: make each criterion observable through a named behavior test or exact verification step, its `Seams:` entry, pass/fail outcomes and edge cases. `<skills-dir>/dispatch/references/templates/plan.md#field-notes` governs test selectors and named-test matching; any violation is a defect.
- Tooling: skip issues that configured linters, formatters, or type checkers enforce.

## design

- Shared criteria: at design altitude, verify feasibility without requiring file-by-file plans.
- **architecture** — Define separation of concerns, component ownership, contracts, data flow, and boundaries. Each new contract names the existing code that produces each input it reads. Weigh alternatives and trade-offs, apply the shared simplicity order, and check internal consistency and step order.
- **testing** — Make every criterion observable and together sufficient for the goals, with each increment's acceptance criteria. Check testability and a verifiable acceptance strategy.
- **decomposition** — Choose independently deliverable, correctly ordered increments with safe parallel work, vertical slices, INVEST sizing, final integration, and no concentration of risk in one increment.
