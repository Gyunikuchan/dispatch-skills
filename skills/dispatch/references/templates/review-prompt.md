# Review delegate prompt (shared frame)

Shared by every review kind; `domain/prompt.ts` `assembleTemplate` fills each `<<slot:NAME>>`
from its kind block. `qualityBar(consumer)` fills the quality slot for code, plan and design
reviews; variables are all inputs' declarations.

## Prompt template

Populate the template variables (kind blocks declare the rest):
- `<User Focus Areas>` — structural `governing.finalFocusPaths`, or `General review` when absent or empty.
- `<Tool Turn Budget>` — toolkit-computed advisory turn target.

````markdown
<<slot:opener>>

### Context
<<slot:context>>
The Spec Hash is the canonical identity reported by lint; it is not a hash of the raw file bytes.
- Focus: <User Focus Areas>
- Scope: <Review Scope>
- Advisory Tool Turn Target: <Tool Turn Budget>

### Review against
<<slot:against>>

### Inspection
Inspect by reading and searching files, running read-only commands in the foreground. A reviewer may run a host read tool that creates or updates only its own cache or index, unless a stricter host rule forbids it.
For any delegation already permitted by the assignment, use available host controls to request fresh context without parent conversation history. If unsupported or unverifiable, continue and report the limitation through existing reporting channels. Give each new child a self-contained brief with this launch instruction; preserve required reply schemas.
Verification evidence comes from the orchestrator; run no test or build commands.
Adhere to the host rule files that the quality section's discovery rule finds.
Report host-rule violations on changed lines or sections as `standards`; elsewhere, report them as `adjacent`.
A pattern that matches established local convention is not a finding;
when the convention itself is defective, report it once and name the other instances in `defect`.
<<slot:inspection>>
For every review kind, findings apply to the captured revision and Scope. Inspect required callers, interfaces, host rules and governing material even outside Scope. Report concrete existing-code defects encountered in the selected target or during that required inspection; inspect other adjacent material only to substantiate a defect. Spend no extra turns hunting for adjacent findings. Preserve original provenance; the host selects applicability to later content under [review rules](../review-rules.md#review-provenance-and-applicability).
Read the full review history in the review log that each governing artifact's `## Review Findings & Resolutions` links. Consult raw provider output or ledger records when missing evidence, disputed adjudication or recovery requires it; follow [review rules](../review-rules.md) for ownership and ruling semantics. History does not replace source inspection.
On re-review, verify prior resolutions in that review log, and treat
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
<<slot:rubric>>
<<slot:severity>>
In `defect`, state the concrete consequence at the locus; in `requiredChange`, the remedy.
Ground each finding in a concrete failure scenario, a host rule, a measurable cost, or a known
vulnerability class. Preference is not a finding; between technically equivalent approaches, the
author's choice stands. Simplicity findings name the cost removed: concepts, files, or code paths.
Report one finding per defective predicate; list every failing state of it in `defect`.

### Reply
Reply with one JSON object of all findings as the last thing in the reply, on its own line or in a final fenced block. If JSON cannot carry a finding, write it as plain
text. For a clean review use:
```json
{"status":"CLEAN","findings":[]}
```

Otherwise use status `FINDINGS` and one or more findings with every field:
```json
{"status":"FINDINGS","findings":[{"impact":"critical|blocks|degrades|minor","trigger":"realistic|contrived","locus":"<<slot:locus>>","tag":"<tag>","defect":"<defect>","requiredChange":"<required change>"}]}
```

Use only the tags above.
<<slot:closing>>
````
