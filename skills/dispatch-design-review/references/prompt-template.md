# dispatch-design-review delegate prompt

Filled by preparation via `fill-template.mjs`; `--list` reads the variable bullets below.

## Prompt template

Populate the template variables:
- `<Design Path>` — path to the attached technical design.
- `<Requirement>` — original user ask.
- `<User Focus Areas>` — requested focus, or `General review`.
- `<Review Scope>` — full review or changed design sections.
- `<Tool Turn Budget>` — advisory target.

````markdown
Review the technical design adversarially at high level.

### Context
- Design: <Design Path>
- Requirement: <Requirement>
- Focus: <User Focus Areas>
- Scope: <Review Scope>
- Advisory Tool Turn Target: <Tool Turn Budget>

Inspect architecture, boundaries, interfaces, data flow, alternatives, security and operations,
migration and rollback, risk concentration, increment dependency-graph correctness, parallel
safety, and final integration. Verify repository feasibility without demanding file-by-file or
symbol-level implementation detail. Read project conventions and direct contracts needed to
verify each claim. On re-review, inspect changed sections and logged resolutions only. Stop at
that blast radius.

Use these tags: `intent`, `scope`, `correctness`, `invariant`, `architecture`, `boundaries`,
`alternatives`, `interfaces`, `data-flow`, `security`, `operations`, `migration`, `rollback`,
`risk`, `dependency-graph`, `parallel-safety`, `integration`, `testability`, `simplicity`,
`standards`, or `adjacent`.

Treat the tool-turn value as advisory. Run commands in the foreground and reply once complete.
End with exactly one JSON object. Clean:
```json
{"status":"CLEAN","findings":[]}
```
Findings:
```json
{"status":"FINDINGS","findings":[{"severity":"MUST|SHOULD|CONSIDER","locus":"§ <Design heading>","tag":"<tag>","defect":"<defect>","requiredChange":"<required change>"}]}
```
Every finding needs a verifiable claim and exact `§ <Design heading>` locus. Cite repository code
inside `defect` when used. Omit praise and summaries.
````
