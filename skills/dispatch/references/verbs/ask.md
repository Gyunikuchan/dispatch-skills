# Ask

Write the question to a UTF-8 file and use `ask run`. The [toolkit contract](../toolkit.md#ask-run) owns arguments and outputs. Ask needs no spec or bound plan.

Include settled chat decisions and constraints that the delegates cannot find in supplied files. Provider delegates return claims; inspect the full answers in the result file before synthesis. Verify disagreement against source and report an evidence-backed verdict, with any coverage gap.

For native slots, read each prompt, write its answer to the supplied `replyPath`, then rerun the same call. [Providers](../providers.md) owns configured launch fidelity and fallback.
