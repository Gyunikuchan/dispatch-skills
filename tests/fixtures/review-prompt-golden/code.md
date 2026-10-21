Review the implementation adversarially: challenge the requirement, the author's mental model, and
the diff. The implementation is complete: judge whether it delivers the original ask and meets its
success criteria well, not merely whether it matches the plan.

### Context
- Task: Add a retry budget to the fetch helper
- Spec Path: .scratch/example/example.spec.md
- Spec Hash: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
- Walkthrough: .scratch/example/example.walkthrough.md
- Plan: .scratch/example/example.plan.md
- Focus: General review
- Scope: Full review
- Advisory Tool Turn Target: Unspecified

### Review against
- The governing spec's REQs and DECs, the plan's `## Success Criteria`, and the walkthrough's
  `## Verification` table: every criterion row demonstrably met by the diff and its tests. A goal
  missed or met only on paper, such as a test passing without exercising it, is `intent`.
- With a plan, an absent or unfilled table is a `testing` finding; a plan-less walkthrough carries only its `Final gate:` line.
- When the walkthrough reads `Final gate: pending`, the final gate runs after this
  review. Judge criteria from the diff and tests, and raise no finding for pending
  Verification rows or finding-status sections.
- With a plan, its `## Key Decisions & Context` entries are settled, like the spec's DECs. Do not
  propose an alternative to a settled decision as a fix; report a contradiction with one only as
  `intent`, and cite the decision in `defect`.
- An attached "Approved technical-design context" section: the increment's acceptance criteria.

Judge quality using the selected sections of the [quality bar](quality-bar.md).
Anchor reuse findings on the new symbol and cite the existing equivalent as `path:L<line>` in `defect`.
Anchor a code `spec` finding on the changed code line and cite `§ Spec: <heading>` in `defect`.

