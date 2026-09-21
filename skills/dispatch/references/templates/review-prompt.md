# Review delegate prompt (shared frame)

Shared by every review kind; each `<<slot:NAME>>` line is filled from the `## NAME` section of the
kind block `review-prompt-<kind>.md`. Preparation assembles and fills it via `fill-template.mjs`
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

Inspect the supplied scope and its direct contracts. Adhere to this project's conventions: read
`AGENTS.md` / `CLAUDE.md`, including nested ones on reviewed paths, and flag violations as
`standards`.
<<slot:inspection>>

<<slot:tags>>

Treat the tool-turn value as one advisory target. Stop early when grounded. Exceed it only for a
named in-scope risk supported by evidence.
<<slot:budget>>

Run commands in the foreground; reply once the review is complete.
End your reply with one JSON object holding every finding. For a clean review use:
```json
{"status":"CLEAN","findings":[]}
```

Otherwise use status `FINDINGS` and one or more findings with every field:
```json
{"status":"FINDINGS","findings":[{"severity":"MUST|SHOULD|CONSIDER","locus":"<<slot:locus>>","tag":"<tag>","defect":"<defect>","requiredChange":"<required change>"}]}
```

<<slot:closing>>
````
