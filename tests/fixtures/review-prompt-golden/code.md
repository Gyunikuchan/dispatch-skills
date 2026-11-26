Review the completed implementation adversarially: challenge the requirement, the author's mental model, and the diff. Judge delivery of the original ask and success criteria, beyond plan conformance. Inspect critically.

### Context
- Task: Add a retry budget to the fetch helper
- Spec Path: .scratch/example/example.spec.md
- Spec Hash: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
- Plan: .scratch/example/example.plan.md
The Spec Hash is the canonical identity reported by lint; it is not a hash of the raw file bytes.
- Focus: General review
- Scope: Full review
- Advisory Tool Turn Target: 10

### Review against
- The governing spec's REQs and DECs and, when supplied, the plan's `## Success Criteria`: assess each applicable criterion from the selected diff and tests. A goal missed or met only on paper, such as a test passing without exercising it, is `intent`.
- Behaviour the diff adds that no REQ asks for at a consumer boundary (public API or CLI surface, outputs, persisted data, side effects, dependencies) is an `intent` finding; internal helpers and refactors are not.
- Code review does not establish that verification commands ran or final gates passed. Execution evidence and final verification remain separate workflow gates.
- With a plan, its `## Key Decisions & Context` entries are settled, like the spec's DECs. Do not propose an alternative to a settled decision as a fix; report a contradiction with one only as `intent`, and cite the decision in `defect`.
- An attached "Approved technical-design context" section: the increment's acceptance criteria.

Judge quality using the quality criteria below. Anchor reuse findings on the new symbol and cite the existing equivalent as `path:L<line>` in `defect`. Reuse searches do not count toward the target. Anchor a code `spec` finding on the changed code line and cite `§ Spec: <heading>` in `defect`.

