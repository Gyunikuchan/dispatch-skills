# Dispatch toolkit refactor design

> **TL;DR:** Loosen the current driver's non-intent gates, build a deterministic toolkit plus append-only ledger beside it, cut over prose and CLI, delete the state machines, and release v0.8.0 only after a measured comparison passes.
>
> **Parent:** `.scratch/dispatch-skills/20261021T1011Z-refactor-dispatch-to-cut-complexity-brit/refactor-the-dispatch-skill-to-be-less-c.spec.md` · sha256:a5635edcf4dae99cbcdd83d1d73bbf5fc96d44d704bb8fb02adf279bc318237d
>
> **Decide:** none
>
> **Risk:** high — replaces the engine and host protocol; correctness relies more on orchestrator judgment, guarded by tree-bound verification, ledger gates and a pre-release comparison.
>
> **Increments:** 9

## Execution Status
| ID | State | Summary | Next Action |
| --- | --- | --- | --- |
| I01 | ready | Baseline measurement on v0.7.3 | implement:I01 |
| I02 | ready | Loosen non-intent gates in current driver | implement:I02 |
| I03 | blocked | Toolkit foundation: CLI, ledger, lint, doctor, status | - |
| I04 | blocked | verify, worktree, brief tools | - |
| I05 | blocked | ask and review fan-out tools | - |
| I06 | blocked | report tool | - |
| I07 | blocked | Cutover: CLI routing, prose, aliases | - |
| I08 | blocked | Pre-release comparison gate | - |
| I09 | blocked | Legacy deletion and structural targets | - |

Next Action: implement:I01

## Approach
- REQ-1 → toolkit modules I03–I06; routing I07; machine removal I09.
- REQ-2 → output helper and central per-tool byte-cap test (I03, extended by I04–I06).
- REQ-3 → approval tuples and chain gate (AD-3, I03), called by `brief` and `worktree integrate` (I04); production-write and level-adoption gates removed from the current driver (I02).
- REQ-4 → ledger `edit` records and chain rules (AD-3); writer staleness (AD-7, I04); phase prose for living documents (I07).
- REQ-5 → current-driver admission relaxed (I02); tree-bound `verify` and outcome-only completion (AD-4, I04, I06); brief template (I04).
- REQ-6 → toolkit severity mapping (I03); current lint downgraded (I02).
- REQ-7 → `review` tool and `ruling` records (I05).
- REQ-8 → ledger durability (AD-2), integration and delivery recovery (AD-6), writer launch recovery (AD-7), stale-lock recovery (AD-10), `status` (I03, writer section I04).
- REQ-9 → `level` record and gate check (AD-3, I03); selectors consumed by `review` (I05).
- REQ-10 → prose rewrite (I07) and mechanics deletion (I09).
- REQ-11 → baseline (I01), comparison gate with legacy still present (I08), structural targets (I09).

## Alternatives & Decisions

### AD-1 — New code lives in `scripts/toolkit/` behind a side entry until cutover
- Choice: `scripts/toolkit/` with entry `scripts/toolkit/cli.ts`; I07 routes `scripts/dispatch.ts` to it; I09 deletes the legacy engine after the I08 comparison passes.
- Rationale: the legacy driver stays runnable through I06, so each increment lands without breaking current runs; routing and deletion are separate revert boundaries.
- Rejected: adding commands to the current `dispatch.ts` (name clash with `status`, mixed routing); a fresh repository (loses history and reusable modules).

### AD-2 — Ledger: one append-only JSONL file with torn-tail recovery
- Choice: `<session>/ledger.jsonl`. Record `{seq, key, at, kind, by, quote?, data}`. Kinds: `level`, `approval`, `waiver`, `manual-complete`, `escalation`, `ruling`, `edit` (decision kinds, 7), plus `bind`, `evidence`, `writer`, `integrate`, `note` (12 total). Each kind has a closed set of `data` shapes; `writer` phases are `launched`, `finished`, `abandoned`, and `integrate` phases are `opened`, `started`, `conflict`, `done`, `abandoned {task, candidate, reason}`, `fix`, `deliver-started`, `delivered`, `closed`. Validation rejects unknown kinds and phases (exit 1).
- Append: under the session lock, write one line ending in `\n` and fsync. `key` is an idempotency key (caller-supplied or the digest of kind and data); appending an existing key with identical kind and data returns the existing `seq` and writes nothing; the same key with different kind or data is a fault (exit 2) naming the key.
- Query: `ledger query [--kind k] [--key k] [--since seq]` writes matching records to a result file and prints counts and the last match within the byte cap.
- Recovery: a final line without `\n` or with invalid JSON is a torn tail; fold ignores it, and the next append moves it to `ledger.torn-<n>.jsonl` and truncates the file to the valid prefix. An invalid non-final line is corruption: tools exit 2 naming the line, and nothing is rewritten.
- Rationale: one stack-neutral file; crash-safe without journal replay; kinds stay within REQ-11.
- Rejected: per-run typed journals (current cost); SQLite (runtime dependency).

