# Dispatch diagnostics

When session output enables diagnostics, the orchestrator must write a JSON array to `<session>/.state/retro.json` before report completion; `[]` means no friction. Name up to 20 Dispatch instruction, driver or routing defects beyond measured time, tokens, failures and rounds.

Each item is `{id,component,category,evidence,impact,proposedFix}`.
- `id`: unique, 1-48 chars of A-Za-z0-9_-.
- `component`: Dispatch file from the skill root, e.g. `references/toolkit.md`.
- `category`: `correctness`, `token-economy`, `speed`, `review-convergence`, `instruction-clarity`, `information-access`.
- `evidence`, `impact`, `proposedFix`: one line each, at most 512 bytes.

Exclude repository, toolchain, and user-work issues. Fixes must hold on any repository and machine. Use Dispatch terms only: no user source, objective, absolute paths, URLs, emails, UUIDs, or secrets.
