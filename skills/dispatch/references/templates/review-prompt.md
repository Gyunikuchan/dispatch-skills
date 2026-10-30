# Review delegate prompt (shared frame)

Shared by every review kind; `domain/prompt.ts` `assembleTemplate` fills each `<<slot:NAME>>`
from its kind block. `qualityBar(consumer)` fills the quality slot for code, plan and design
reviews; variables are all inputs' declarations.

## Prompt template

Populate the template variables (kind blocks declare the rest):
- `<User Focus Areas>` — structural `governing.finalFocusPaths`, or `General review` when absent or empty.
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
Inspect by reading and searching files, running read-only commands in the foreground. A native reviewer may run a host read tool that creates or updates only its own cache or index, unless a stricter host rule forbids it.
Verification evidence comes from the orchestrator; run no test or build commands.
Adhere to the host rule files that the quality section's discovery rule finds.
Report host-rule violations on changed lines or sections as `standards`; elsewhere, report them as `adjacent`.
A pattern that matches established local convention is not a finding;
when the convention itself is defective, report it once and name the other instances in `defect`.
<<slot:inspection>>
Findings apply to the captured revision and Scope. Report a concrete existing-code defect encountered while inspecting the selected target and interfaces or call sites needed to verify it; those interfaces or call sites may be outside Scope only as needed to substantiate the defect. Spend no extra turns hunting for adjacent findings. Apply this discovery rule to every review kind. Preserve original provenance; the host selects applicability to later content under [review rules](../review-rules.md#review-provenance-and-applicability).
On re-review, verify prior resolutions in the review log that `## Review Findings & Resolutions` links, and treat
earlier settled findings as closed. The governing spec's Decisions and Non-goals, and decisions recorded in the governing design or plan, are settled:
contest one only by naming it and citing evidence it did not weigh. When Scope names changed sections or paths, raise new in-scope
findings only there; `adjacent` findings may cite any locus. Stop at that blast radius.
<<slot:quality>>

### Tags
Tag each finding with one family; the quality bar's bold family bullets define each family and its hints.
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
Report one finding per defective predicate; list every failing state of it in `defect`.

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

When Pending MUST rejection confirmation assigns requests, add `confirmations` to this object. Answer each assigned request exactly once with exactly `requestId`, `decision` (`agree` or `disagree`) and a nonblank evidence-backed `rationale`. Keep ordinary `status` and `findings`. A pending MUST rejection is open until explicit agreement; omission is not confirmation.

Use only the tags above.
<<slot:closing>>
````
