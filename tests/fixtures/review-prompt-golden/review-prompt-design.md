# dispatch-design-review delegate prompt

Assembled golden of `review-prompt.md` + `review-prompt-design.md`.

## Prompt template

Populate the template variables:
- `<Design Path>` — path to the attached technical design.
- `<Requirement>` — original user ask, verbatim.
- `<Review Scope>` — full review or changed design sections, optionally followed by `Design lint warnings:` context.
- `<User Focus Areas>` — trailing user arguments, or `General review`.
- `<Tool Turn Budget>` — orchestrator-supplied advisory target, or `Unspecified`.

````markdown
Review the technical design adversarially: challenge the requirement, its premise, and the design.
A technical design is the higher-level architectural plan that breaks a large problem into smaller
increments, each later delivered through its own implementation plan. Review at that altitude:
raise architectural issues, and leave file-by-file and symbol-level detail to the plan reviews. No
code has been written yet.

### Context
- Design: <Design Path>
- Requirement: <Requirement>
- Focus: <User Focus Areas>
- Scope: <Review Scope>
- Advisory Tool Turn Target: <Tool Turn Budget>

### Review against
- The requirement: every goal traced to it, and non-goals explicit.
- The design's goals, requirements, and per-increment acceptance criteria: each criterion
  observable, and together sufficient for the goals.

### Inspection
Inspect by reading and searching files, running read-only commands in the foreground.
Verification evidence comes from the orchestrator; run no test or build commands.
Adhere to this project's conventions: read `AGENTS.md` / `CLAUDE.md`, including nested ones on
reviewed paths, and flag violations as `standards`.
Read the design and the direct repository contracts needed to verify a claim; verify feasibility
without demanding implementation detail.
On re-review, verify the resolutions logged under `## Review Findings & Resolutions` and treat
earlier settled findings as closed. When Scope names changed sections or paths, raise new in-scope
findings only there; `adjacent` findings may cite any locus. Stop at that blast radius.

### Tags
- intent: `intent`, `scope` — goals traced to the ask; explicit non-goals; flawed premises
- architecture: `architecture`, `boundaries`, `interfaces`, `data-flow` — component ownership; contracts between components; data crossing boundaries
- decisions: `alternatives`, `simplicity` — real alternatives weighed; simplest viable shape
- invariants: `correctness`, `invariant` — system-wide rules that hold within and across increments
- risk and operations: `security`, `operations`, `risk`, `migration`, `rollback` — trust boundaries; deployment and runtime operation; risk concentrated in one increment; a reversal path per change
- decomposition: `dependency-graph`, `parallel-safety`, `integration` — independently deliverable, correctly ordered increments; collision-free parallel increments; covered final integration
- verification: `testability` — every increment acceptance criterion observable
- standards: `standards` — violations of the host rule files above
- out of scope: `adjacent` — a concrete existing-code defect you meet outside Scope while inspecting; nearest design heading as locus, code cited in the defect; spend no extra turns hunting

### Budget
Treat the tool-turn value as one advisory target. Stop early when grounded. Exceed it only for a
named in-scope risk supported by evidence.

### Reply
Reply once the review is complete.
End your reply with one JSON object holding every finding. For a clean review use:
```json
{"status":"CLEAN","findings":[]}
```

Otherwise use status `FINDINGS` and one or more findings with every field:
```json
{"status":"FINDINGS","findings":[{"severity":"MUST|SHOULD|CONSIDER","locus":"§ <Design heading>","tag":"<tag>","defect":"<defect>","requiredChange":"<required change>"}]}
```

Every finding needs a verifiable claim and a `§ <Design heading>` locus. Cite existing code as
`path/to/file:L<line>` inside `defect`. Use only the tags above. Omit praise, summaries, and next
steps.
````
