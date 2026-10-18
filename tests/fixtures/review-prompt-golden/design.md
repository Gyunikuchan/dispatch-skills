Review the technical design adversarially: challenge the requirement, its premise, and the design.
A technical design is the higher-level architectural plan that breaks a large problem into smaller
increments, each later delivered through its own implementation plan. Review at that altitude:
raise architectural issues, and leave file-by-file and symbol-level detail to the plan reviews. No
code has been written yet.

### Context
- Design: .scratch/example/example.design.md
- Spec Path: .scratch/example/example.spec.md
- Spec Hash: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
- Focus: General review
- Scope: Full review
- Advisory Tool Turn Target: Unspecified

### Review against
- Governing targets: every spec REQ and DEC, the design, and its per-increment acceptance criteria.
- Use the selected sections of the [quality bar](quality-bar.md) to judge those targets. Report unmet intent, spec ambiguity, contradiction, or a missing constraint as `intent-gap` before other tags.

### Inspection
Inspect by reading and searching files, running read-only commands in the foreground.
Verification evidence comes from the orchestrator; run no test or build commands.
Adhere to this project's conventions: read `AGENTS.md`, including nested ones on
reviewed paths, and flag violations as `standards`. A pattern that matches established local convention is not a finding;
when the convention itself is defective, report it once and name the other instances in `defect`.
Read the whole spec at Spec Path before inspection; use Spec Hash as its governing identity.
For a spec finding, use § Spec: <heading>.
Read the design and the direct repository contracts needed to verify a claim; verify feasibility
without demanding implementation detail.
Read the full review history in the review log that each governing artifact's `## Review Findings & Resolutions` links. Consult raw provider output or journals
when missing evidence, disputed adjudication or recovery requires it; follow
`references/review-rules.md` for ownership and ruling semantics. History does not replace source inspection.
Findings apply to the captured revision and Scope. Report a concrete existing-code defect encountered while inspecting the selected target and interfaces or call sites needed to verify it; those interfaces or call sites may be outside Scope only as needed to substantiate the defect. Spend no extra turns hunting for adjacent findings. Apply this discovery rule to every review kind. Preserve original provenance; the host selects applicability to later content under [review rules](../review-rules.md#review-provenance-and-applicability).
On re-review, verify prior resolutions in the review log that `## Review Findings & Resolutions` links, and treat
earlier settled findings as closed. Decisions recorded in the governing design or plan are settled:
contest one only by naming it and citing evidence its rationale did not weigh. When Scope names changed sections or paths, raise new in-scope
findings only there; `adjacent` findings may cite any locus. Stop at that blast radius.
- Precedence: Applicable host rule files govern first. For nested `AGENTS.md` files, the nearest file wins over its parent. This bar supplements host rules where they are silent and yields where they conflict. Preference applies only where both are silent.
- Host rules override only this bar. Plan scope, write boundaries, the outcome envelope and verification protocol, and safety rules stay fixed. Writers report a conflict between host rules and the brief under concerns; reviewers do not report such a conflict as a finding.
- Simplicity: prefer, in order, delete, reuse, stdlib, then new code.
- Reuse: for each new exported or shared symbol, helper, module, or type, search the repository by name and behaviour for an existing equivalent; reuse a match instead of adding it.
- Spec alignment: meet every applicable requirement in the governing spec, preserve its decisions and constraints, and identify flawed premises or gaps.

- Traceability: trace every goal to a requirement, and state non-goals explicitly.
- Acceptance and verification: make every criterion observable and together sufficient for the goals, including each increment's acceptance criteria.
- Architecture: define component ownership, contracts between components, and data crossing boundaries.
- Decisions: weigh real alternatives; apply the shared simplicity order when choosing.
- Invariants: state system-wide rules that hold within and across increments.
- Risk and operations: check trust boundaries, deployment and runtime operation, risk concentrated in one increment, and a reversal path per change.
- Decomposition: choose independently deliverable, correctly ordered increments with collision-free parallel increments and covered final integration.

### Tags
- intent gap: `intent-gap`
- intent: `intent`, `scope`
- architecture: `architecture`, `boundaries`, `interfaces`, `data-flow`
- decisions: `alternatives`, `simplicity`
- invariants: `correctness`, `invariant`
- risk and operations: `security`, `operations`, `risk`, `migration`, `rollback`
- decomposition: `dependency-graph`, `parallel-safety`, `integration`
- verification: `testability`
- standards: `standards`
- out of scope: `adjacent`

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
For an adjacent finding, use the nearest design heading as locus.
