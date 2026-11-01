Review the completed implementation adversarially: challenge the requirement, the author's mental model, and the diff. Judge delivery of the original ask and success criteria, beyond plan conformance.

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
- The governing spec's REQs and DECs and, when supplied, the plan's `## Success Criteria`:
  assess each applicable criterion from the selected diff and tests. A goal missed or met only
  on paper, such as a test passing without exercising it, is `intent`.
- Behaviour the diff adds that no REQ asks for at a consumer boundary (public API or CLI surface, outputs, persisted data, side effects, dependencies) is an `intent` finding; internal helpers and refactors are not.
- Code review does not establish that verification commands ran or final gates passed.
  Execution evidence and final verification remain separate workflow gates.
- With a plan, its `## Key Decisions & Context` entries are settled, like the spec's DECs. Do not
  propose an alternative to a settled decision as a fix; report a contradiction with one only as
  `intent`, and cite the decision in `defect`.
- An attached "Approved technical-design context" section: the increment's acceptance criteria.

Judge quality using the selected sections of the [quality bar](quality-bar.md).
Anchor reuse findings on the new symbol and cite the existing equivalent as `path:L<line>` in `defect`. Reuse searches do not count toward the target.
Anchor a code `spec` finding on the changed code line and cite `§ Spec: <heading>` in `defect`.

### Inspection
Inspect by reading and searching files, running read-only commands in the foreground. A reviewer may run a host read tool that creates or updates only its own cache or index, unless a stricter host rule forbids it.
For any delegation already permitted by the assignment, use available host controls to request fresh context without parent conversation history. If unsupported or unverifiable, continue and report the limitation through existing reporting channels. Give each new child a self-contained brief with this launch instruction; preserve required reply schemas.
Verification evidence comes from the orchestrator; run no test or build commands.
Adhere to the host rule files that the quality section's discovery rule finds.
Report host-rule violations on changed lines or sections as `standards`; elsewhere, report them as `adjacent`.
A pattern that matches established local convention is not a finding;
when the convention itself is defective, report it once and name the other instances in `defect`.
Read the whole spec at Spec Path before inspection; use Spec Hash as its governing identity.

