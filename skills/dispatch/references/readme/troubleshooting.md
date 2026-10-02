# Troubleshooting

Run `doctor` for Node version, config, integrity, executable discovery, and sandbox diagnostics. Use Node `^22.18 || >=23.6`; unsupported Node versions report their native TypeScript loader error. Authenticate provider CLIs separately and correct actionable config paths in diagnostics.

After interruption run `status --run <dir>`, then eventless `send --run <dir>` to reattach a live detached worker. Exit 3 names a lock holder; wait for its process. Exit 2 prints an engine fault frame; retain the journal and inspect its error. Rejected events use exit 0 with a frame error; correct the event and resend. `send --dry-run --event @reply.json` checks the reply without changing files. See [the contract](../..).
# Diagnostics coverage

Partial reports show the last refresh and open phases. Resume with an ordinary `send` to refresh durable evidence; `status` and dry-run are read-only. Collection warnings, lock contention or malformed diagnostic records preserve workflow outcomes and the last good report. A contended refresh retries only at the next normal boundary.

Unavailable usage is not zero usage. Only fixture-backed Codex/Claude structured counters are supported; text-only providers and native/orchestrator usage remain unavailable. Diagnostic instruction bytes are bounded; attributable token overhead is unavailable. Record/report limits omit detail explicitly while retaining measurable aggregate counters. Review the file before sharing; arbitrary free text, raw logs, paths, credentials, objectives, source and provider session IDs are excluded or withheld.
