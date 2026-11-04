# Diagnostics

If enabled, at each verb's final handoff, give a utility subagent terse notes and this file's path to merge into the JSON array at `<session>/.state/retro.json` (unique ids, max 20 defects). When none resolves, merge them yourself. With no notes, launch nothing; if no file, write `[]`. Then you run `diagnostics render`. `[]` is valid empty; missing, unreadable, malformed or non-array input is uncollected.

Item: `{id,component,category,evidence,impact,proposedFix}`.
- `id`: 1-48 A-Za-z0-9_- chars.
- `component`: skill-relative file.
- `category`: `correctness`, `token-economy`, `speed`, `review-convergence`, `instruction-clarity`, `information-access`.
- `evidence`, `impact`, `proposedFix`: one line each, at most 512 bytes.

Exclude repository, toolchain, and user-work issues. Fixes must hold on any repository and machine. Use Dispatch terms only: no user source, objective, absolute paths, URLs, emails, UUIDs, or secrets.

Collection or a failed launch is never a workflow gate.
