# dispatch-code-review delegate prompt

Filled by preparation via `fill-template.mjs`; `--list` reads the variable bullets below.

## Prompt template

Populate the template variables:
- `<Task Summary>` — summary of the ask and the changes made.
- `<Walkthrough Path>` — path to the attached walkthrough.
- `<Plan Path>` — path to the attached plan, or `None`.
- `<User Focus Areas>` — trailing user arguments, or `General review`.
- `<Review Scope>` — preparation-supplied scope string: `Full review` on a first review. On a re-review, `Re-review round <n> — changed paths: <changed paths>; <range>`, or `Re-review round <n> — walkthrough body changed; review full selected range (<range>)`.
- `<Tool Turn Budget>` — orchestrator-supplied advisory target, or `Unspecified`.

````markdown
Review the changes adversarially: challenge the requirement, the author's mental model, and the
diff.

### Context
- Task: <Task Summary>
- Walkthrough: <Walkthrough Path>
- Plan: <Plan Path>
- Focus: <User Focus Areas>
- Scope: <Review Scope>
- Advisory Tool Turn Target: <Tool Turn Budget>

Inspect the supplied scope and its direct contracts. Adhere to this project's conventions: read
`AGENTS.md` / `CLAUDE.md`, including nested ones on reviewed paths, and flag violations as
`standards`. Obey an explicit Git range in Scope. Otherwise inspect unstaged, staged, and untracked
source/text files, excluding `.scratch/`, generated, vendored, and binary paths. When those are
empty, use only the caller-supplied merge-base-to-`HEAD` range. Never substitute `HEAD~1`.

Cross-check the diff against the walkthrough and plan. Read verification results from the
walkthrough; if absent or unfilled, spend one turn on the host verify command and report that fact.
Inspect changed hunks plus adjacent call sites, interfaces, and tests needed to verify a claim. On
re-review, verify the resolutions logged under `## Review Findings & Resolutions` and treat earlier
settled lines as closed. When Scope names changed paths, raise new in-scope findings only there;
`adjacent` findings may cite any locus. Stop at that blast radius.

Check these tags:
- intent: `intent`, `scope-creep` — misses, misreads, or exceeds the ask
- correctness: `correctness`, `domain-logic`, `invariant`, `runtime`, `type` — domain rules and invariants; domain-valid formulas and algorithms; type-valid, domain-invalid states; sign, unit, and scale (monthly/annual, fraction/percent); off-by-one
- robustness: `edge-case`, `partial-failure`, `race` — boundary inputs; unhandled branches; unguarded indexing; partial updates; floating promises; races
- security/resources: `security`, `auth`, `resource-leak`, `perf` — injection, traversal, escaping, secrets, auth bypass; unclosed handles; unbounded memory/concurrency; blocked event loops; hot-path quadratics
- compatibility: `compatibility`, `breaking`, `migration` — callers and serialized formats; migrations
- simplicity: `shallow`, `seam`, `coupling`, `yagni`, `reuse`, `root-cause` — pass-through modules; speculative seams (one adapter is hypothetical); delete, reuse, stdlib, then new code; shared root-cause fixes
- tests/UX: `test-gap`, `test-leak`, `ui`, `a11y` — observable outcomes at seams; missing failure-mode tests; tests coupled to internals; touched UI, a11y, CLI/API ergonomics
- standards: `standards` — violations of the host rule files above on changed lines; elsewhere, report as `adjacent`
- out of scope: `adjacent` — a concrete defect you meet outside Scope while inspecting; cite its real locus; spend no extra turns hunting

Treat the tool-turn value as one advisory target. Stop early when grounded. Exceed it only for a
named in-scope risk supported by evidence.
If unspecified, target `8 + 2 × changed files`; on re-review count files changed since the prior
round only.

Run commands in the foreground; reply once the review is complete.
End your reply with one JSON object holding every finding. For a clean review use:
```json
{"status":"CLEAN","findings":[]}
```

Otherwise use status `FINDINGS` and one or more findings with every field:
```json
{"status":"FINDINGS","findings":[{"severity":"MUST|SHOULD|CONSIDER","locus":"<relative-file>:L<line>","tag":"<tag>","defect":"<defect>","requiredChange":"<required change>"}]}
```

Every finding needs a verifiable claim: in scope, a changed-line locus; `adjacent`, its real locus.
Use only the tags above. Omit praise, summaries, and next steps.
````
