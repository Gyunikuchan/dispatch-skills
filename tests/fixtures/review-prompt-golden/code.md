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
reviewed paths, and flag violations as `standards`.
Obey an explicit Git range in Scope. Otherwise inspect unstaged, staged, and untracked
source/text files, excluding `.scratch/`, generated, vendored, and binary paths. When those are
empty, use only the caller-supplied merge-base-to-`HEAD` range. Never substitute `HEAD~1`.
Inspect changed hunks plus adjacent call sites, interfaces, and tests needed to verify a claim.
Read complete inline history in the governing artifacts. Consult raw provider output or journals
when missing evidence, disputed adjudication or recovery requires it; follow
`references/review-rules.md` for ownership and ruling semantics. History does not replace source inspection.
On re-review, verify the resolutions logged under `## Review Findings & Resolutions` and treat
earlier settled findings as closed. Decisions recorded in the governing design or plan are settled:
contest one only by naming it and citing evidence its rationale did not weigh. When Scope names changed sections or paths, raise new in-scope
findings only there; `adjacent` findings may cite any locus. Stop at that blast radius.

### Tags
- intent: `intent`, `scope-creep` — misses, misreads, or exceeds the ask
- correctness: `correctness`, `domain-logic`, `invariant`, `runtime`, `type` — domain rules and invariants; domain-valid formulas and algorithms; type-valid, domain-invalid states; sign, unit, and scale (monthly/annual, fraction/percent); off-by-one
- robustness: `edge-case`, `partial-failure`, `race` — boundary inputs; unhandled branches; unguarded indexing; partial updates; floating promises; races
- security/resources: `security`, `auth`, `resource-leak`, `perf` — injection, traversal, escaping, secrets, auth bypass; unclosed handles; unbounded memory/concurrency; blocked event loops; hot-path quadratics
- compatibility: `compatibility`, `breaking`, `migration` — callers and serialized formats; migrations
- simplicity: `shallow`, `seam`, `coupling`, `yagni`, `reuse`, `root-cause` — pass-through modules; speculative seams (one adapter is hypothetical); delete, reuse, stdlib, then new code; shared root-cause fixes
- tests/UX: `test-gap`, `test-leak`, `ui`, `a11y` — observable outcomes at seams; missing failure-mode tests; tests coupled to internals; touched UI, a11y, CLI/API ergonomics
- standards: `standards` — violations of the host rule files above on changed lines; elsewhere, report as `adjacent`
- out of scope: `adjacent` — a concrete defect you meet outside Scope while inspecting; cite its real locus; spend no extra turns hunting

### Budget
The tool-turn target is advisory: stop early when grounded; exceed it only for an evidenced
in-scope risk.
If unspecified, target `8 + 2 × changed files`; on re-review count files changed since the prior
round only.

### Severity
Severity is resolution priority. `MUST`: blocks the promised outcome or breaks a binding
constraint. `SHOULD`: real defect that degrades the outcome without blocking it. `CONSIDER`: optional
improvement; no defect.
In `defect`, state the concrete consequence at the locus; in `requiredChange`, the remedy.

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