### AD-3 — Approval tuples and the chain gate
- Artifact binding is independent of approval: a `bind {spec, plan, design?}` record (paths only) names the session's governing artifacts at every level, and a later `bind` replaces it. Paths are relative to the caller repository root (the `dest` checkout), never to an owned worktree, because governing artifacts may be untracked. Tools locate artifacts from the latest `bind`, so commands take no artifact path arguments.
- `approval` binds the hashes of the currently bound artifacts `{spec, plan, design?}` with `by:"user"` and a non-empty verbatim quote; all bound artifacts are required. At `low` no approval exists and tools still work from `bind`.
- `edit` records an orchestrator or user change to one artifact: `{artifact, before, after, class, affects, rationale, diffRef}` with `class` in `non-intent | intent | dependency | discard` and `affects` listing the task IDs whose work the edit changes (empty when none).
- `gate(fold, current, level)`: take the latest approval; for each artifact, start at its approved hash and replay only `edit` records for that artifact with `seq` greater than the approval's `seq`, in `seq` order, advancing only when an edit's `before` equals the chain hash; any non-matching edit is `unrecorded-change`. Allowed when every artifact's replay ends at its current hash through `non-intent` edits only. Forward replay handles reversions (P0 → P1 → P2 → P1) without cycles. Refused when a hash has no chain (`unrecorded-change`), the chain contains a non-`non-intent` edit after the approval (`intent-change`), no approval exists at medium+ (`missing-approval`), or the level is `xhigh`/`max` without a `level` record by the user (`level-unapproved`).
- A new user approval re-roots all chains at its tuple. At `low`, only the level check applies.
- Rationale: implements DEC-16; least privilege at the only two points that write or merge code.
- Rejected: per-artifact approvals (partial approvals are ambiguous); gating every tool (re-creates friction).

