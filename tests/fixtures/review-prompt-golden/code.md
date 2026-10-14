Review the implementation adversarially: challenge the requirement, the author's mental model, and
the diff. The implementation is complete: judge whether it delivers the original ask and meets its
success criteria well, not merely whether it matches the plan.

### Context
- Task: Add a retry budget to the fetch helper
- Walkthrough: .scratch/example/example.walkthrough.md
- Plan: .scratch/example/example.plan.md
- Focus: General review
- Scope: Full review
- Advisory Tool Turn Target: Unspecified

### Review against
- The task, the plan's `## Success Criteria` (with no plan, the task alone), and the walkthrough's
  `## Verification` table: every criterion row demonstrably met by the diff and its tests. A goal
  missed or met only on paper, such as a test passing without exercising it, is `intent`.
- With a plan, an absent or unfilled table is a `test-gap`; a plan-less walkthrough carries only its `Final gate:` line.
- An attached "Approved technical-design context" section: the increment's acceptance criteria.

### Inspection
Inspect by reading and searching files, running read-only commands in the foreground.
Verification evidence comes from the orchestrator; run no test or build commands.
Adhere to this project's conventions: read `AGENTS.md` / `CLAUDE.md`, including nested ones on
reviewed paths, and flag violations as `standards`. A pattern that matches established local
convention is not a finding; when the convention itself is defective, report it once and name the
other instances in `defect`.
Obey an explicit Git range in Scope. Otherwise inspect unstaged, staged, and untracked
source/text files, excluding `.scratch/`, generated, vendored, and binary paths. When those are
empty, use only the caller-supplied merge-base-to-`HEAD` range. Never substitute `HEAD~1`.
Inspect changed hunks plus adjacent call sites, interfaces, and tests needed to verify a claim.
Skip issues that configured linters, formatters, or type checkers enforce. For each new exported or
shared symbol, search the repository by name and behaviour for an existing equivalent; report a
match as `reuse` anchored on the new symbol, and cite the existing `path:L<line>` in `defect`.
Read the full review history in the review log that each governing artifact's `## Review Findings & Resolutions` links. Consult raw provider output or journals
when missing evidence, disputed adjudication or recovery requires it; follow
`references/review-rules.md` for ownership and ruling semantics. History does not replace source inspection.
Findings apply to the captured revision and Scope. Preserve original provenance; the host selects applicability to later content under [review rules](../review-rules.md#review-provenance-and-applicability).
On re-review, verify prior resolutions in the review log that `## Review Findings & Resolutions` links, and treat
earlier settled findings as closed. Decisions recorded in the governing design or plan are settled:
contest one only by naming it and citing evidence its rationale did not weigh. When Scope names changed sections or paths, raise new in-scope
findings only there; `adjacent` findings may cite any locus. Stop at that blast radius.

### Tags
- intent: `intent`, `scope-creep` — misses, misreads, or exceeds the ask
- correctness: `correctness`, `domain-logic`, `invariant`, `runtime`, `type` — domain rules and invariants; domain-valid formulas and algorithms; type-valid, domain-invalid states; sign, unit, and scale (monthly/annual, fraction/percent); off-by-one
- robustness: `edge-case`, `partial-failure`, `race` — boundary inputs; unhandled branches; unguarded indexing; partial updates; floating promises; races
- security/resources: `security`, `auth`, `resource-leak`, `perf` — injection, traversal, escaping, secrets, auth bypass; unchecked object ownership (IDOR); sensitive data in logs or errors; unclosed handles; unbounded memory/concurrency; blocked event loops; hot-path quadratics; N+1 queries; unpaginated reads; new filter or sort columns without an index
- compatibility: `compatibility`, `breaking`, `migration` — callers and serialized formats; migrations
- simplicity: `shallow`, `seam`, `coupling`, `yagni`, `reuse`, `root-cause` — pass-through modules; speculative seams (one adapter is hypothetical); delete, reuse, stdlib, then new code; shared root-cause fixes
- tests/UX: `test-gap`, `test-leak`, `ui`, `a11y` — observable outcomes at seams; missing failure-mode tests; `test-leak`: retained tests coupled to internals or duplicating seam coverage (tests owned only by `Retain: transient` criteria are trimmed after review and are not `test-leak`); touched UI, a11y, CLI/API ergonomics
- standards: `standards` — violations of the host rule files above on changed lines; elsewhere, report as `adjacent`
- out of scope: `adjacent` — a concrete defect you meet outside Scope while inspecting; cite its real locus; spend no extra turns hunting

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