Obey an explicit Git range in Scope. Otherwise inspect unstaged, staged, and untracked
source/text files, excluding `.scratch/`, generated, vendored, and binary paths. When those are
empty, use only the caller-supplied merge-base-to-`HEAD` range. Never substitute `HEAD~1`.
Inspect changed hunks plus adjacent call sites, interfaces, and tests needed to verify a claim.
On a `Full review`, when the diff changes a shared invariant, contract, or signature, list every
caller of it and inspect each one in this round, so later rounds do not find them one at a time.
Use the repository's code-graph index (for example CodeGraph callers) when one exists; otherwise
search the repository.
For every review kind, findings apply to the captured revision and Scope. Inspect required callers, interfaces, host rules and governing material even outside Scope. Report concrete existing-code defects encountered in the selected target or during that required inspection; inspect other adjacent material only to substantiate a defect. Spend no extra turns hunting for adjacent findings. Preserve original provenance; the host selects applicability to later content under [review rules](../review-rules.md#review-provenance-and-applicability).
Read the full review history in the review log that each governing artifact's `## Review Findings & Resolutions` links. Consult raw provider output or ledger records when missing evidence, disputed adjudication or recovery requires it; follow [review rules](../review-rules.md) for ownership and ruling semantics. History does not replace source inspection.
On re-review, verify prior resolutions in that review log, and treat
earlier settled findings as closed. The governing spec's Decisions and Non-goals, and decisions recorded in the governing design or plan, are settled:
contest one only by naming it and citing evidence it did not weigh. When Scope names changed sections or paths, raise new in-scope
findings only there; `adjacent` findings may cite any locus. Stop at that blast radius.
- Host rule files: before judging or editing, find every file that sets conventions for in-scope paths. Check `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `CONTRIBUTING.md`, `CODING_STANDARDS.md`, linked style guides, and in-scope nested copies; nearest wins. Read applicable rules; skip rules enforced by configured linters, formatters or type checkers.
- Precedence: Applicable host rule files govern first. This bar supplements host rules where they are silent and yields where they conflict. Preference applies only where both are silent.
- Host rules override only this bar. Plan scope, write boundaries, verification and safety stay fixed. Writers report host-rule/brief conflicts under concerns; reviewers exclude them from findings.
- **intent** — Trace the ask to applicable REQs and DECs, and check that each is served. Map requirements to changes and goals to requirements; state non-goals. Check that the result serves the requested users. Identify a misread user ask, unmet user need, unstated assumption, flawed premise, gold-plating, XY problem, conflicting constraints, and missing prerequisites; add nothing beyond the ask. Keep the existing format of rendered output unless a recorded user decision changes it. Route a design or plan that changes intent through the user gate.
- **maintainability** — Delete › reuse › stdlib › new. DRY: one source of truth; search the repository by name and behaviour for an existing equivalent before adding any exported/shared symbol, helper, module or type. Rule of three: extract on third use; duplication beats wrong abstraction. YAGNI, KISS; deep modules, low coupling, high cohesion. Remove needless branches; fix root causes once. Preserve Chesterton's fence; names/docs/comments explain why and track behaviour. Check [document layers](../spec-stage.md#readers-and-document-layers); cite upstream IDs, not earlier layers. Smells (judgement calls, never `MUST` alone): Duplicated Code, Feature Envy, Data Clumps, Primitive Obsession, Shotgun Surgery, Divergent Change, Repeated Switches, Message Chains, Middle Man, Speculative Generality, Refused Bequest, Mysterious Name.
- **correctness** — State system-wide invariants that hold within and across increments, and check domain-valid formulas and algorithms, preconditions, postconditions, and invariants; type-valid but domain-invalid states; valid transitions and reachable states; off-by-one errors; units, signs, and scales; runtime behavior; and type validity.
- **reliability** — Cover edge, boundary, empty, and zero inputs; unhandled branches; partial failures and updates; atomicity and crash consistency; idempotency; races and TOCTOU; floating promises; fail-closed behavior; data loss; and destructive-operation guards.
- **security** — Map trust boundaries and least privilege; use STRIDE at design altitude (spoofing, tampering, repudiation, information disclosure, denial of service, and elevation of privilege) and OWASP/CWE at code altitude; check injection, traversal, and missing escaping; authorization and IDOR; isolation, input validation, and object ownership; and sensitive data in logs or errors.
- **performance** — Check Big-O on hot paths, N+1 queries and work, unpaginated reads, and missing indexes; index new filter or sort columns. Check backpressure, bounded queues, concurrency and memory, closed handles and resource closure, and event-loop blocking.
- **compatibility** — Check breaking changes, Hyrum's law, semver, expand/contract migrations, rollback, version skew with graceful degradation, affected callers, persisted schemas and serialized formats, and portability across OS, shell, path, and encoding.
- **operability** — Check deployment and runtime operation, observability through logs, metrics, and traces, actionable diagnostics, configuration, and a kill switch.
- **usability** — Check WCAG accessibility, POLA (least astonishment), accessible UI, CLI/API ergonomics, and actionable errors.

- **spec** — Check the implementation against applicable requirements, decisions, and constraints. Treat ambiguous or contradictory governing text, an unverifiable requirement, or a missing constraint as a spec defect; do not invent intent.
- **testing** — Apply one two-tier bar. Implementation tests drive TDD: each fails RED for the right reason, derives expected results from requirements, and is disposable. Retained tests are the executable spec of a current consumer contract that is severe if broken or non-obvious (e.g. a past defect or surprise missed by review/static checks). Severe: consumer-facing contract breakage, state corruption, data loss, security-boundary violations, or broken protocol transitions. Each overlapping test must add distinct protection; name its consumer, failure and protection (e.g. retry cannot duplicate a committed payment). Skip trivial/mechanical tests, unimportant round-trips, and guarantees configured static checks actually enforce; static checks do not guarantee runtime authorization or state transitions. Break promised behavior, then restructure internals without changing behavior: useful tests fail the first and pass the second. Exercise consumer interfaces; assert requirement-derived observable values, used errors, readable state, external payloads, prohibited/duplicate effects, or invariants. Check seams, failure-mode gaps, tautologies, change detectors, and mutation-style break-it checks. Prefer FIRST (deterministic, isolated); preserve meaningful failures. Self-derived expectations, source restatements, and assertions on test-created data prove nothing unless that artifact is the contract. Judge counts, wording, structure, and external calls by the contract. Retain multiple layers only for distinct failures; group one consumer scenario, not unrelated behavior. Tabulating unchanged cases does not reduce work. Prefer existing checks; if brittle mocks, broad unrelated fixtures, or costly infrastructure outweigh regression value, use closest executable/review evidence and record the limit. Rewrite weak tests; delete hollow/redundant tests. Coverage never justifies retention. Resolve required-contract uncertainty before deletion. Test naming: name tests, describe blocks, test files, comments, section headers, and fixtures for behavior; never reference plan artifacts such as criterion, task, or finding IDs, plan paths, or session paths.
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
- `operability`
- `testing`
- `usability`
- `standards`
- `adjacent`

### Budget
The tool-turn target is advisory: stop early when grounded; exceed it only for an evidenced
in-scope risk.

### Severity
Severity is resolution priority. `MUST`: blocks the promised outcome or breaks a binding
constraint. `SHOULD`: real defect that degrades the outcome without blocking it. `CONSIDER`: optional
improvement; no defect.
In `defect`, state the concrete consequence at the locus; in `requiredChange`, the remedy.
Ground each finding in a concrete failure scenario, a host rule, a measurable cost, or a known
vulnerability class. Preference is not a finding; between technically equivalent approaches, the
author's choice stands. Simplicity findings name the cost removed: concepts, files, or code paths.
Report one finding per defective predicate; list every failing state of it in `defect`.

### Reply
Reply with one JSON object of all findings. If JSON cannot carry a finding, write it as plain
text. For a clean review use:
```json
{"status":"CLEAN","findings":[]}
```

Otherwise use status `FINDINGS` and one or more findings with every field:
```json
{"status":"FINDINGS","findings":[{"severity":"MUST|SHOULD|CONSIDER","locus":"<relative-file>:L<line>","tag":"<tag>","defect":"<defect>","requiredChange":"<required change>"}]}
```

Use only the tags above.
Anchor every in-scope finding on a line the diff adds or changes; a finding anchored anywhere else
is `adjacent`.
For an `adjacent` finding, cite code at its real `path:L<line>` locus.
