# dispatch-code-review delegate prompt

Filled by `dispatch`'s `fill-template.mjs` (see `dispatch`'s `references/alignment.md` § Prompt Template Filling). The variable bullets below are the declared variables; `--list` reads them off this file.

## Prompt template

Populate the template variables:
- `<Task Summary>` — summary of the ask and the changes made.
- `<Walkthrough Path>` — path to the attached walkthrough.
- `<Plan Path>` — path to the attached plan, or `None`.
- `<User Focus Areas>` — trailing user arguments, or `General review`.
- `<Review Scope>` — `Full review` on a first review. On a re-review, `Re-review round <n> — verify the resolutions logged under ## Review Findings & Resolutions; raise new findings only on lines changed since round <n-1>: <changed paths>`.
- `<Tool Turn Budget>` — orchestrator-supplied advisory target, or `Unspecified`.

````markdown
Review the changes.

### Context
- Task: <Task Summary>
- Walkthrough: <Walkthrough Path>
- Plan: <Plan Path>
- Focus: <User Focus Areas>
- Scope: <Review Scope>
- Advisory Tool Turn Target: <Tool Turn Budget>

Inspect only the supplied scope and its direct contracts. Adhere to this project's conventions
(read `AGENTS.md` / `CLAUDE.md` from the workspace). Obey an explicit Git range in Scope.
Otherwise inspect unstaged, staged, and untracked source/text files, excluding `.scratch/`,
generated, vendored, and binary paths. When those are empty, use only the caller-supplied
merge-base-to-`HEAD` range. Never substitute `HEAD~1`.

Cross-check the diff against the walkthrough and plan. Read verification results from the
walkthrough; if absent or unfilled, spend one turn on the host verify command and report that fact.
Inspect changed hunks plus adjacent call sites, interfaces, and tests needed to verify a claim. On
re-review, verify logged resolutions and treat earlier settled lines as closed. Stop at that blast
radius.

Check these tags:
- correctness: `correctness`, `domain-logic`, `invariant`, `unit`, `math`, `runtime`, `type`
- security/resources: `security`, `vuln`, `auth`, `leak`, `perf`
- compatibility: `compatibility`, `breaking`, `compat`, `migration`, `scope-creep`
- simplicity: `shallow`, `seam`, `adapter`, `coupling`, `yagni`, `reuse`, `stdlib`, `root-cause`
- tests/UX: `tests`, `test-gap`, `test-leak`, `ui`, `a11y`

Treat the tool-turn value as one advisory target. Stop early when grounded. Exceed it only for a
named in-scope risk supported by evidence.
If unspecified, target `8 + 2 × changed files`; on re-review count files changed since the prior
round only.

Return only the schema-constrained JSON object. For a clean review use:
```json
{"status":"CLEAN","findings":[]}
```

Otherwise use status `FINDINGS` and one or more findings with every field:
```json
{"status":"FINDINGS","findings":[{"severity":"MUST|SHOULD|CONSIDER","locus":"<relative-file>:L<line>","tag":"<tag>","defect":"<defect>","requiredChange":"<required change>"}]}
```

Every finding needs a changed-line locus and a verifiable claim. Use only the tags above. Omit
praise, clean-axis summaries, verdicts, repeated next steps, and findings outside scope.
````
