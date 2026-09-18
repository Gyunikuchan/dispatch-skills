# dispatch-code-review delegate prompt

Filled by the owner preparation script through `dispatch`'s `fill-template.mjs`. The variable
bullets below are the declared variables; `--list` reads them off this file.

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
- correctness: `correctness`, `domain-logic`, `invariant`, `unit`, `math`, `runtime`, `type` — domain rules and invariants across mutations; type-valid but domain-invalid states; partial updates; sign and unit alignment (inflow/outflow, monthly/annual, fraction/percent); off-by-one; unhandled branches; unguarded indexing; floating promises
- security/resources: `security`, `vuln`, `auth`, `leak`, `perf` — injection, traversal, escaping, secrets, auth bypass; unclosed handles; unbounded memory or concurrency; blocked event loops; hot-path quadratics
- compatibility: `compatibility`, `breaking`, `compat`, `migration`, `scope-creep` — callers and serialized formats; migration safety; unrequested changes
- simplicity: `shallow`, `seam`, `adapter`, `coupling`, `yagni`, `reuse`, `stdlib`, `root-cause` — pass-through modules; speculative seams (one adapter is hypothetical); delete, reuse, stdlib, then new code; fix at the shared root cause
- tests/UX: `tests`, `test-gap`, `test-leak`, `ui`, `a11y` — observable outcomes at seams; missing failure-mode tests; tests coupled to internals; UI, a11y, and CLI/API ergonomics when touched
- standards: `standards` — violations of the host rule files above on changed lines; elsewhere, report as `adjacent`
- out of scope: `adjacent` — a concrete defect you meet outside Scope while inspecting; cite its real locus; spend no extra turns hunting

Treat the tool-turn value as one advisory target. Stop early when grounded. Exceed it only for a
named in-scope risk supported by evidence.
If unspecified, target `8 + 2 × changed files`; on re-review count files changed since the prior
round only.

Run commands in the foreground; reply only once the review is complete.
Return only the schema-constrained JSON object. For a clean review use:
```json
{"status":"CLEAN","findings":[]}
```

Otherwise use status `FINDINGS` and one or more findings with every field:
```json
{"status":"FINDINGS","findings":[{"severity":"MUST|SHOULD|CONSIDER","locus":"<relative-file>:L<line>","tag":"<tag>","defect":"<defect>","requiredChange":"<required change>"}]}
```

Every finding needs a verifiable claim: in scope, a changed-line locus; `adjacent`, its real locus.
Use only the tags above. Omit praise, clean-axis summaries, verdicts, and repeated next steps.
````
