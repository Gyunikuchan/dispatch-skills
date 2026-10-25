# Dispatch diagnostics

When diagnostics is enabled, the orchestrator must write a JSON array to `<session>/.state/retro.json` before report completion. `[]` is a valid empty observation; missing, unreadable, malformed or non-array input is uncollected. Record at most 20 observed Dispatch defects.

Each item: `{id,component,category,evidence,impact,proposedFix}`.
- `id`: unique, 1-48 chars of A-Za-z0-9_-.
- `component`: skill-relative Dispatch file.
- `category`: `correctness`, `token-economy`, `speed`, `review-convergence`, `instruction-clarity`, `information-access`.
- `evidence`, `impact`, `proposedFix`: one line each, at most 512 bytes.

Exclude repository, toolchain, and user-work issues. Fixes must hold on any repository and machine. Use Dispatch terms only: no user source, objective, absolute paths, URLs, emails, UUIDs, or secrets.

Missing measurements cannot establish no defects. Collection is never a workflow gate.
