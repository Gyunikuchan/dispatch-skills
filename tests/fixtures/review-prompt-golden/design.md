Review the technical design adversarially: challenge the requirement, its premise, and the design.
A technical design is the higher-level architectural plan that breaks a large problem into smaller
increments, each later delivered through its own implementation plan. Review at that altitude:
raise architectural issues, and leave file-by-file and symbol-level detail to the plan reviews. No
code has been written yet.

### Context
- Design: .scratch/example/example.design.md
- Requirement: Split the importer into staged increments
- Focus: General review
- Scope: Full review
- Advisory Tool Turn Target: Unspecified

### Review against
- The requirement: every goal traced to it, and non-goals explicit.
- The design's goals, requirements, and per-increment acceptance criteria: each criterion
  observable, and together sufficient for the goals.

### Inspection
Inspect by reading and searching files, running read-only commands in the foreground.
Verification evidence comes from the orchestrator; run no test or build commands.
Adhere to this project's conventions: read `AGENTS.md` / `CLAUDE.md`, including nested ones on
reviewed paths, and flag violations as `standards`. A pattern that matches established local convention is not a finding;
when the convention itself is defective, report it once and name the other instances in `defect`.
Read the design and the direct repository contracts needed to verify a claim; verify feasibility
without demanding implementation detail.
Read the full review history in the review log that each governing artifact's `## Review Findings & Resolutions` links. Consult raw provider output or journals
when missing evidence, disputed adjudication or recovery requires it; follow
`references/review-rules.md` for ownership and ruling semantics. History does not replace source inspection.
Findings apply to the captured revision and Scope. Preserve original provenance; the host selects applicability to later content under [review rules](../review-rules.md#review-provenance-and-applicability).
On re-review, verify prior resolutions in the review log that `## Review Findings & Resolutions` links, and treat
earlier settled findings as closed. Decisions recorded in the governing design or plan are settled:
contest one only by naming it and citing evidence its rationale did not weigh. When Scope names changed sections or paths, raise new in-scope
findings only there; `adjacent` findings may cite any locus. Stop at that blast radius.
Host rule files take precedence over dispatch defaults: content that follows a host rule is not a finding, even when it contradicts a dispatch default. Where host rules are silent, dispatch defaults apply.

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
The tool-turn target is advisory: stop early when grounded; exceed it only for an evidenced
in-scope risk.

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
{"status":"FINDINGS","findings":[{"severity":"MUST|SHOULD|CONSIDER","locus":"§ <Design heading>","tag":"<tag>","defect":"<defect>","requiredChange":"<required change>"}]}
```

Use only the tags above.
Cite existing code as `path/to/file:L<line>` inside `defect`.
