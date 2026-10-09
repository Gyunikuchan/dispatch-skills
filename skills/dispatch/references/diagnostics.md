# Dispatch retro

Name up to 3 ways dispatch instructions, the driver, or routing made this run slower, costlier, or wrong, beyond measured time, tokens, failures, and rounds.

Reply `RETRO` with `observations`: `[{id,component,category,evidence,impact,proposedFix}]`; `[]` means no friction.

- `id`: 1-48 chars of `A-Za-z0-9_-`, unique.
- `component`: the dispatch file at fault, from the skill root, e.g. `SKILL.md`, `scripts/core/frame.ts`.
- `category`: `correctness`, `token-economy`, `speed`, `review-convergence`, `instruction-clarity` (the contract misled), or `information-access` (context you had to rediscover).
- `evidence`, `impact`, `proposedFix`: one line each, at most 512 bytes; cite the instruction and its observed effect.

Exclude repository, toolchain, and user-work issues. Fixes must hold on any repository and machine; prefer a deterministic driver check over prose. Use dispatch terms only: no user source, objective, absolute paths, URLs, emails, UUIDs, or secrets.