### AD-4 — Verification is bound to tree identity; caching only for pure tools
- `verify` always executes; it never returns a cached result. Each evidence record binds `{criterion, commandDigest, tree, clean, before, after, exit}`.
- Tested-content identity: `tree` is the Git tree id of a temporary index built with `add -A` over the checkout, so it covers tracked and untracked non-ignored files. `clean` is true when that tree equals the checkout's HEAD commit tree.
- Purity precondition: Verify commands must not change non-ignored content. If `before ≠ after`, the evidence is `mutated` and ineligible; the orchestrator commits or discards the change and reruns until a run leaves the tree unchanged.
- Write order: evidence file (temp + rename), then ledger append keyed by the evidence digest; a rerun appends a missing record.
- `report` eligibility: a criterion is `verified` only by passing, `clean`, non-mutated evidence whose `tree` equals the current integration HEAD commit tree and whose `commandDigest` matches the current plan. A dirty integration checkout never yields eligible evidence. Any integration or review fix after verification therefore requires re-verification.
- A criterion may instead be `waived` (user `waiver`: criterion not required) or `manual` (user `manual-complete`: criterion met, with the user's stated evidence). Both require `by:"user"` and a quote; the report shows `verified`, `manual` and `waived` separately.
- Result-digest caching applies only to `lint`, keyed by the artifact bytes. `brief` always calls `gate` and renders fresh; `status`, `ledger`, `verify`, `worktree`, `ask` and `review` never serve cached output.
- Rejected: input-digest caching for every tool (returns stale success after tree changes).

### AD-5 — Reuse without editing legacy modules
- I02 edits only `machines/`, `domain/`, `references/` and tests. At I03 start the toolkit vendors every `domain/` module it uses into `scripts/toolkit/domain/`, copied from the I02 commit; it imports `providers/`, `lib/`, `policy/` and `effects/git.ts` live, which I02 does not touch. Any module needing trimming is likewise copied into `scripts/toolkit/` and trimmed there. I03–I08 never edit legacy files.
- Core types: vendored copies rewrite `../core/types.ts` imports to `scripts/toolkit/types.ts`, which holds the subset the toolkit uses. Live-imported `providers/`, `lib/` and `policy/` keep their type-only imports of `core/types.ts`, which are erased at runtime; `core/types.ts` is retained until I09 moves the remaining types into the toolkit.
- An I03 import-graph test asserts every toolkit import resolves inside `scripts/toolkit/` or to the listed live paths (`providers/`, `lib/`, `policy/`, `effects/git.ts`).
- The toolkit classifies lint severity itself from defect codes.
- I09 makes the toolkit copies canonical, deletes the superseded legacy files, and leaves live-imported shared modules at their paths.
- Rationale: one source of truth per module at every point; I02 and I03–I06 cannot interfere.
- Rejected: moving and trimming modules in place before cutover (breaks the legacy driver and its tests).

### AD-6 — Integration recovery by recorded phase and cherry-pick trailer
- Integration worktree: the first `worktree create`, `worktree integrate` or `verify run`, whichever runs first, idempotently creates `<session>/.state/worktrees/integration` on a session branch from the caller's HEAD and appends `integrate opened {path, branch, base, dest}`, where `dest` is the caller's branch and checkout path. All integration, verification and review fixes happen there. `worktree close --reason "<text>"` appends `integrate closed` for a session that will not deliver, which permits cleanup.
- `worktree integrate <task>` appends `integrate` records with phase `started {candidate}`, `conflict {paths}`, `done {commit}` or `abandoned {task, candidate, reason}`. Cherry-picks use `-x`, so the result commit names its candidate even after manual resolution.
- On rerun after `started` without `done`: a cherry-pick in progress reports the pending conflict; a HEAD commit whose trailer or patch-id matches the candidate records `done`; a clean tree retries.
- `worktree continue <task>` commits a manually resolved conflict with the trailer and records `done`; `worktree commit --reason "<text>"` commits the orchestrator's direct verification or review fixes in the integration worktree under the lock and records `integrate` phase `fix {commit, reason}`, after which `verify run` can produce eligible evidence; `worktree abort <task> --reason "<text>"` aborts the task's in-progress cherry-pick when one exists, and otherwise rejects its finished but unintegrated candidate (for example a stale one); either way it records `abandoned {task, candidate, reason}` and keeps the candidate commit reachable under `refs/dispatch/<session>/abandoned/<task>-<launch>`, so no work is lost and no user approval is needed. The task may then be relaunched with `worktree create <task>` from the current integration HEAD.
- Delivery: `worktree deliver` holds the session lock across check, fast-forward and record. Its expected caller HEAD is the last `delivered.to` for this `dest`, or the integration `base` when none exists. It appends `integrate` phase `deliver-started {dest, from, to}` (`from` = expected caller HEAD, `to` = integration HEAD), fast-forwards the caller branch and working tree, re-checks (caller HEAD equals `to` and the delivery paths are clean), and appends `integrate` phase `delivered {dest, to}`. Rerun: caller HEAD equals `to` → append the missing `delivered` without repeating effects; caller HEAD equals `from` → proceed; otherwise refuse (exit 4, `caller-moved`).
- `caller-dirty`: delivery paths are the files changed between `from` and `to`; any tracked change or untracked non-ignored file at those paths in the caller checkout refuses with exit 4 `caller-dirty`. One session delivers to a given `dest`; another session's movement of `dest` surfaces as `caller-moved`. It never discards caller changes; on refusal the orchestrator rebases the integration branch or escalates.
- `report complete` requires a `delivered` record whose `dest` equals the opened `dest` and whose `to` equals the current integration HEAD, so a fix integrated after an earlier delivery needs a new delivery.
- Rejected: patch-id detection alone (misses resolved conflicts).

### AD-7 — Writer records and staleness
- Native writers run no Git write commands. `worktree create <task>` creates the writer worktree from the integration HEAD (`base.commit`) and appends `writer launched {task, path, base: {commit, taskSection, seq}}` at `<session>/.state/worktrees/<task>-<launch>`, so a launch after abandon or abort never collides with an earlier worktree awaiting cleanup; `--relaunch` keeps the open launch's path; the launch id is that record's `seq`. It refuses (exit 4, `writer-open`) when the task has an open launch, and (exit 4, `candidate-pending`) when the task has a finished candidate without `integrate done` or `abandoned`, so each task has at most one pending candidate; unless `--relaunch` reuses the open launch's path, which closes the old launch as `abandoned {reason: "relaunch"}` and opens a new one. Relaunch keeps uncommitted changes as the new writer's starting state and keeps the old `base.commit`; it never discards work. Relaunch refuses (exit 4, `submit-pending`) when the worktree holds an unrecorded submit commit; the orchestrator retries `submit` instead.
- `worktree submit <task>` first checks every changed path (modified, added, deleted, untracked non-ignored) against the task's plan-owned paths and refuses (exit 4, `out-of-scope`) without committing, leaving the tree for repair; otherwise it commits and appends `writer finished {task, launch, candidate}`. Retry: when the worktree is clean and HEAD is a single submit commit beyond `base.commit` with an in-scope diff, it appends the missing `finished` for that commit without committing again; if that commit's diff is out of scope, it soft-resets it to uncommitted changes and refuses `out-of-scope`. A clean worktree with HEAD equal to `base.commit` refuses (exit 4, `no-changes`).
- `worktree abandon <task> --reason "<text>"` refuses (exit 4, `submit-pending`) when the worktree holds an unrecorded submit commit; otherwise it appends `writer abandoned {task, launch, reason}`, closing a failed, cancelled or timed-out launch without a candidate, and leaves the worktree for `cleanup`; the task may then be relaunched.
- `taskSection` hashes the task's plan section and its criteria; `seq` is the ledger position at launch.
- A candidate is stale when its `taskSection` changed, or when any `edit` after its launch `seq` to the spec, design or plan lists the task in `affects`. Spec or design edits that list no task do not make candidates stale, so clarifications need no quiescence (REQ-4).
- `integrate` returns `stale` (exit 4, reason `stale-candidate`) for a stale candidate unless called with `--ack-stale "<rationale>"`, which appends a `ruling`. Retiring a task whose work is discarded is an `edit` of class `discard` and needs user approval; after that approval, `worktree abandon <task>` closes any open launch and `worktree abort <task>` records `integrate abandoned` for a finished but unintegrated candidate, so its worktree becomes terminal.
- A stale candidate of an active task needs no discard edit: the orchestrator either acknowledges it with `--ack-stale` or rejects it with `worktree abort <task>` and relaunches the task.
- The orchestrator notifies only live writers whose task is stale; others continue.
- Rejected: brief/delta hash receipts (v0.7.x cost).

### AD-8 — CLI contract
- `<tool> <action> --session <dir> [args]`:
  - `ledger append <record.json>` · `ledger query [--kind] [--key] [--since]`
  - `lint run <artifact-path>` · `doctor run [--level l]` · `status show`
  - `verify run [--criteria SC1,SC2]` (runs in the integration worktree)
  - `worktree create <task> [--relaunch]` · `worktree submit <task>` · `worktree abandon <task> --reason "<text>"` · `worktree integrate <task> [--ack-stale "<rationale>"]` · `worktree continue <task>` · `worktree commit --reason "<text>"` · `worktree abort <task> --reason "<text>"` · `worktree deliver` · `worktree close --reason "<text>"` · `worktree cleanup`
  - `brief render <task>`
  - `ask run <question-file>` · `review run <target> [--kind code|plan|design]`
  - `report render` · `report complete`
- stdout is one JSON object `{ok, summary, path, reason?}` with `summary` ≤ 1 KB UTF-8.
- Exit codes: 0 ok, 1 usage, 2 fault, 3 lock held, 4 gate refusal or stale candidate with machine-readable `reason`.
- `doctor` reports skill integrity, resolved config and writer model/effort, replacing the legacy `doctor` for self-build.

### AD-9 — Worktree ownership and writer state
- Owned worktrees live only under `<session>/.state/worktrees/<task>-<launch>` (writers) and `<session>/.state/worktrees/integration`; `writer launched` and `integrate opened` record their paths. `worktree cleanup` removes a path only when it is under that namespace, listed by `git worktree list`, recorded in the ledger, and terminal. A writer worktree is terminal only when no open launch uses its path and its latest launch is `writer abandoned`, or `writer finished` whose candidate has `integrate done` or `abandoned`. The integration worktree is terminal after `integrate closed`, or when no writer launch is open, no candidate awaits integration, and the last `delivered.to` equals the integration HEAD. Non-terminal worktrees are reported, never removed.
- `status` pairs each task with its latest launch, open or finished, and derives its state from ledger and worktree only. No launch: `unlaunched`. Latest launch abandoned: `launch-abandoned`. Open launch: `ready-to-submit` (uncommitted changes, or a clean worktree with an unrecorded submit commit), `no-progress`, or `missing-worktree`. Finished launch: `candidate-unintegrated` until an `integrate done` or `abandoned` record exists for its candidate, then `integrated` or `integration-abandoned`. Liveness after a host restart is reported as `unknown`; the orchestrator submits, relaunches into the existing worktree, or abandons.

### AD-10 — Session lock
- Lock file `<session>/.state/lock` holds `{pid, host, at, tool}` and is created exclusively. The lock covers only short critical sections: ledger append with its fold and gate read, and Git ref or worktree mutation (`worktree` actions, delivery). Long work runs outside it: `verify run` executes commands unlocked and locks only to append evidence; `review run` and `ask run` fan out unlocked and lock only to append records. `brief render` reads the gate under the lock and renders outside it. `report complete` checks eligibility under the lock so no record lands mid-check. `status`, `lint`, `doctor`, `ledger query` and `report render` read without it, since fold tolerates a torn tail.
- Acquire waits up to 10 s, then exits 3 naming the holder. A lock from the same host whose `pid` is not alive is stale: the tool breaks it and appends a `note`. A lock from another host is never broken; the orchestrator escalates. Sessions are single-host.

## Risks, Security & Operations

- **Correctness drift without step control:** the orchestrator may skip review or verification. Mitigation: AD-4 eligibility and the `report` completion invariant; AD-3 gates; I08 comparison before release.
- **Ledger tampering or forged attribution (STRIDE: tampering, repudiation, spoofing):** the orchestrator can append a `by:"user"` record — the same trust as the v0.7.3 journal. Mitigation: verbatim quotes and hashes; `report` lists every user-attributed record for audit. Elevation of privilege: provider delegates stay read-only and native writers stay path-scoped.
- **Concurrency:** mutating actions hold the session lock (AD-10); writers work in isolated worktrees; integration and delivery are serial.
- **Partial failure:** AD-2 (ledger), AD-4 (evidence), AD-6 (integration and delivery), AD-7 (writer launch and submit) and AD-10 (stale lock) define each crash boundary.
- **Destructive operations:** `worktree cleanup` removes only worktrees recorded as owned; it reports, and never deletes, unrelated dirty or ignored files.
- **Compatibility:** v0.7.x sessions are not readable after cutover (spec Non-goals); the v0.8.0 release notes state this. Alias names stay.
- **Rollout:** I02 is an intentional behavior change to the legacy driver; it is exercised as the self-build controller for I03–I09 (captured from its commit, DEC-15) and ships only inside v0.8.0. I01 and I03–I06 add no default behavior. I07 routes to the toolkit; I08 measures it on external sample repositories while the legacy engine still exists; I09 deletes the legacy engine.
- **Rollback:** revert I09 to restore legacy files; revert I07 to restore legacy routing and prose; revert I02 to restore v0.7.3 gates.
- **Release:** v0.8.0 is published only after I08 passes and I09 lands, as a user-approved publish step.
- **Operability:** ≤ 1 KB summaries with result paths; `status` is the recovery entry; diagnostics stay opt-in.
- **Portability:** Node type-stripped `.ts`, Node `path` utilities, Git through the existing Git wrapper; no shell-specific syntax.

## Architecture & Boundaries

### Orchestrator (host agent)
- Runs each phase from `SKILL.md` and one phase reference; owns sequencing, rulings, edits to living documents, writer launches and live-writer notification.
- Records a `by:"user"` entry only with a verbatim chat quote.

### Toolkit CLI
- Contract per AD-8; dependency direction `cli → tools → (ledger, domain, policy, providers, lib)`. `domain`, `policy` and `lib` import no tool; `toolkit/` imports nothing from `machines/` or `core/`.

### Ledger (`toolkit/ledger.ts`)
- Sole writer of `ledger.jsonl`; owns validation, append, fold, recovery (AD-2) and `gate` (AD-3).
- Invariants: `seq` strictly increases; keys are unique; user-only kinds (`approval`, `waiver`, `manual-complete`, `level` at `xhigh`/`max`) require `by:"user"` and a quote.

### Lint and doctor
- `lint` returns the parsed artifact with parse-critical `errors` (REQ-6) and `warnings`.
- `doctor` per AD-8.

### Status
- Prints ≤ 1 KB: level, approval and chain state, open escalations, open writers with their AD-9 state, integrations without `done` or `delivered`, criteria lacking eligible evidence.

### Verify, worktree and brief
- `verify` per AD-4; `worktree` actions per AD-6, AD-7 and AD-9 under AD-10; `brief` renders spec, task, criteria and quality-bar sections, calls `gate` first, and instructs TDD plus a short result report (REQ-5).

### Ask and review
- Calls the `gate` level check before fan-out, so `xhigh`/`max` need a user `level` record (REQ-9). Fan-out to the level's roster with fallback and quotas; clustered findings file; reports round versus cap and recurring findings; rulings are `ruling` records.
- RED signal (REQ-5): `review run --kind code` checks each reviewed task's criteria that declare a RED test against the writer's submitted diff and report; a criterion with no failing-first test evidence yields a `missing-red` finding, and a recurrence for the same task yields an escalation. Admission (`brief`, `submit`, `integrate`) never refuses for missing RED.

### Report
- Walkthrough and optional diagnostics from the ledger fold and result files; lists edits as deviations and every user-attributed record; `report complete` requires every criterion `verified`, `manual` or `waived` (AD-4) and a `delivered` record for the current integration HEAD (AD-6).

## Increment Dependency Graph
| ID | Priority | Summary | Prerequisites | Paths |
| --- | ---: | --- | --- | --- |
| I01 | 1 | Baseline measurement on v0.7.3 | none | docs/evaluations/ |
| I02 | 2 | Loosen non-intent gates in current driver | none | skills/dispatch/scripts/machines/, skills/dispatch/scripts/domain/, skills/dispatch/references/, tests/ |
| I03 | 3 | Toolkit foundation: CLI, ledger, lint, doctor, status | I02 | skills/dispatch/scripts/toolkit/, tests/unit/toolkit/ |
| I04 | 4 | verify, worktree, brief tools | I03 | skills/dispatch/scripts/toolkit/, skills/dispatch/references/templates/, tests/unit/toolkit/, tests/e2e/ |
| I05 | 5 | ask and review fan-out tools | I04 | skills/dispatch/scripts/toolkit/, tests/unit/toolkit/, tests/e2e/ |
| I06 | 6 | report tool | I04, I05 | skills/dispatch/scripts/toolkit/, tests/unit/toolkit/ |
| I07 | 7 | Cutover: CLI routing, prose, aliases | I06 | skills/dispatch/SKILL.md, skills/dispatch/references/, skills/dispatch/scripts/dispatch.ts, skills/dispatch-plan/, skills/dispatch-implement/, skills/dispatch-code-review/, tests/integration/ |
| I08 | 8 | Pre-release comparison gate | I01, I07 | docs/evaluations/ |
| I09 | 9 | Legacy deletion and structural targets | I08 | skills/dispatch/scripts/, skills/dispatch/references/, tests/, docs/decisions/ |

## Increment Details

### I01
- Outcome: a recorded baseline of the v0.7.3 controller on 1–2 representative tasks in external sample repositories (not this repository, so self-build stays on its captured controller per DEC-15).
- Scope: create or select the sample repositories and task definitions that I08 reuses unchanged; run the tasks with diagnostics on; fill the observation table from `docs/dispatch-efficiency-evaluation.md`; record driver TS LOC, decision kinds, state tags and always-loaded prose bytes.
- Non-scope: any skill change.
- Observable behavior: `docs/evaluations/2026-10-dispatch-toolkit-baseline.md` with each field measured with its source or marked `unavailable`.
- Affected contracts: none.
- Validation: every observation-table field is filled.
- Rollback boundary: delete the document.
- Parallel safety: safe beside every increment; it reads the v0.7.3 controller only.

### I02
- Outcome: the legacy driver stops at fewer non-intent gates; its commit becomes the controller for I03–I09.
- Scope: remove the production-write authorization and level-adoption gates while keeping user selection of `xhigh`/`max` at invocation; make RED and `CHECK` envelope rows and non-parse plan/design lint defects warnings; update affected prose and tests. Limit changes to deletions and severity changes; add no driver states, because I09 deletes this code.
- Non-scope: living-document pivots, quiescence, receipts, hashing.
- Observable behavior: after plan approval an implement run reaches writer launch with no further user frame; an envelope without RED rows is admitted with a warning; an `xhigh` run still requires explicit user selection.
- Affected contracts: implement decision kinds `approval` (production) and `level-recommendation` removed; envelope admission.
- Validation: affected machine and e2e tests updated and passing; `npm test` green.
- Rollback boundary: revert I02; restores v0.7.3 gates.
- Parallel safety: safe beside I01; prerequisite of I03 because I03 onward use its controller.

### I03
- Outcome: `ledger`, `lint`, `doctor` and `status` usable from `scripts/toolkit/cli.ts`.
- Scope: CLI contract and output helper (AD-8); session lock (AD-10); ledger records, append, fold, torn-tail recovery and idempotency keys (AD-2); approval tuples with artifact paths, `edit` records and `gate` (AD-3); toolkit lint severity mapping; `doctor`; `status` without the writer section; central byte-cap test table.
- Non-scope: other tools; prose; legacy files (AD-5).
- Observable behavior: a user-only kind without `by:"user"` and quote is rejected; `gate` allows a non-intent chain and refuses each named reason; a torn final line is quarantined on the next append; a duplicate key appends nothing; unknown kinds or phases, including malformed `deliver-started` and `delivered` data, are rejected; `ledger query --kind integrate` returns delivery records; a duplicate key with identical data deduplicates and with different data faults.
- Affected contracts: new CLI; `ledger.jsonl` format.
- Validation: unit tests for validation, fold, query, every gate outcome at `low`/`medium`/`xhigh` including a reverting edit chain and pre-approval edits ignored after re-approval, lock wait and exit 3, stale same-host lock break, foreign-host lock refusal, `bind` replacement and artifact lookup with and without approval, the toolkit import-graph check (AD-5), torn-tail and non-final corruption, duplicate keys, user-only `waiver`/`manual-complete` rejecting `by:"orchestrator"`, lint severity, exit codes, and the byte cap for `ledger`, `lint`, `doctor`, `status`.
- Rollback boundary: delete `scripts/toolkit/`.
- Parallel safety: safe beside I01.

### I04
- Outcome: tasks can be briefed, written in worktrees, integrated and verified through tools.
- Scope: `verify` (AD-4), all `worktree` actions including the integration worktree, `submit` and `deliver` (AD-6, AD-7, AD-9), `brief` with gate call; outcome-based writer brief template; `writer` records; `status` writer and integration sections.
- Non-scope: review fan-out.
- Observable behavior: `brief` exits 4 without a valid chain at medium+; `submit` commits in-scope writer changes and refuses out-of-scope paths; `create` refuses a duplicate open launch and `--relaunch` reuses the worktree; an abandoned launch allows relaunch; `integrate` reports conflicts as data; a rerun after a crash at each AD-6 phase, including between deliver fast-forward and its record, converges without repeating effects; evidence from before an integration or fix, from a dirty integration checkout, or missing an untracked file is not eligible; a tree-mutating check yields `mutated`; a changed task section or an `edit` listing the task yields `stale` unless acknowledged, while an `edit` listing no task does not; `deliver` refuses a moved or dirty caller, including a caller edit made concurrently; `cleanup` removes the integration and writer worktrees it owns and ignores unowned ones.
- Affected contracts: brief template; `writer`, `integrate`, `evidence` records.
- Validation: unit tests for each AD-4, AD-6, AD-7, AD-9 and AD-10 case; e2e on a temp Git repository: fresh session → create (opens integration worktree) → brief → write → submit → integrate → verify → fix → `worktree commit` → re-verify (eligible) → deliver, plus kill-during-deliver, deliver A → fix B → deliver B, relaunch-into-existing-worktree, writer abandon then relaunch, conflict abort, close-without-delivery then cleanup, verify running while a `worktree` action succeeds, a gate break followed by refused `brief` and `integrate` reruns, a crash between submit commit and `finished` append then retry, submit on a clean tree refused `no-changes`, relaunch keeping uncommitted changes, cleanup refusing an active writer and an integration worktree with an undelivered fix, unrelated caller movement refused `caller-moved`, a concurrent caller edit under delivery paths refused `caller-dirty` (each asserting exit 4 and its reason), a crash after a submit commit followed by a refused `--relaunch` (`submit-pending`), cleanup refusing the integration worktree while another writer is open, discard then cleanup, stale candidate integrated with `--ack-stale` (exit 0, `ruling` record with rationale, then eligible verification), out-of-scope submit refused without a commit, crash after a submit commit followed by a refused `abandon` (`submit-pending`), a second `create` refused while a candidate is pending (`candidate-pending`), a launch after abandon using a fresh `<task>-<launch>` path, stale candidate rejected by `abort` then relaunched from the current integration HEAD with its old commit still reachable, a `verify run` before any writer opening the integration worktree, a `brief` gate read concurrent with an `edit` append, and a `low` session with `bind` but no approval through brief → submit → integrate → verify → deliver; byte cap for `verify`, `worktree`, `brief`.
- Rollback boundary: remove these modules and the new template.
- Parallel safety: logically independent of I05 but both update `skills/dispatch/skill-hashes.json`; run serially.

### I05
- Outcome: `ask` and `review` fan out to providers and return a findings path.
- Scope: provider runner, roster, rounds, quota and cascade behind the tools (AD-5 reuse); clustered findings file; round and recurrence reporting; `ruling` records; level selectors.
- Non-scope: provider CLI behavior.
- Observable behavior: `review` prints round/cap and finding counts within 1 KB; a finding recurring after an accepted fix is flagged for escalation; a code review of a task without failing-first test evidence yields a `missing-red` finding while that task's brief, submit and integrate still succeed.
- Affected contracts: findings file format; `ruling` records.
- Validation: unit tests with fake providers, including refusal at `xhigh` without a user `level` record and a no-RED fixture producing `missing-red`; byte cap for `ask` and `review` with a large findings fixture.
- Rollback boundary: remove these modules.
- Parallel safety: follows I04 to serialize `skill-hashes.json` regeneration.

### I06
- Outcome: walkthrough and diagnostics rendered from the ledger.
- Scope: `report` with AD-4 eligibility, deviation listing and user-attributed record listing; diagnostics from result files.
- Non-scope: diagnostics content redesign.
- Observable behavior: `report complete` fails when any criterion is not `verified`, `manual` or `waived`, or no `delivered` record matches the current integration HEAD; the walkthrough lists the three statuses separately.
- Affected contracts: walkthrough template.
- Validation: unit tests for eligibility after integration and after a fix, user waiver, user manual completion, rejection of orchestrator-attributed manual completion, missing delivery, deliver A → integrate and verify fix B → `complete` refused, then deliver B → `complete` succeeds, a `low` session with `bind` but no approval through `report complete`, and rendering; byte cap for `report`.
- Rollback boundary: remove the module.
- Parallel safety: requires I04 and I05.

### I07
- Outcome: dispatch runs on the toolkit; the legacy engine is present but unreachable.
- Scope: route `scripts/dispatch.ts` to the toolkit CLI; rewrite `SKILL.md` (≤ 4 KB) and one reference per phase, keeping `decision-frame.md` and `review-rules.md` canonical; point aliases at the new contract; trim `self-build.md` to the fixed-controller essentials using toolkit `doctor`; update integration contract tests; delete or port every e2e and integration test that drives the legacy host protocol through `scripts/dispatch.ts` (legacy machine unit tests that import modules directly stay until I09).
- Non-scope: deleting legacy code (I09); provider behavior; quality bar content.
- Observable behavior: a full plan → implement → review run completes through toolkit tools only; no remaining test spawns `scripts/dispatch.ts` expecting legacy frames.
- Affected contracts: host protocol (breaking).
- Validation: e2e full-run test; skill-contract and layout tests; `npm test` green.
- Rollback boundary: revert I07; legacy routing and prose return.
- Parallel safety: unsafe beside every other increment.

### I08
- Outcome: REQ-11 comparison decided before legacy deletion and release.
- Scope: rerun the I01 tasks in the same external sample repositories with the I07 toolkit as controller under identical models and settings; fill the observation table; compare per the evaluation protocol.
- Non-scope: publishing; legacy deletion.
- Observable behavior: `docs/evaluations/2026-10-dispatch-toolkit-comparison.md` states pass or fail against REQ-11 with sources and confounders; an `unavailable` field never counts as a pass.
- Affected contracts: none.
- Validation: pass requires correctness no worse and host tokens per verified task not higher with comparable coverage. On failure, delivery acceptance stays open and the legacy engine stays available: the orchestrator proposes remediation increments through design revision, or escalates the trade-off to the user; a successful comparable rerun is required before REQ-11 is claimed.
- Rollback boundary: delete the document.
- Parallel safety: requires I01 and I07.

### I09
- Outcome: legacy machines and mechanics prose are gone; structural targets hold.
- Scope: delete `machines/`, legacy `core/` engine files, unused `effects/` and their tests; delete `change-handling.md`, mechanics sections of `spec-stage.md` and `verbs/implement.md`; make toolkit copies canonical (AD-5); regenerate `skill-hashes.json`; ADR superseding ADR 0006 engine decisions; v0.8.0 release notes draft.
- Non-scope: behavior changes.
- Observable behavior: no shipped file imports a deleted module.
- Affected contracts: none beyond I07.
- Validation: `npm test`; structural checks — driver TS LOC ≤ 9.6k, decision kinds ≤ 12, `SKILL.md` ≤ 4 KB, no user gate between approval and report other than waivers, manual completion and escalations.
- Rollback boundary: revert I09; legacy files return unreachable.
- Parallel safety: requires I08; unsafe beside every other increment.

## Final Integration
- `npm test` green after I09.
- One end-to-end session on a sample repository: spec and plan approval → two parallel writers → plan edit mid-run (non-intent, chain holds) → integrate → verify → review fix → re-verify → deliver → `report complete`, using tool calls only.
- I08 comparison passes and I09 structural targets hold; only then is v0.8.0 published, as a user-approved step.

## Review Findings & Resolutions

Reviews: 2 · Rounds: 9 · Findings: 92 (Accepted 23, Fixed 67, Rejected 1, Duplicate 1) · Full log: [design-ordered-increments-for-the-dispat.review-log.md](design-ordered-increments-for-the-dispat.review-log.md)

| Review | ID | Round | Severity | Status | Ruling |
| --- | --- | --- | --- | --- | --- |
| 1 | R1-F001 | 1 | MUST | Accepted | — |
| 1 | R1-F002 | 1 | MUST | Accepted | — |
| 1 | R1-F003 | 1 | MUST | Accepted | — |
| 1 | R1-F004 | 1 | SHOULD | Accepted | — |
| 1 | R1-F005 | 1 | SHOULD | Accepted | — |
| 1 | R1-F006 | 1 | MUST | Accepted | — |
| 1 | R1-F007 | 1 | MUST | Accepted | — |
| 1 | R1-F008 | 1 | MUST | Accepted | — |
| 1 | R1-F009 | 1 | MUST | Accepted | — |
| 1 | R1-F010 | 1 | SHOULD | Accepted | — |
| 1 | R1-F011 | 1 | SHOULD | Accepted | — |
| 1 | R1-F012 | 1 | SHOULD | Accepted | — |
| 1 | R1-F013 | 1 | SHOULD | Accepted | — |
| 1 | R1-F014 | 1 | CONSIDER | Accepted | — |
| 1 | R1-F015 | 1 | MUST | Accepted | — |
| 1 | R1-F016 | 1 | MUST | Accepted | — |
| 1 | R1-F017 | 1 | MUST | Accepted | — |
| 1 | R1-F018 | 1 | MUST | Accepted | — |
| 1 | R1-F019 | 1 | SHOULD | Accepted | — |
| 1 | R1-F020 | 1 | SHOULD | Accepted | — |
| 1 | R1-F021 | 1 | SHOULD | Accepted | — |
| 1 | R1-F022 | 1 | SHOULD | Accepted | — |
| 1 | R1-F023 | 1 | SHOULD | Accepted | — |
| 2 | R1-F001 | 1 | MUST | Fixed | orchestrator: DEC-15: only external sample repositories are compared; self-buil… |
| 2 | R1-F002 | 1 | MUST | Fixed | — |
| 2 | R1-F003 | 1 | SHOULD | Fixed | — |
| 2 | R1-F004 | 1 | SHOULD | Fixed | — |
| 2 | R1-F005 | 1 | MUST | Fixed | — |
| 2 | R1-F006 | 1 | MUST | Fixed | orchestrator: REQ-4: no global quiescence; staleness must be task-scoped. |
| 2 | R1-F007 | 1 | MUST | Fixed | — |
| 2 | R1-F008 | 1 | SHOULD | Rejected | orchestrator: REQ-1 lists required operations, not an exhaustive set; doctor re… |
| 2 | R1-F009 | 1 | SHOULD | Fixed | orchestrator: REQ-1 requires ledger record and query. |
| 2 | R1-F010 | 1 | SHOULD | Fixed | — |
| 2 | R1-F011 | 1 | SHOULD | Fixed | — |
| 2 | R1-F012 | 1 | CONSIDER | Fixed | — |
| 2 | R1-F013 | 1 | MUST | Fixed | orchestrator: REQ-9/DEC-12: xhigh/max need user selection on every fan-out path. |
| 2 | R1-F014 | 1 | SHOULD | Fixed | — |
| 2 | R1-F015 | 1 | SHOULD | Fixed | — |
| 2 | R1-F016 | 1 | SHOULD | Fixed | — |
| 2 | R1-F017 | 1 | SHOULD | Fixed | — |
| 2 | R1-F018 | 1 | SHOULD | Fixed | — |
| 2 | R2-F001 | 2 | MUST | Fixed | — |
| 2 | R2-F002 | 2 | SHOULD | Fixed | — |
| 2 | R2-F003 | 2 | MUST | Fixed | — |
| 2 | R2-F004 | 2 | MUST | Fixed | — |
| 2 | R2-F005 | 2 | MUST | Fixed | — |
| 2 | R2-F006 | 2 | MUST | Fixed | — |
| 2 | R2-F007 | 2 | MUST | Fixed | — |
| 2 | R2-F008 | 2 | SHOULD | Fixed | — |
| 2 | R2-F009 | 2 | SHOULD | Fixed | — |
| 2 | R2-F010 | 2 | SHOULD | Fixed | user: Accept |
| 2 | R2-F011 | 2 | SHOULD | Fixed | — |
| 2 | R2-F012 | 2 | SHOULD | Fixed | — |
| 2 | R2-F013 | 2 | SHOULD | Fixed | — |
| 2 | R3-F001 | 3 | MUST | Fixed | — |
| 2 | R3-F002 | 3 | MUST | Fixed | user: Accept |
| 2 | R3-F003 | 3 | SHOULD | Fixed | — |
| 2 | R3-F004 | 3 | MUST | Fixed | — |
| 2 | R3-F005 | 3 | MUST | Fixed | — |
| 2 | R3-F006 | 3 | SHOULD | Fixed | — |
| 2 | R3-F007 | 3 | SHOULD | Fixed | — |
| 2 | R3-F008 | 3 | CONSIDER | Fixed | — |
| 2 | R3-F009 | 3 | MUST | Fixed | user: Accept |
| 2 | R3-F010 | 3 | MUST | Fixed | — |
| 2 | R3-F011 | 3 | SHOULD | Fixed | — |
| 2 | R3-F012 | 3 | SHOULD | Fixed | — |
| 2 | R3-F013 | 3 | SHOULD | Fixed | — |
| 2 | R3-F014 | 3 | SHOULD | Fixed | — |
| 2 | R4-F001 | 4 | SHOULD | Fixed | — |
| 2 | R4-F002 | 4 | SHOULD | Duplicate | — |
| 2 | R4-F003 | 4 | MUST | Fixed | — |
| 2 | R4-F004 | 4 | SHOULD | Fixed | — |
| 2 | R4-F005 | 4 | SHOULD | Fixed | — |
| 2 | R4-F006 | 4 | SHOULD | Fixed | — |
| 2 | R4-F007 | 4 | SHOULD | Fixed | — |
| 2 | R5-F001 | 5 | MUST | Fixed | — |
| 2 | R5-F002 | 5 | SHOULD | Fixed | — |
| 2 | R5-F003 | 5 | SHOULD | Fixed | — |
| 2 | R5-F004 | 5 | SHOULD | Fixed | — |
| 2 | R5-F005 | 5 | SHOULD | Fixed | — |
| 2 | R5-F006 | 5 | SHOULD | Fixed | — |
| 2 | R5-F007 | 5 | SHOULD | Fixed | — |
| 2 | R6-F001 | 6 | MUST | Fixed | — |
| 2 | R6-F002 | 6 | MUST | Fixed | — |
| 2 | R7-F001 | 7 | MUST | Fixed | — |
| 2 | R7-F002 | 7 | SHOULD | Fixed | orchestrator: Removing briefHash enforces approved REQ-1 (no brief hashing); no… |
| 2 | R7-F003 | 7 | SHOULD | Fixed | — |
| 2 | R7-F004 | 7 | CONSIDER | Fixed | — |
| 2 | R7-F005 | 7 | MUST | Fixed | — |
| 2 | R7-F006 | 7 | SHOULD | Fixed | — |
| 2 | R7-F007 | 7 | SHOULD | Fixed | — |
| 2 | R7-F008 | 7 | SHOULD | Fixed | — |
