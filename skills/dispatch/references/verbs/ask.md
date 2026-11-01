# Ask

`ask` is user-initiated: invoke `ask run` only for explicit user requests, never autonomous internal research. For research, exploration or grounding, use native [explorers](../grounding.md). When no explorer is configured for the host platform, the host agent self-grounds under [self-grounding](../grounding.md#publish); an unlaunchable configured explorer is a blocker.

Use it for source cross-checks and differentiated model opinions or suggestions.

Write the question to a UTF-8 file and use `ask run`. The [toolkit contract](../toolkit.md#ask-run) owns arguments and outputs. Ask needs no spec or bound plan.

When an ask needs many files read to understand its domain, ground first using [grounding guidance](../grounding.md).

Include settled chat decisions and constraints that the delegates cannot find in supplied files. Provider delegates return claims; inspect the full answers in the result file before synthesis. Verify disagreement against source and report an evidence-backed verdict, with any coverage gap. When source checks leave a material unknown or disagreement that needs user context, state the missing information and use the [Decision Frame](../decision-frame.md). Resolve routine facts autonomously and retain settled decisions.

Launch native slots by path under [native slots](../providers.md#native-slots), then rerun the same call. When answering a native voice yourself, read its prompt. [Providers](../providers.md) owns configured launch fidelity and fallback.
