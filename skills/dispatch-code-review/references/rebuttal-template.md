# dispatch-code-review rebuttal prompt

## Prompt template

Populate every variable:
- `<Walkthrough Path>` — bounded walkthrough review view path.
- `<Plan Path>` — bounded plan review view path, or `None`.
- `<Finding Packet Path>` — source-specific OS-temp packet.
- `<Review Scope>` — supplied finding keys only.
- `<Tool Turn Budget>` — advisory target.

````markdown
Review only the supplied unsettled code findings.

- Bounded walkthrough view: <Walkthrough Path>
- Plan: <Plan Path>
- Finding packet: <Finding Packet Path>
- Scope: <Review Scope>
- Advisory Tool Turn Target: <Tool Turn Budget>

Read the bounded view named in the packet context and inspect only cited changed code needed to
test each claim. Return one response for every supplied key and no others. Use `CONFIRM` when the
orchestrator's counter-evidence settles the finding, `REBUT` when cited evidence refutes that
counter-reading, or `INTENT-DISPUTE` when evidence cannot settle intent or a deliberate trade-off.

Return only one schema-constrained JSON object:
```json
{"responses":[{"type":"rebuttal","key":"R1-F001","verdict":"CONFIRM|REBUT|INTENT-DISPUTE","evidence":"<cited explanation>"}]}
```
````
