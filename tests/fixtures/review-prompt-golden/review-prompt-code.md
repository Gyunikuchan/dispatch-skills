# dispatch-code-review delegate prompt

Assembled golden of `review-prompt.md` + `review-prompt-code.md`.

## Prompt template

Populate the template variables:
- `<Task Summary>` — summary of the ask and the changes made.
- `<Walkthrough Path>` — path to the attached walkthrough.
- `<Plan Path>` — path to the attached plan, or `None`.
- `<Review Scope>` — preparation-supplied scope string: `Full review` on a first review. On a re-review, `Re-review round <n> — changed paths: <changed paths>; <range>`, or `Re-review round <n> — walkthrough body changed; review full selected range (<range>)`.
- `<User Focus Areas>` — trailing user arguments, or `General review`.
- `<Tool Turn Budget>` — orchestrator-supplied advisory target, or `Unspecified`.

````markdown
Review the implementation adversarially: challenge the requirement, the author's mental model, and
the diff. The implementation is complete: judge whether it delivers the original ask and meets its
success criteria well, not merely whether it matches the plan.

### Context
- Task: <Task Summary>
- Walkthrough: <Walkthrough Path>
- Plan: <Plan Path>
- Focus: <User Focus Areas>
- Scope: <Review Scope>
- Advisory Tool Turn Target: <Tool Turn Budget>

### Review against
- The task, the plan's `## Success Criteria` (with no plan, the task alone), and the walkthrough's
  `## Outcome Traceability`: every criterion demonstrably met by the diff and its tests. A goal
  missed or met only on paper, such as a test passing without exercising it, is `intent`.
- The walkthrough's verification results; when absent or unfilled, report a `test-gap` finding.
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
On re-review, verify the resolutions logged under `## Review Findings & Resolutions` and treat
earlier settled findings as closed. When Scope names changed sections or paths, raise new in-scope
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
Treat the tool-turn value as one advisory target. Stop early when grounded. Exceed it only for a
named in-scope risk supported by evidence.
If unspecified, target `8 + 2 × changed files`; on re-review count files changed since the prior
round only.

### Reply
Your whole reply is one JSON object holding every finding; the JSON is the report. If JSON cannot
carry a finding, write that finding as plain text instead. For a clean review use:
```json
{"status":"CLEAN","findings":[]}
```

Otherwise use status `FINDINGS` and one or more findings with every field:
```json
{"status":"FINDINGS","findings":[{"severity":"MUST|SHOULD|CONSIDER","locus":"<relative-file>:L<line>","tag":"<tag>","defect":"<defect>","requiredChange":"<required change>"}]}
```

Every finding needs a verifiable claim at its locus. Use only the tags above.
Anchor every in-scope finding on a line the diff adds or changes; a finding anchored anywhere else
is `adjacent`.
````
