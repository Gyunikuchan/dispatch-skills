# Ask

`ask` is user-initiated: invoke `ask run` only for explicit user requests, never autonomous internal research. Route research, exploration and grounding under [routing](../../SKILL.md#routing); self-ground under [self-grounding](../grounding.md#publish) only when no entry resolves. An unlaunchable configured explorer is a blocker.

Use it for source cross-checks and differentiated model opinions or suggestions.

Write the question to a UTF-8 file and use `ask run`. The [toolkit contract](../toolkit.md#ask-run) owns arguments and outputs. Ask needs no spec or bound plan.

When an ask needs many files read to understand its domain, ground first using [grounding guidance](../grounding.md).

Include settled chat decisions and constraints that the delegates cannot find in supplied files. Provider delegates return claims; inspect the full answers in the result file before synthesis. Verify disagreement against source and report an evidence-backed verdict, with any coverage gap. When source checks leave a material unknown or disagreement that needs user context, state the missing information and use the [Decision Frame](../decision-frame.md). Resolve routine facts autonomously and retain settled decisions.

Launch each native slot under [native slots](../providers.md#native-slots) in launch order: the first call returns descriptors before any CLI launch, so launch every native slot and retain its handle, then rerun at once on `cliWave: "pending"` to run the CLI wave, and rerun to consume only after every retained handle finished or was reported. Report a failed voice with `--native-failed '<attempt>=<reason>'`. When answering a native voice yourself, read its prompt. [Providers](../providers.md) owns configured launch fidelity and fallback.

## Step reads

| Step | Reads |
| --- | --- |
| Write the question file and run the tool | [toolkit contract](../toolkit.md#ask-run) |
| Ground first when the domain needs many files read | [grounding guidance](../grounding.md) |
| Launch voices and synthesize under native slots | [native slots](../providers.md#native-slots) |
