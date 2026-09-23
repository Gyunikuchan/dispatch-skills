# dispatch maintainer notes

`dispatch` owns the shipped runner and every workflow phase. Its SKILL contract stays lean; branch rules belong in driver actions or disclosed references.

## Sources of truth

- `scripts/dispatch.mjs --help`: invocation and flags.
- `references/glossary.md`: shipped terminology.
- `references/review.md`: adjudication, settlement, checkpoint, and walkthrough rules.
- `references/verbs/implement.md`: ledger, evidence, RED, write-subagent, and recovery rules.
- `references/verbs/design.md`: approval, increments, amendments, and integration.
- `config.sample.jsonc`: `read-delegates`, `write-subagents`, and `phases` schema.

The driver emits one versioned JSON action. Run state is an OS-temp cache in the session directory (`session-temp.mjs`): the first driver or runner process opens `<tmp>/dispatch-skills-<user>/sessions/<id>/`, exports it as `DISPATCH_SESSION_DIR`, and host-run argv carries `--session-dir` because each host command starts a fresh shell. Every per-run temp file (state, briefs, verify logs, prompts, slot dirs, invocation state) is created there; cross-session stores (ledgers, baseline cache, telemetry, metadata locks) stay one level up, and the opencode GPU lock stays machine-global by design. `npm test` preloads `tests/setup/isolated-temp.mjs`, pointing the OS temp at one removable directory per test run.

Verify gates are driver-run (`driver/verify-run.mjs`, `test-failures.mjs`): the host runs the emitted argv; judged verify/review criteria still return `criterionEvidence`. Review `--fix` cluster verification stays host-run because its commands come from delegates, not the approved plan. RED narrows an aggregate `npm test` to `node --test` over red test files only when every suite option is `--flag=value`. Write briefs are sha256-bound files (`promptPath`); prior findings are digested by `findingDigest`. Task-start snapshots store Git blob IDs, not base64 content. `retry` is the in-segment amend: it spends the ledger's next attempt and never changes the governing hash.

Artifacts, resolution logs, ledger events, checkpoints, and Git state are recovery authorities. `ask` remains the direct runner path. Keep delegate transport read-only and production writes approval-gated.

Each terminal wave slot prints `{slot,platform,status,exit,session,output}`. Successful `output` paths are owner-only (0600) files in one `dispatch-slots-*` directory inside the session; the caller reads and removes that directory, never the runner. A numeric `--pins` above configured breadth clamps to available targets with a diagnostic.

Aliases contain mapping plus the named missing-dependency diagnostic only. Tests should assert these public shapes and executable behavior rather than retired prose choreography.