### Inspection
Inspect by reading and searching files, running read-only commands in the foreground.
Verification evidence comes from the orchestrator; run no test or build commands.
Adhere to this project's conventions: read `AGENTS.md`, including nested ones on reviewed paths.
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
Read the full review history in the review log that each governing artifact's `## Review Findings & Resolutions` links. Consult raw provider output or journals
when missing evidence, disputed adjudication or recovery requires it; follow
`references/review-rules.md` for ownership and ruling semantics. History does not replace source inspection.
Findings apply to the captured revision and Scope. Report a concrete existing-code defect encountered while inspecting the selected target and interfaces or call sites needed to verify it; those interfaces or call sites may be outside Scope only as needed to substantiate the defect. Spend no extra turns hunting for adjacent findings. Apply this discovery rule to every review kind. Preserve original provenance; the host selects applicability to later content under [review rules](../review-rules.md#review-provenance-and-applicability).
On re-review, verify prior resolutions in the review log that `## Review Findings & Resolutions` links, and treat
earlier settled findings as closed. The governing spec's Decisions and Non-goals, and decisions recorded in the governing design or plan, are settled:
contest one only by naming it and citing evidence it did not weigh. When Scope names changed sections or paths, raise new in-scope
findings only there; `adjacent` findings may cite any locus. Stop at that blast radius.
- Precedence: Applicable host rule files govern first. For nested `AGENTS.md` files, the nearest file wins over its parent. This bar supplements host rules where they are silent and yields where they conflict. Preference applies only where both are silent.
- Host rules override only this bar. Plan scope, write boundaries, the outcome envelope and verification protocol, and safety rules stay fixed. Writers report a conflict between host rules and the brief under concerns; reviewers do not report such a conflict as a finding.
- **intent** — Trace the ask to applicable REQs and DECs, and check that each is served. Identify a misread user ask, unmet user need, unstated assumption, flawed premise, gold-plating, or XY problem; add nothing beyond the ask. Route a design or plan that changes intent through the user gate.
- **maintainability** — Prefer delete, reuse, stdlib, then new code. Keep one source of truth; search the repository by name and behaviour for an existing equivalent before adding a new exported or shared symbol, helper, module, or type. Apply the rule of three: extract on third use; duplication beats the wrong abstraction. Use YAGNI and KISS; prefer deep modules, clear seams, low coupling and high cohesion; avoid pass-through modules, speculative seams (one adapter is hypothetical), excess coupling, and abstractions without a concrete need. Remove unnecessary branches and fix root causes once. Preserve Chesterton's fence, and make names, docs, and comments explain why and change with behavior. Judge content against the [document layers](../spec-stage.md#readers-and-document-layers), and cite upstream IDs instead of restating an earlier layer.

- **spec** — Check the implementation against applicable requirements, decisions, and constraints. Treat ambiguous or contradictory governing text, an unverifiable requirement, or a missing constraint as a spec defect; do not invent intent.
- **correctness** — Check domain-valid formulas and algorithms, preconditions, postconditions, and invariants; type-valid but domain-invalid states; valid transitions and reachable states; off-by-one errors; units, signs, and scales; runtime behavior; and type validity.
- **reliability** — Check empty, zero, and boundary inputs; unhandled branches; partial failures and updates; atomicity and crash consistency; idempotency; races and TOCTOU; floating promises; fail-closed behavior; data loss; and destructive-operation guards.
- **security** — Check trust boundaries and least privilege; STRIDE at design altitude and OWASP/CWE at code altitude; injection, traversal, and missing escaping; authorization and IDOR; isolation, input validation, and object ownership; and sensitive data in logs or errors.
- **performance** — Check Big-O on hot paths, N+1 queries, unpaginated reads; index new filter or sort columns. Check backpressure, bounded queues, concurrency and memory, closed handles, and event-loop blocking.
- **compatibility** — Check breaking changes, Hyrum's law, semver, expand/contract migrations, rollback, version skew with graceful degradation, affected callers, persisted schemas and serialized formats, and portability across OS, shell, path, and encoding.
- **operability** — Check deployment and runtime operation, logs, metrics and traces, actionable diagnostics, configuration, and a kill switch.
- **testing** — Apply one behavioral bar to new, changed, and retained tests. Imagine two edits: break promised behavior, then restructure internals while preserving behavior. A useful test fails the first and passes the second. Exercise a consumer interface, derive expected results from requirements, and assert observable values, used errors, readable state, external payloads, prohibited or duplicate effects, or invariants. Check test gaps at seams and failure modes, tautologies, change-detector tests (transient-only tests are exempt), and mutation-style break-it checks. Prefer FIRST tests (deterministic, isolated) and preserve meaningful failure modes. Self-derived expectations, source-text restatements, and assertions on test-created data do not prove runtime behavior unless that artifact is the contract. Judge counts, wording, structure, and external calls by the contract. Keep tests at multiple layers only for distinct failures; group one consumer scenario, not unrelated behavior. Moving unchanged cases into a table does not reduce executed work. Prefer useful existing checks; when durable regression tests need brittle mocks, broad unrelated fixtures, or costly infrastructure without proportional value, use the closest executable or review evidence and record the limit. Rewrite weak tests, delete hollow or redundant tests, or mark step checks transient and trim them after review. Resolve uncertainty about a required contract before deletion. Test naming: name tests, describe blocks, test files, comments, section headers, and fixtures for behavior; never reference plan artifacts such as criterion, task, or finding IDs, plan paths, or session paths.
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
- `operability`
- `testing`
- `usability`
- `standards`
- `adjacent`

### Budget
The tool-turn target is advisory: stop early when grounded; exceed it only for an evidenced
in-scope risk.
If unspecified, target `8 + 2 × changed files`; on re-review count files changed since the prior
round only. Reuse searches do not count toward the target.

### Severity
Severity is resolution priority. `MUST`: blocks the promised outcome or breaks a binding
constraint. `SHOULD`: real defect that degrades the outcome without blocking it. `CONSIDER`: optional
improvement; no defect.
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
{"status":"FINDINGS","findings":[{"severity":"MUST|SHOULD|CONSIDER","locus":"<relative-file>:L<line>","tag":"<tag>","defect":"<defect>","requiredChange":"<required change>"}]}
```

Use only the tags above.
Anchor every in-scope finding on a line the diff adds or changes; a finding anchored anywhere else
is `adjacent`.
For an `adjacent` finding, cite code at its real `path:L<line>` locus.
