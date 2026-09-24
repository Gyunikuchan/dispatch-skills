# Review delegate prompt (shared frame)

Shared by every review kind; each `<<slot:NAME>>` line is filled from the `## NAME` section of the
kind block `review-prompt-<kind>.md`. Preparation assembles and fills it via `review/fill-template.mjs`
(`--skill <frame> --kind-block <block>`); `--list` reads the variable bullets of both files.

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
reviewed paths, and flag violations as `standards`.
<<slot:inspection>>
On re-review, verify the resolutions logged under `## Review Findings & Resolutions` and treat
earlier settled findings as closed. When Scope names changed sections or paths, raise new in-scope
findings only there; `adjacent` findings may cite any locus. Stop at that blast radius.

### Tags
<<slot:tags>>

### Budget
Treat the tool-turn value as one advisory target. Stop early when grounded. Exceed it only for a
named in-scope risk supported by evidence.
<<slot:budget>>

### Reply
Your whole reply is one JSON object holding every finding; the JSON is the report. If JSON cannot
carry a finding, write that finding as plain text instead. For a clean review use:
```json
{"status":"CLEAN","findings":[]}
```

Otherwise use status `FINDINGS` and one or more findings with every field:
```json
{"status":"FINDINGS","findings":[{"severity":"MUST|SHOULD|CONSIDER","locus":"<<slot:locus>>","tag":"<tag>","defect":"<defect>","requiredChange":"<required change>"}]}
```

Every finding needs a verifiable claim at its locus. Use only the tags above.
<<slot:closing>>
````
