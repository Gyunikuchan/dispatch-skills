# Review rebuttal prompt (shared frame)

Shared by every review kind; each `<<slot:NAME>>` line is filled from the `## NAME` section of the
kind block `rebuttal-<kind>.md`.

## Prompt template

Populate every variable (kind blocks declare the rest):
- `<Finding Packet Path>` — source-specific OS-temp packet.
- `<Tool Turn Budget>` — advisory target.

````markdown
<<slot:opener>>

<<slot:context>>
- Finding packet: <Finding Packet Path>
- Scope: <Review Scope>
- Advisory Tool Turn Target: <Tool Turn Budget>

<<slot:inspection>>
Return one response for every supplied key and no others. Use `CONFIRM` when the orchestrator's
counter-evidence settles the finding, `REBUT` when cited evidence refutes that counter-reading, or
`INTENT-DISPUTE` when evidence cannot settle intent or a deliberate trade-off.
<<slot:notes>>

End your reply with one JSON object holding every response:
```json
{"responses":[{"type":"rebuttal","key":"R1-F001","verdict":"CONFIRM|REBUT|INTENT-DISPUTE","evidence":"<cited explanation>"}]}
```
````