### Inspection
Inspect by reading and searching files, running read-only commands in the foreground. A reviewer may run a host read tool that creates or updates only its own cache or index, unless a stricter host rule forbids it.
Read directly; launch no subagents.
Verification evidence comes from the orchestrator; run no test or build commands.
Read the whole spec at Spec Path first.
Report host-rule violations on changed lines or sections as `standards`; elsewhere, report them as `adjacent`.
A pattern that matches established local convention is not a finding;
when the convention itself is defective, report it once and name the other instances in `defect`.
Obey an explicit Git range in Scope. Otherwise inspect unstaged, staged, and untracked source/text files, excluding `.scratch/`, generated, vendored, and binary paths. When those are empty, use only the caller-supplied merge-base-to-`HEAD` range. Never substitute `HEAD~1`. Inspect changed hunks plus adjacent call sites, interfaces, and tests needed to verify a claim. On a `Full review`, when the diff changes a shared invariant, contract, or signature, list every caller of it and inspect each one in this round, so later rounds do not find them one at a time. Use the repository's code-graph index (for example CodeGraph callers) when one exists; otherwise search the repository.
For every review kind, findings apply to the captured revision and Scope. Inspect required callers, interfaces, host rules and governing material even outside Scope. Report concrete existing-code defects encountered in the selected target or during that required inspection; inspect other adjacent material only to substantiate a defect. Spend no extra turns hunting for adjacent findings. Preserve original provenance; the host selects applicability to later content under review rules.
The governing spec's Decisions and Non-goals, and decisions recorded in an approved governing design or plan other than the artifact under review, are settled: contest one only by naming it and citing concrete evidence it did not weigh; do not re-raise style preferences or checks enforced by configured linters, formatters or type checkers.
- Host rule files: before judging or editing, find every file that sets conventions for in-scope paths (`AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `CONTRIBUTING.md`, `CODING_STANDARDS.md`, linked style guides, in-scope nested copies; nearest wins); read applicable rules, skipping linter/formatter/type-checker-enforced checks.
- Precedence: Applicable host rule files govern first. This bar supplements host rules where they are silent and yields where they conflict. Preference applies only where both are silent. Host rules may tighten, never widen, scope, write boundaries, verification and safety.
- Exclude host-rule/brief conflicts from findings.
- Evidence: For external formats, limit claims to the sample inspected against the population and state its uncertainty. For absence claims, check the search method's exclusions (ignored paths, file types, generated output, dynamic dispatch) and cite direct evidence the host supports (index query, reference lookup, or exhaustive listing); else mark it unverified.
- Altitude: check document layers (Spec owns intent, REQ acceptance, constraints and user DECs. Optional Design owns architectural strategy and ADs. Plan owns tactics, tasks, interfaces and verification. Implementation owns routine writer choices. Walkthrough owns delivered behavior, evidence, deviations and findings. Cite upstream IDs instead of restating their layer.)
- **intent** — Trace the ask to applicable REQs and DECs and verify each is served; map goals to requirements to changes, and state non-goals. Serve the requested users; catch misread asks, unmet needs, unstated assumptions, flawed premises, gold-plating, XY problems, conflicting constraints, and missing prerequisites without adding beyond the ask. Keep the existing format of rendered output unless a recorded user decision changes it. Route intent changes through the user gate.
- **maintainability** — Delete › reuse › stdlib or platform › installed dependency › new; never add a dependency for a few lines. DRY: one source of truth; search the repository by name and behaviour for an existing equivalent before adding an exported/shared symbol, helper, module or type. Rule of three: extract on third use; duplication beats wrong abstraction. YAGNI, KISS; deep modules, low coupling, high cohesion; drop needless branches, fix root causes. Split by responsibility, never by length; no length-only helpers. A fix or remedy is the smallest change that removes the defect: prefer deletion; add no layer, config or dependency the defect does not need. Simplicity floor: simplification never removes trust-boundary validation, data-loss guards, security or accessibility controls, or requested behaviour; moved or merged code keeps its error handling and validation. Preserve Chesterton's fence; names/docs/comments explain why and track behaviour. Flag coupling/cohesion defects (shotgun surgery, divergent change, leaky abstractions, CQS) only when the fix removes concrete concepts, files, or code paths; never `blocks` or `critical` alone.
- **correctness** — State system-wide invariants that hold within and across increments; check domain-valid formulas/algorithms, pre/postconditions, invariants, type-valid but domain-invalid states, valid transitions/reachable states, off-by-one errors, units/signs/scales, runtime behavior, and type validity.
- **reliability** — Cover edge/boundary/empty/zero inputs, unhandled branches, partial failures and updates, atomicity/crash consistency, idempotency, races/TOCTOU, floating promises, fail-closed behavior, data loss, and destructive-operation guards.
- **security** — Map trust boundaries and least privilege; apply STRIDE at design (spoofing, tampering, repudiation, information disclosure, denial of service, and elevation of privilege) and OWASP/CWE at code: check injection, traversal, escaping, authz/IDOR, isolation, input validation, object ownership, and sensitive data in logs/errors.
- **performance** — Check hot-path Big-O, N+1 work, unpaginated reads, missing indexes (index new filter or sort columns), backpressure, bounded queues, concurrency/memory, closed handles and resource closure, and event-loop blocking. Judge scale against the expected load in governing spec, host docs, or deploy config, and name the assumed load.
- **compatibility** — Check breaking changes, Hyrum's law, semver, expand/contract migrations, rollback, version skew with graceful degradation, affected callers, persisted schemas and serialized formats, and portability across OS, shell, path, and encoding.
- **operability** — Check deployment and runtime operation, observability through logs, metrics, and traces, actionable diagnostics, configuration, and a kill switch.
- **usability** — Check WCAG accessibility, POLA (least astonishment), accessible UI, CLI/API ergonomics, and actionable errors.

- **spec** — Check the implementation against applicable requirements, decisions, and constraints. Treat ambiguous or contradictory governing text, an unverifiable requirement, or a missing constraint as a spec defect; do not invent intent.
- Naming & comments: one concept per term; give names domain meaning with units/qualifiers, avoiding filler (`data`, `info`, `manager`, `helper`, `util`, `temp`) and arbitrary numeric suffixes. Rename for meaning, never taste; keep external contracts (public APIs, exports, persisted schemas/keys, events, env vars, CLI flags) intact and align glossaries. Comment rationale or external facts only; lift facts into names before deleting narrating, non-host section-label, or dead-code comments, keeping host dividers (`// SECTION:`), active `TODO:`/`FIXME:`, and linter/doc directives.
- Safe DRY: match duplicates by intent, not text; drop pass-through wrappers and generic `utils`/`helpers` destinations. Unify only after verifying identical behavior across all five axes—boundaries/rounding/units, empty/null/invalid inputs, timezone/locale/text, errors, and side-effect ordering/logging—and testing call-site nuances before migrating callers. Leave copies separate and report them (never auto-unify or gate) when they differ on any axis, look coincidental, need >2–3 options, or touch high-stakes domains (money, auth/permissions, migrations, concurrency/locking).
- Tooling: skip issues that configured linters, formatters, or type checkers enforce.

- **testing** — Proof tests drive TDD and fail RED for the right reason. A durable regression-spec test changes only with intended behaviour, fails only on a real regression, and meets four gates:
  1. Contract: observable unit interface behaviour (returns, errors, persisted state, payloads, required/prohibited effects, invariants) for any consumer, internal included, traced to a REQ, DEC, doc or past defect.
  2. Defect: named plausible regression—severe (contract breakage, state corruption, data loss, security-boundary violation, broken protocol transition) or non-obvious (past defect or review-missed surprise).
  3. Oracle: requirement-derived and discriminating—exact for deterministic output, else a property, invariant, relation or tolerance; fails on broken behaviour, passes behaviour-preserving refactors.
  4. Unique kill: no other retained test or static check catches it; static checks never prove runtime authorization or state transitions.
- Shape: one case per equivalence class and boundary; push failures down the fastest-first ladder (pure logic > unit/service > integration/route/component > end-to-end/browser); merge only within one consumer scenario (tabulating is not merging). Use typed boundary fakes verified by shared contract/round-trip checks, asserting state over call counts, exact literal values, and format-pattern assertions over type-only matchers. Amortize expensive setup at the highest viable level (`Run > File > Test`); prefer FIRST tests with diagnostic failures; never add a browser/E2E harness to a repository without one. When setup or mocks outweigh regression risk, use closest executable or review evidence and record the limit.
- Prune: default-delete or downgrade unless a test positively passes all four gates at the cheapest layer (keep on doubt only if an undocumented external contract loses sole proof). Downgrade over-tiered tests in plan review, cleanup, and code review. Delete or merge: **the past** (stale tests for removed/moved/superseded spec or code); **nothing** (runtime/framework/type guarantees, self-mocked/self-derived/source-restated assertions, padding, duplicates); **the implementation** (mirrored logic, private state, call order, mock counts, non-contract wording); and dedicated tests for straight-line/lightly-branching glue or wrappers lacking nested control flow, compound booleans, regexes, parsers, math/date formulas, or simplicity-floor boundaries (security, auth, trust boundaries, persistence/atomicity, protocol transitions). Rewrite weak oracles (truthy, no-throw, key-shape-only without values) on retained contracts; flag uncovered contracts, failures, and seams for coverage, plus unused test-only production helpers for removal. Code review enforces this and never reverses bar-compliant pruning/downgrades.
- Naming: name tests, describe blocks, files, comments, headers and fixtures for behaviour; never cite plan artifacts (criterion, task or finding IDs, plan or session paths).

### Tags
Tag each finding with one bold family from the quality criteria above, `standards` or `adjacent`; the bold bullets define each family.

### Budget
The tool-turn target is advisory: stop early when grounded; exceed it only for an evidenced
in-scope risk.
CLI delegates get a `[DEADLINE]` header: answer before it; if a `wrap-up at` time is listed (~5m earlier), stop tool calls when prompted and answer from work done so far.

### Severity
Rate each finding on two dimensions; the toolkit derives severity from them. Report `impact` and `trigger`, never `severity`.

- `impact`: `critical` — security breach or irreversible data loss; `blocks` — the promised outcome or a binding constraint fails; `degrades` — a real defect that lowers the outcome without blocking it; `minor` — a small defect with negligible effect or an optional improvement (always `CONSIDER`).
- `trigger`: `realistic` — normal use or one plausible fault produces it; `contrived` — it needs several independent faults, contrived input, or no failure at all.

| `impact` | `trigger: realistic` | `trigger: contrived` |
|---|---|---|
| `critical` | `MUST` | `MUST` |
| `blocks` | `MUST` | `SHOULD` |
| `degrades` | `SHOULD` | `CONSIDER` |
| `minor` | `CONSIDER` | `CONSIDER` |

A `critical` finding's `defect` names the boundary crossed or the data lost. Severity is resolution priority: resolve `MUST` first, then `SHOULD`; `CONSIDER` is optional.
In `defect`, state the concrete consequence at the locus; in `requiredChange`, the remedy.
Ground each finding in a concrete failure scenario, a host rule, a measurable cost, or a known
vulnerability class. Preference is not a finding; between technically equivalent approaches, the
author's choice stands. Simplicity findings name the cost removed: concepts, files, or code paths.
Report one finding per defective predicate; list every failing state of it in `defect`.

### Reply
Reply with one JSON object of all findings as the last thing in the reply, on its own line or in a final fenced block. If JSON cannot carry a finding, write it as plain
text. When all requirements, invariants, and boundaries hold, return `CLEAN` — a clean review on sound work is the expected high-signal outcome:
```json
{"status":"CLEAN","findings":[]}
```

Otherwise use status `FINDINGS` and one or more findings with every field:
```json
{"status":"FINDINGS","findings":[{"impact":"critical|blocks|degrades|minor","trigger":"realistic|contrived","locus":"<relative-file>:L<line>","tag":"<tag>","defect":"<defect>","requiredChange":"<required change>"}]}
```

Anchor every in-scope finding on a line the diff adds or changes; a finding anchored anywhere else is `adjacent`. For an `adjacent` finding, cite code at its real `path:L<line>` locus.
