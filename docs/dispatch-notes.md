# dispatch maintainer notes

`dispatch` owns the shipped runner and every workflow phase. Its SKILL contract stays lean; branch rules belong in driver actions or disclosed references.

## Sources of truth

- `scripts/dispatch.mjs --help`: invocation and flags.
- `references/glossary.md`: shipped terminology.
- `references/review.md`: adjudication, settlement, checkpoint, and walkthrough rules.
- `references/verbs/implement.md`: ledger, evidence, RED, write-subagent, and recovery rules.
- `references/verbs/design.md`: approval, increments, amendments, and integration.
- `config.sample.jsonc`: `read-delegates`, `write-subagents`, and `phases` schema.

The driver emits one versioned JSON action. Run state is an OS-temp cache; artifacts, resolution logs, ledger events, checkpoints, and Git state are recovery authorities. `ask` remains the direct runner path. Keep delegate transport read-only and production writes approval-gated.

Each terminal wave slot prints `{slot,platform,status,exit,session,output}`. Successful `output` paths are owner-only (0600) files in one `dispatch-slots-*` OS-temp directory; the caller reads and removes that directory, never the runner. A numeric `--pins` above configured breadth clamps to available targets with a diagnostic.

Aliases contain mapping plus the named missing-dependency diagnostic only. Tests should assert these public shapes and executable behavior rather than retired prose choreography.
