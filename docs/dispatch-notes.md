# dispatch maintainer notes

`dispatch` owns the shipped runner and every workflow phase. Its SKILL contract stays lean; branch rules belong in driver actions or disclosed references.

## Sources of truth

- `scripts/dispatch.mjs --help`: invocation and flags.
- `references/glossary.md`: shipped terminology.
- `references/review.md`: adjudication, settlement, checkpoint, and walkthrough rules.
- `references/verbs/design.md`: approval, increments, amendments, and integration.
- `references/verbs/implement.md`: ledger, evidence, RED, write-subagent, and recovery rules.
- `config.sample.jsonc`: `read-delegates`, `write-subagents`, and `phases` schema.

`scripts/lib/session-lifecycle.mjs` and `scripts/session.mjs` own a stable folder per chat. Active roots are `.scratch/dispatch-skills/<folder>/`; canonical artifacts and ledgers are in that root, and `runs/<run-id>/` keeps each invocation separate from the chat ID. `session-temp.mjs` binds or rebinds the root, propagates `--session-dir`, and encodes session paths for driver state, verification results, cache records, and walkthrough evidence. Readers resolve those references at the current root. Terminal handoff moves the complete folder to `<tmp>/dispatch-skills/<folder>/` with verified staging across devices. The existing opencode GPU lock remains machine-global.

Tests preload `tests/helpers/isolated-temp.mjs` to isolate published data and give each worker its own chat ID; a test must never inherit the host chat's identity. Driver fixtures carry one binding through every subprocess and use the state reader for restored paths. Source snapshots exclude `.scratch/dispatch-skills/` before Git hashing, avoiding runtime churn and Git's Windows path-length limit.

Verify gates are driver-run (`driver/verify-run.mjs`, `verification/test-failures.mjs`): the host runs the emitted argv; judged verify/review criteria still return `criterionEvidence`. Review `--fix` cluster verification stays host-run because its commands come from delegates, not the approved plan. RED narrows an aggregate `npm test` to `node --test` over red test files only when every suite option is `--flag=value`. Write briefs are sha256-bound files (`promptPath`); prior findings are digested by `findingDigest`. Task-start snapshots store Git blob IDs, not base64 content. `retry` is the in-segment amend: it spends the ledger's next attempt and never changes the governing hash.

Artifacts, resolution logs, ledger events, checkpoints, and Git state are recovery authorities. Keep delegate transport read-only and production writes approval-gated.

Each terminal wave slot prints `{slot,platform,status,exit,session,output}`. Successful `output` paths are owner-only (0600) files in one `dispatch-slots-*` directory inside the session; the caller reads and removes that directory, never the runner. A numeric `--pins` above configured breadth clamps to available targets with a diagnostic.

Aliases contain mapping plus the named missing-dependency diagnostic only. Tests should assert these public shapes and executable behavior rather than retired prose choreography.

Native fallback (`driver/review-phase.mjs`, `driver/ask-phase.mjs`): the driver resolves a failed target's own `model` array from `state.policy` targets/reserves by `(platform, candidateIndex)` — never from a batch record, whose `model` is `null` for an array candidate — and walks it from index 0; a source whose cascade cannot identify a model is excluded and re-resolved. It rejects missing or mismatched launch metadata, writes source identity, `substitutesFor`, and the fallback reason into the source map, and drops a source once its cascade is exhausted. Generated prompt files and attachments are pruned only after the fallback consumes them or reaches a terminal outcome.

Design amendment activation fsyncs `prepared`, writes deterministic backup and candidate files beside the design, reverifies both hashes, activates atomically, appends `activated`, and removes staging files; startup recovery uses canonical, prior, and candidate hashes to resume, complete activation, or enter reconciliation. Driver-owned persistence appends ledger-global sequence numbers under an exclusive lock with fsync; `verification/implementation-outcome.mjs` validates write-subagent envelopes.
