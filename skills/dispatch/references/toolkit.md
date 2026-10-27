# Toolkit CLI contract

Invoke `node <skills-dir>/dispatch/scripts/dispatch.ts <tool> <action> … --session <session>`. All tool calls need an initialized session. Artifact paths are relative to the repository root unless stated otherwise; record JSON filenames and question filenames resolve from the current directory.

Stdout is `{ok, summary, path, reason?}`: summary is at most 1024 UTF-8 bytes and path identifies a JSON result file under the session. Read that file for full findings, logs, briefs or state. Usage or output-write failures may have path null. Exit 0 means the operation returned; inspect ok and reason even at exit 0. Exit 1 is usage or invalid input, 2 a fault, 3 a held lock, 4 a gate refusal or pending native work. Common refusals include unreadable input, invalid manifest, ledger corruption and lock contention. Keep the supplied handle and wait for a live lock; inspect stale-lock evidence before recovery.

## Tool actions

### ask run

Arguments: `ask run <question-file> --session <session> [--level <level>]`.
Result path: answers, failed slots and native slots; successful captures also persist answers.json.
Refusals: unreadable question, invalid level, level-unapproved, no read delegate, native-pending or ask-failed.

### review run

Arguments: `review run <target> --session <session> [--kind plan|design|code] [--spec <path>] [--level <level>]`.
Result path: full findings, sources, failures, round, coverage, continuation and escalation details, or native slots.
Refusals: invalid input/kind/revision, unreadable or conflicting spec, lint-errors, level-unapproved, missing integration/finished launch, native-pending, target-moved, escalation-open or round-cap. An accepted MUST fix or pending MUST rejection permits continuation past the cap. An open rejection escalation blocks launches while the rejection remains pending; resolve it or accept the finding for repair under [review rules](review-rules.md#rulings-and-fix-scope). A single revision without a merge-base is invalid-input.

When assigned rejection requests, each logical source slot must reply with `confirmations: [{requestId, decision: "agree"|"disagree", rationale}]`, with exactly those item fields and one nonblank rationale per request. Ordinary `status` and `findings` remain required. Missing, extra, duplicate or malformed replies fail validation. Results retain original finding/ruling identity, captured target/spec and physical responder. Old reports without confirmations remain valid only when no requests are assigned.

Plan/design target paths select artifacts. Code targets resolve in order: integration; a bound-plan task ID; worktree; `<a>..<b>`; `<rev>`. Without a bind, a task-like name resolves as a Git revision. Standalone review uses --spec or the bound spec and needs no plan. Worktree captures HEAD plus tracked/untracked changes through a temporary index, preserves HEAD blobs for tracked session paths, excludes all session changes and leaves the caller index and branch intact. Outside-repository sessions need no exclusion. Worktree round counts are per HEAD commit; a new commit starts a new review.

### report render

Arguments: `report render --session <session>`.
Result path: walkthrough path, criterion statuses, deviations, user records, findings, rejection confirmation states and evidence references. Renders the current snapshot without claiming completion.
Refusals: invalid arguments, unreadable bound artifacts or invalid plan.

### report complete

Arguments: `report complete --session <session>`.
Result path: completed walkthrough path, criterion statuses, deviations and optional diagnostics path.
Refusals: review-confirmation-required, no-integration, criteria-unmet or undelivered. Inspect reason and statuses; only a successful result is completion.

### brief render

Arguments: `brief render <task> --session <session>`.
Result path: writer brief filename, task, launch and UTF-8 bytes.
Refusals: approval-chain or level gate, lint-errors, unknown task or no-open-launch. Create the task worktree before rendering.

### worktree integrate

Arguments: `worktree integrate <task> --session <session> [--ack-stale <rationale>]`.
Result path: integration commit and task, or retained conflict paths.
Refusals: approval-chain gate, no-candidate, stale candidate, pending integration or wrong task. Inspect conflict state before continuing.

### worktree continue

Arguments: `worktree continue <task> --session <session>`.
Result path: completed integration commit after a retained conflict.
Refusals: approval-chain gate, wrong-task, no-pending-integration or unresolved-conflict.

### worktree commit

Arguments: `worktree commit --session <session> --reason <reason>`.
Result path: integration fix commit and reason; use after direct accepted fixes.
Refusals: blank reason, integration-pending or no-changes.

### worktree abort

Arguments: `worktree abort <task> --session <session> --reason <reason>`.
Result path: preserved candidate and abandoned state.
Refusals: blank reason, wrong-task, no-candidate or already-integrated. Obtain user authority before discarded accepted work.

### worktree prune

Arguments: `worktree prune --session <session>`.
Result path: declared targets and source/result commits, or an idempotent completed result.
Refusals: unsafe-transient-target, unsafe-integration, missing-final-command, transient-command-dependency, integration-pending, prune-unintegrated-tasks, prune-open-writers, integration-dirty, prune-prechecks-required, prune-review-required or prune-transition-stale. No-transient plans keep existing verification and delivery behavior.

Run after all tasks integrate, checks pass and code review of the exact committed integration HEAD is complete. Review must inspect retained durable or FINAL coverage; explicit command-path checks cannot prove opaque runner or glob semantics. Settle command corrections, rerun checks and re-review before pruning. At least one nonempty FINAL command is required even with a durable Covered by criterion. A projected command that explicitly names a deletion target blocks pruning.

The tool preflights the whole declared set before recording: only tracked NEW transient Tests may be deleted. It refuses support files, durable sharing, baseline files, path escapes, case collisions, links and directories. It rechecks containment before each unlink. Preflight refusal deletes nothing. A later failure retains already completed declared deletions for recovery; this is not an atomic filesystem transaction.

The integrate prune-started record binds artifact hashes, exact reviewed commit/tree, target list and command projections. pruned adds the pure-deletion commit/tree. Retry the same call after interruption: only the recorded deletions may be missing or dirty; unrelated edits or stale identities block recovery. Keep the old pruning records and evidence.

For a post-prune artifact correction, preserve edited artifact bytes and all evidence; delivery refuses the stale transition. In an otherwise clean integration worktree, restore only absent declared targets from the recorded source commit, then commit that restoration with worktree commit. Reverify and re-review the corrected artifact tuple before a new prune attempt. Preserve unrelated work and old records.

### worktree deliver

Arguments: `worktree deliver --session <session>`.
Result path: mode (uncommitted), dest, from (original caller base), source (verified integration HEAD), ref (refs/dispatch/<safeSessionId>/delivered-source), paths (delivered paths), delivered boolean and noop when the source and base trees match. A completed retry returns delivered false and the recorded identities.
Refusals: integration-pending, no-integration, caller-moved, caller-dirty, integration-dirty, unsupported-sparse, unsupported-entry, pruning-required, prune-transition-stale, final-checks-required, review-confirmation-required or recovery-blocked. Preserve caller changes and session evidence; inspect the result before retrying.

Pending or escalated applicable MUST rejections refuse delivery before caller writes or a delivered record. The same closure query gates pruning and report completion; see [review rules](review-rules.md#rulings-and-fix-scope).

Delivery makes no caller commit and stages nothing. It restores the verified source tree into the caller working tree as unstaged changes; caller HEAD stays at from. New files appear as untracked (`??`) in `git status`. Internal writer and integration commits stay in the session. Transient plans require absent targets and successful final-tree checks before any caller write. Same-tree delivery writes nothing and records noop.

Require the original caller branch and HEAD and an empty index, including intent-to-add entries, for every delivery including no-op. Caller changes outside the delivered paths remain, including tracked edits, untracked and ignored files. Delivery refuses caller-dirty when a tracked-modified, untracked or ignored caller path equals, contains or is contained by a delivered path. It refuses unsupported-sparse when the caller uses sparse checkout, and unsupported-entry when a delivered path is a gitlink; both refuse before any caller write. Git writes the files through a session-owned temporary index; the caller index is never used. It rechecks source, branch, HEAD, index and delivered paths after the pre-apply step and before it records delivered; a mismatch refuses caller-dirty without recording delivered. The check and the write are separate operations, so concurrent external edits in that interval remain a race limit.

Before it records deliver-started, delivery retains source at the ref. A missing ref is created; a ref equal to source is reused; any other value refuses recovery-blocked. Cleanup keeps this ref, so the source stays resolvable after the integration branch is deleted. A matching deliver-started without delivered permits recovery: retry accepts delivered paths that equal from or source and completes the write. An interruption inside Git's own per-file write can leave a path that matches neither tree. Retry refuses caller-dirty and names that path; restore it with `git restore --source=<ref> -- <path>` or discard it. These boundaries support process-crash recovery; they do not promise power-loss durability.

To inspect or undo the delivery, use `git diff` and `git status`. To restore a file from the retained source, use `git restore --source=<ref> -- <path>`.

A completed retry with the same source returns the recorded outcome without checking or changing later caller work. A changed source requires a new run. A conflicting ref, changed pending source, or unsupported pending delivery mode refuses recovery-blocked. Preserve refs, records and worktrees for manual inspection; do not reset caller work.

### worktree close

Arguments: `worktree close --session <session> --reason <reason>`.
Result path: closed state and reason, ending an integration retained for recovery.
Refusals: blank reason or unexpected task argument. Closing records state; it does not establish verification or authorize discarded work.

### worktree cleanup

Arguments: `worktree cleanup --session <session>`.
Result path: removed paths and kept paths with reasons, including unowned, non-terminal and unpreserved.
Refusals: unexpected arguments, lock or filesystem/Git fault. Kept paths require inspection; cleanup preserves snapshots and ignored files. See [cleanup](worktree-cleanup.md).

### worktree create

Arguments: `worktree create <task> --session <session> [--relaunch]`.
Result path: task, launch and worktree path, plus restored/relaunch markers when applicable.
Refusals: unknown task, writer-open, candidate-pending, no-open-launch, missing-worktree or submit-pending. Relaunch requires the orchestrator to establish that the old writer has stopped.

### worktree submit

Arguments: `worktree submit <task> --session <session>`.
Result path: task, launch, candidate commit and any uncommitted paths.
Refusals: no-open-launch, out-of-scope, submit-pending or no-changes. The orchestrator invokes this Git-writing tool after the writer stops.

### worktree abandon

Arguments: `worktree abandon <task> --session <session> --reason <reason>`.
Result path: preserved writer snapshot, task/launch and abandoned marker.
Refusals: blank reason, no-open-launch or submit-pending. Preserve changes and obtain user authority when discarding work.

### verify run

Arguments: `verify run --session <session> [--criteria SC1,SC2,contract] [--final]`.
Result path: checks with command digests, tree identity, clean/before/after state, exit and evidence/log paths; failed, mutated and dirty lists.
Refusals: unknown criterion, invalid arguments or unreadable bound plan. checks-failed, mutated and dirty can return exit 0 with ok false. Checks execute on the integration tree; successful evidence must match current commands and a clean unchanged tree.

After pruning, --final requires a validated current transition and runs every non-transient command, transient FINAL commands and contract checks on the committed pruned tree. Check identities are final:<criterion> and final:contract, with digests of their exact arrays. Empty executable rows are omitted. With --final, --criteria selects these final: identities; omission runs every projected row. A failed rerun invalidates an earlier final success. Historical transient evidence keeps its original source tree and full pre-prune digest; it verifies only through the exact recorded pure-deletion transition plus every successful final row. Durable evidence must describe the final tree. Manual completion and waivers do not establish final verification. Rendered status cites historical and final evidence separately.

### ledger append

Arguments: `ledger append <record.json> --session <session>`.
Result path: appended seq and deduped boolean.
Refusals: unreadable JSON, invalid-record, missing-key, user-only, key conflict or invalid edit chain. Fields and authorship are below.

### ledger query

Arguments: `ledger query --session <session> [--kind <kind>] [--key <key>] [--since <seq>]`.
Result path: matching full records.
Refusals: positional arguments or invalid filters.

### doctor run

Arguments: `doctor run --session <session> [--level <level>]`.
Result path: integrity, configuration path/problems, selected level and configured writer models/efforts. Doctor does not probe provider/mode availability, authentication or sandbox support.
Refusals: positional arguments or invalid configuration. Inspect ok and reason for failed integrity or unavailable capabilities.

### status show

Arguments: `status show --session <session>`.
Result path: ledger summary, artifact hashes, worktrees, writers and integration state.
Refusals: positional arguments, invalid state or Git/filesystem fault. Use this after interruption before deciding what to resume.

### lint run

Arguments: `lint run <artifact> --session <session>`.
Result path: artifact kind/hash, parse errors and warnings. The reported hash is the formatting-tolerant canonical artifact hash that approval, edit and gate records use; formatting-only rewrites keep it.
Refusals: unreadable/unknown artifact or lint-errors. Blocking defects cover REQ IDs, criterion IDs, Verify commands and task paths; other findings are warnings for review.

## Ledger records

Append JSON objects with kind, by, data, optional key and optional quote. Allowed by values are user, orchestrator and tool, except the user-only rules below. Tools supply seq and at on storage. Use stable explicit keys for bind, approval, level, escalation, edit, ruling and note; remaining kinds can derive idempotency keys. Reusing a key with different content refuses. Preserve quotes verbatim; never invent user evidence.

### bind

data: `spec`, `plan`, optional `design` are canonical artifact paths. Allowed by: user, orchestrator, tool.

### approval

data: `spec`, `plan`, optional `design` are artifact hashes, forming one approval tuple. Allowed by: user only with a nonblank quote. At medium and above, writer briefs and integration require this tuple or its non-intent edit chain.

### level

data: level selects low, medium, high, xhigh or max. Allowed by: user, orchestrator, tool for low/medium/high; xhigh/max require by user with a nonblank quote.

### waiver

data: `criterion`, `reason`. Allowed by: user only with a nonblank quote.

### manual-complete

data: `criterion`, `evidence`. Allowed by: user only with a nonblank quote.

### escalation

data: id, state (open/resolved), summary. Allowed by: user, orchestrator, tool. Resolve recorded escalations with retained evidence.

### ruling

data: `subject`, `ruling`, `rationale`. Allowed by: user, orchestrator, tool. A review subject is review:<review>:<finding>, with ruling accepted/rejected/duplicate/deferred.

### note

data: text. Allowed by: user, orchestrator, tool.

### edit

data: artifact (spec/plan/design), `before`, `after`, `class` (non-intent/intent/dependency/discard), `affects` (task IDs), `rationale`, `diffRef`. Allowed by: user, orchestrator, tool. Orchestrator non-intent edits extend an approved hash chain; intent, dependency and discard require a new approval tuple. Hash artifacts using the canonical hash reported by lint, not a hash of incidental report history. Include every edit as a walkthrough deviation.

### evidence

data: `criterion`, `commandDigest`, `tree`, `clean`, `before`, `after`, `exit`, path, optional artifacts tuple. Allowed by: user, orchestrator, tool; verify writes these records from actual commands. User-only manual records are separate.

### writer

data includes `phase` and `task`. launched adds path and base {commit, taskSection, seq}; finished adds `launch`, `candidate`; abandoned adds launch and reason. Allowed by: user, orchestrator, tool; worktree tools maintain actual lifecycle records.

### integrate

data includes `phase`: opened {path, branch, base, `dest` {branch,path}}; started {task,candidate}; conflict {task,paths}; done {task,commit}; abandoned {task,candidate,reason}; fix {commit,reason}; deliver-started {mode:'uncommitted',dest,from,source}; delivered {mode:'uncommitted',dest,from,source,noop?}; closed {reason}; prune-started {operation,artifacts,from,sourceTree,targets,pre,final,review}; pruned adds {to,tree} to that snapshot. Delivery fields `mode`, `from` and `source` have the meanings above; `from` and `source` are Git object IDs; `noop` is boolean. Delivery records require this shape; missing mode, squash mode and unknown fields are invalid. Older delivery records require a new session. operation is a stable snapshot digest; pre/final contain exact criterion identities, command arrays and commandDigest. Allowed by: user, orchestrator, tool; worktree tools maintain actual lifecycle records.

## Native-slot replies

When reason is native-pending, read the result's native slots and each promptPath. Launch the configured slot with its model, effort and attachments, retain the handle, and write its complete output to replyPath. Then rerun the same call with unchanged arguments. The tool consumes the reply and reuses completed slots. Report capability blockers or failed coverage; do not fabricate a capture. [Providers](providers.md) owns launch fidelity and read-only controls.

## Session commands

These commands use --session-dir rather than --session and run before tool calls.

### session init

`session init --objective "<objective>" [--session-id <id>]` creates/reuses retained workspace session state in the current Git repository. It uses the platform session identity when available and a generated fallback otherwise. Stdout: {ok:true, summary, path:<sessionDir>}; summary is at most 1024 UTF-8 bytes. Read manifest.json for session identity. Follow optional `instructions` returned by init or reactivate. Failures return {ok:false, summary, path:null, reason:'usage'|'fault'} with exit 1 or 2.

### session reactivate

`session reactivate --session-dir <session>` reactivates the same session idempotently. Stdout: {ok:true, summary, path:<sessionDir>} with the same byte cap.

### session quota-reprobe

`session quota-reprobe --session-dir <session> --provider <id> --mode <mode> [--model <alias>]` clears one quota key. Stdout: {v:1, action:'quota-reprobe', key:{provider,model,mode}, appliesTo:'future-waves'}. Omit model for the provider default (null). Provider and mode must match a known provider implementation. Changes affect future provider selection.
