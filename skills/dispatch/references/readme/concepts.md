# Concepts

The journal records host replies and automatic effect results. Replaying it reconstructs the same machine state; `status` shows progress and worker claims without mutating it. Eight awaits identify the judgment the host must provide. Bulk prompts and artifacts live in files, so frames stay compact.

One artifact folder belongs to one chat. First initialization fixes its title; terminal handoff retains the folder in the workspace. Reactivation reuses that same identity for later work. See [usage](../../README.md).

## Task execution

A plan groups file changes under task outcomes, with stable IDs, prerequisites, and criterion mappings. File entries define ownership; shared-file edits belong to one task. Shared interfaces become prerequisite tasks. Generated outputs belong to a task whose prerequisites cover their input producers; cross-task criteria use the template's Integration mapping. The graph yields a compact execution summary rather than fixed waves.

Tasks are pending, running, submitted, accepted, or failed. Readiness requires accepted prerequisites. Plan order breaks admission ties and `write-concurrency` caps active writers; cap one uses the same isolated path. Candidates are checked serially while unrelated writers retain their handles. The host must respect available native capacity and preserve the frame's task/handle identities.

Private execution inputs reproduce tracked dirt, required untracked files, ignored configuration, and dependency availability without committing to the caller branch. Each ready task starts from an integrated revision containing accepted prerequisites. A focused brief carries task ownership, overall graph, prerequisite revisions, criteria, approval, receipt schema/path, and the full governed plan path/hash.

For unwaived RED criteria, the writer's continuous development loop records tests before production; acceptance independently replays its RED checkpoint at the input revision, rejects setup-only failures, and checks immutable submitted tests. Every task receives scope and GREEN checks, integration of its owned delta, and affected contract checks. An independent candidate from an older baseline can be integrated without replacing the whole tree. Evidence binds the revision it checked; later mutations require final verification.

A failed task blocks descendants while independent branches continue. Recovery through `status` and `send` replays retained handles, candidate revisions, and integration records; the host reconnects to its native writers instead of launching duplicates. Quiesce live writers before revising governing inputs. Failed worktrees and receipts remain available for the emitted retry/revise/stop decision.

Caller drift on transferred paths blocks delivery. Interrupted transfer recognizes already-delivered contents and transfers the remaining delta while preserving unrelated dirt. The current delivery, cleanup, final review, regeneration, and gate order—and its limits—are specified in [implementation](../verbs/implement.md).
# Session diagnostics

Enabled diagnostics produces one shareable `diagnostics.md` in the owning session folder, with preserved per-run histories and major-phase summaries. The final frame links to the report when it exists. Share the file by copying or attaching it; no upload is performed.

Elapsed time includes unclassified gaps; invocation work sums measured durations and can exceed elapsed time when delegates overlap. Parent phases show inclusive and exclusive time. Token figures are provider-scoped covered subtotals; unsupported, truncated, resumed and native surfaces remain unavailable. Codex input includes cached input, while Claude main-loop input and cache counters are disjoint. Failed calls can consume tokens. Actual reported models remain separate from configured aliases.

Host observations are optional metadata on existing replies. Proposed improvements are unverified suggestions and never change workflow decisions, findings, approvals or gates. Unknown free text is withheld unless it matches dispatch-owned instruction excerpts.
