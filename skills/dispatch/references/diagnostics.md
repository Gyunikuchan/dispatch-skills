# Diagnostics

If enabled, at each verb's final handoff the orchestrator must write or merge a JSON array into `<session>/.state/retro.json` (unique ids, max 20 defects), then run `diagnostics render`. `[]` is valid empty; missing, unreadable, malformed or non-array input is uncollected.

Item: `{id,component,category,evidence,impact,proposedFix}`.
- `id`: unique; 1-48 A-Za-z0-9_- chars.
- `component`: skill-relative file.
- `category`: `correctness`, `token-economy`, `speed`, `review-convergence`, `instruction-clarity`, `information-access`.
- `evidence`, `impact`, `proposedFix`: one line each, at most 512 bytes.

Exclude repository, toolchain, and user-work issues. Fixes must hold on any repository and machine. Use Dispatch terms only: no user source, objective, absolute paths, URLs, emails, UUIDs, or secrets.

Missing data cannot prove no defects. Collection is never a workflow gate.
For deep grounding, record the disputed count and the strategy each source-verified dispute favoured.
