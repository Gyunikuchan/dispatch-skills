# Dispatch diagnostics

When enabled, the orchestrator must write a JSON array to `<session>/.state/retro.json` before report completion: at most 20 defects. `[]` is valid empty; missing, unreadable, malformed or non-array input is uncollected.

Item: `{id,component,category,evidence,impact,proposedFix}`.
- `id`: unique; 1-48 A-Za-z0-9_- chars.
- `component`: skill-relative Dispatch file.
- `category`: `correctness`, `token-economy`, `speed`, `review-convergence`, `instruction-clarity`, `information-access`.
- `evidence`, `impact`, `proposedFix`: one line each, at most 512 bytes.

Exclude repository, toolchain, and user-work issues. Fixes must hold on any repository and machine. Use Dispatch terms only: no user source, objective, absolute paths, URLs, emails, UUIDs, or secrets.

Missing data cannot prove no defects. Collection is never a workflow gate.
For deep grounding, record one observation: disputed count and strategy each source-verified dispute favoured.
