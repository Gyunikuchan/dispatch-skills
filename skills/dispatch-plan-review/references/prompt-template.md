# dispatch-plan-review delegate prompt

Filled by `dispatch`'s `fill-template.mjs` (see `dispatch`'s `references/alignment.md` § Prompt Template Filling). The variable bullets below are the declared variables; `--list` reads them off this file.

## Prompt template

Populate the template variables:
- `<Plan Path>` — path to the attached plan.
- `<Requirement>` — original user ask, verbatim.
- `<User Focus Areas>` — trailing user arguments, or `General review`.
- `<Review Scope>` — `Full review` on a first review. On a re-review, `Re-review round <n> — verify the resolutions logged under ## Review Findings & Resolutions; raise new findings only in sections changed since round <n-1>: <changed sections>`.
- `<Tool Turn Budget>` — orchestrator-supplied advisory target, or `Unspecified`.

````markdown
Review the plan. No code has been written yet.

### Context
- Plan: <Plan Path>
- Requirement: <Requirement>
- Focus: <User Focus Areas>
- Scope: <Review Scope>
- Advisory Tool Turn Target: <Tool Turn Budget>

Inspect only the supplied scope and its direct contracts. Adhere to this project's conventions
(read `AGENTS.md` / `CLAUDE.md` from the workspace). Read the plan, named files, and adjacent
interfaces or tests needed to verify a claim. On re-review, verify logged resolutions and treat
earlier settled sections as closed. Stop at that blast radius.

Check these tags:
- intent: `intent`, `traceability`, `user-gap`, `scope`, `scope-creep`
- domain invariants: `correctness`, `domain-logic`, `invariant`, `state-machine`
- architecture: `architecture`, `coherence`, `approach`, `standards`
- trust boundaries: `security`, `auth`, `validation`
- compatibility: `compatibility`, `blast-radius`, `migration`, `compat`, `rollback`
- verification: `verification`, `testability`, `spec-gap`
- simpler path: `simplicity`, `yagni`, `edge-case`

Treat the tool-turn value as one advisory target. Stop early when grounded. Exceed it only for a
named in-scope risk supported by evidence.
If unspecified, target `8 + 2 × proposed-change entries`; on re-review count changed entries only.

Return only the schema-constrained JSON object. For a clean review use:
```json
{"status":"CLEAN","findings":[]}
```

Otherwise use status `FINDINGS` and one or more findings with every field:
```json
{"status":"FINDINGS","findings":[{"severity":"MUST|SHOULD|CONSIDER","locus":"§ <Plan heading>","tag":"<tag>","defect":"<defect>","requiredChange":"<required change>"}]}
```

Every finding needs a verifiable `§ <Plan heading>` locus. Cite existing code as
`path/to/file:L<line>` inside `defect`. Use only the tags above. Omit praise, clean-axis summaries,
verdicts, repeated next steps, and findings outside scope.
````
