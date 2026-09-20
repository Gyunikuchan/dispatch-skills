# Minimum walkthrough contract

A walkthrough is valid when its Markdown body contains, in order:

1. one H1 describing the implementation;
2. `## Changes Made`;
3. `## Verification & Validation`, with every selected command, exit status, and concise output
   evidence in `Command: \`<command>\` — exit <status>; <evidence>` form;
4. `## Key Deviations`;
5. `## Review Findings & Resolutions`, initially containing `*No reviews conducted yet.*`; and
6. `## Follow-ups`.

The walkthrough exists before baseline verification and remains the durable record when code
review is unavailable. A renderer may add subsections and comments while preserving this
contract.
