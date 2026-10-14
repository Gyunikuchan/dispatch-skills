# Review delegate prompt (shared frame)

Shared by every review kind; `domain/prompt.ts` `assembleTemplate(frame, kindBlock)` fills each
`<<slot:NAME>>` from `## NAME` section of `review-prompt-<kind>.md`, and its variables are both files' declarations.

## Prompt template

Populate the template variables (kind blocks declare the rest):
- `<User Focus Areas>` — trailing user arguments, or `General review`.
- `<Tool Turn Budget>` — orchestrator-supplied advisory target, or `Unspecified`.

````markdown
<<slot:opener>>

### Context
<<slot:context>>
- Focus: <User Focus Areas>
- Scope: <Review Scope>
- Advisory Tool Turn Target: <Tool Turn Budget>

### Review against
<<slot:against>>

### Inspection
Inspect by reading and searching files, running read-only commands in the foreground.
Verification evidence comes from the orchestrator; run no test or build commands.
Adhere to this project's conventions: read `AGENTS.md` / `CLAUDE.md`, including nested ones on
reviewed paths, and flag violations as `standards`. A pattern that matches established local
convention is not a finding; when the convention itself is defective, report it once and name the
other instances in `defect`.
<<slot:inspection>>
Findings apply to the captured revision and Scope. Preserve original provenance; the host selects applicability to later content under [review rules](../review-rules.md#review-provenance-and-applicability).
On re-review, verify prior resolutions in the review log that `## Review Findings & Resolutions` links, and treat
earlier settled findings as closed. Decisions recorded in the governing design or plan are settled:
contest one only by naming it and citing evidence its rationale did not weigh. When Scope names changed sections or paths, raise new in-scope
findings only there; `adjacent` findings may cite any locus. Stop at that blast radius.

### Tags
<<slot:tags>>

### Budget
The tool-turn target is advisory: stop early when grounded; exceed it only for an evidenced
in-scope risk.
<<slot:budget>>

### Severity
Severity is resolution priority. `MUST`: blocks the promised outcome or breaks a binding
constraint. `SHOULD`: real defect that degrades the outcome without blocking it. `CONSIDER`: optional
improvement; no defect.
<<slot:severity>>
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
{"status":"FINDINGS","findings":[{"severity":"MUST|SHOULD|CONSIDER","locus":"<<slot:locus>>","tag":"<tag>","defect":"<defect>","requiredChange":"<required change>"}]}
```

Use only the tags above.
<<slot:closing>>
````
