# Concepts

The journal records host replies and automatic effect results. Replaying it reconstructs the same machine state; `status` shows progress and worker claims without mutating it. Eight awaits identify the judgment the host must provide. Bulk prompts and artifacts live in files, so frames stay compact.

One artifact folder belongs to one chat. First initialization fixes its title; terminal handoff moves the whole folder to OS temp. Reactivation restores that same identity for later work. See [usage](../../README.md).
# Session diagnostics

Enabled diagnostics produces one shareable `diagnostics.md` in the owning session folder, with preserved per-run histories and major-phase summaries. The final frame links to the report when it exists. Share the file by copying or attaching it; no upload is performed.

Elapsed time includes unclassified gaps; invocation work sums measured durations and can exceed elapsed time when delegates overlap. Parent phases show inclusive and exclusive time. Token figures are provider-scoped covered subtotals; unsupported, truncated, resumed and native surfaces remain unavailable. Codex input includes cached input, while Claude main-loop input and cache counters are disjoint. Failed calls can consume tokens. Actual reported models remain separate from configured aliases.

Host observations are optional metadata on existing replies. Proposed improvements are unverified suggestions and never change workflow decisions, findings, approvals or gates. Unknown free text is withheld unless it matches dispatch-owned instruction excerpts.
