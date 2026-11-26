# Diagnostics

If enabled, at each verb's final handoff, merge your terse notes into the JSON array at `<session>/.state/retro.json` yourself (unique ids, max 20 defects); investigating logs/chat follows the [context guard](../SKILL.md#context-guard) and may use a research explorer. Without notes, add nothing; if no file, write `[]`. Then run `diagnostics render` ([cost and recovery](toolkit.md#diagnostics-render)). `[]` is valid empty; missing, unreadable, malformed or non-array input is uncollected.

Item: `{id,component,category,evidence,impact,proposedFix}`.

- `id`: 1-48 A-Za-z0-9_- chars.
- `component`: skill-relative file.
- `category`: `correctness`, `token-economy`, `speed`, `review-convergence`, `instruction-clarity`, `information-access`.
- `evidence`, `impact`, `proposedFix`: one line each, at most 512 bytes.

Grounding-phase retro item, shown in the `### Grounding` table:

- id: grounding-<phase> component: references/grounding.md category: information-access
- evidence: map <n>, nested <n>, research <n>, not-covered <n>, yield <changed>/<launched>, tokens <per explorer from launch notice, else unavailable> `yield` counts nested and research explorers whose reply changed a REQ, DEC, scope or blast radius. `impact` and `proposedFix` say whether to keep or change explorer token limits or nesting rules.

Exclude repository, toolchain, and user-work issues. Fixes must hold on any repository and machine. Use Dispatch terms only: no user source, objective, absolute paths, URLs, emails, UUIDs, or secrets.

Collection or a failed merge is never a workflow gate.
