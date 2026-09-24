# Implement verb contract

Load this reference for ledger, verification, RED, delegation, and recovery actions. The driver supplies branch-specific detail and schemas.

## Ledger and recovery

Resolve and fold the ledger before trusting completion. Ordinary runs use v1 segments bound to a canonical plan path and governed hash. Design, increment, and integration runs use v2 segments bound to normalized design identity and revision. Malformed tails, identity drift, unsupported events, ownership drift, or unverifiable locks enter reconciliation rather than authorizing work.

Append `run-start` before run events and `run-complete` last. Record approval before ordinary production work, every attempt before its verification, and completion only after non-regression evidence. Increment segments derive approval from their design binding. Nothing may append after a terminal event except a new `run-start`.

Run state is disposable. Resume from canonical artifacts, resolution logs, ledger events, checkpoints, and Git state; a restart ignores walkthrough evidence from an earlier plan revision whose run is no longer live. Preserve working-tree changes on failure. Tail repair, stale-lock breaking, attributable reversion, and replacement baselines require explicit rulings. Handoffs name the exact ledger path and resume command; the ledger is never relocated.

## Verification and RED

Extract approved paths, commands, criterion mappings, and `[GENERATED]` paths from the settled plan. A `verify` action's `argv` makes the driver run, log, and fingerprint every gate command and extract failure identities; never run or parse gate commands yourself. Completion reruns plan generators first. An identical tree reuses its baseline for a day. Reconcile any baseline side effect before approval. A nonzero result is `known red — unchanged` only when it matches the accepted baseline identity; otherwise it is a regression.

Each criterion has one evidence class: `red`, `verify`, or `review`, plus a concrete rationale. Evidence must postdate its last mapped mutation. The RED gate runs only red-mapped commands, narrowing a covering suite to its red test files. Completion runs uncovered commands once (a covering `npm test` carries its file commands' criteria) and maps observable behavior to owning production paths.

When red criteria exist, the tests-only write subagent receives only their manifest, approved test paths, mapped commands, expected failures, and envelope schema. Admit exactly one valid matrix row per red criterion, then the driver observes the expected failure before production work. A baseline-red collision is admitted only for a criterion marked `Pre-existing: yes`. A quality defect, including a test file that fails to load, permits one bounded same-model repair; another defect or an invalid host RED enters failure disposition. No read review gates RED; code review after production covers test quality. With no red criteria, record that the RED gate is not applicable.

Failure disposition preserves and fingerprints the tree, then records one ruling: keep for repair, revert attributable paths, inspect first (a later `--run` resumes it), `re-verify` (rerun evidence on the unchanged tree), `retry` (continue the segment on the next attempt with the ruling as writer context), or — only on a user decision — `manual-complete`, which ledgers who closed it, the reason, per-criterion evidence, host RED evidence, and the repository fingerprint. Caller-dirty, mixed, and drifted paths remain preserved. Only a resolved ruling may close a stable-failure segment.

## Write subagent

A `delegate-write` brief at `promptPath` (sha256 `promptHash`) carries the governing outcome, settled scope, criteria, rules, prior findings, and evidence labelled as evidence; relay the path, not the brief. The write subagent checks its envelope with the brief's `selfCheck` command and returns exactly that typed envelope; the driver validates it, and malformed output consumes the attempt according to the emitted recovery action.

A configured model array is a launch cascade inside one attempt: it advances on a `rejected` reply or a `failed: {kind, reason}` reply (availability, authentication, quota, and the other providers.md failure kinds), with identical brief and effort, and consumes no attempt. Malformed output, verification failure, or defective code from a started subagent follows attempt recovery instead. A partial diff outside the approved scope is restored from the pre-attempt baseline before the next model launches. A finished write that changed other paths asks a per-path `write-scope` ruling; the nearest `skill-hashes.json` above an approved path is auto-approved when it verifies, and production edits from a tests-only write always fail. A terminal kind (`sandbox-unsupported`, `integrity`) or an exhausted cascade ends the run in `done` with `outcome: "failed"` instead of entering failure disposition.

Replacement attempts are root-cause-first and bounded by the driver. Failed delegated work never transfers silently to the host. The host may apply accepted review fixes only through `apply-fixes`; it does not substitute for the implementation write subagent.

## Completion

Implementation completes only when every criterion has delivered behavior, fresh mapped evidence, reconciled ownership, and recorded limitations. Green commands alone are insufficient. After each mutation run the emitted verify action; after accepted fixes re-enter scoped review until settlement or a user ruling at the cap.
