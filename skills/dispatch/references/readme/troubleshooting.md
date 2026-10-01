# Troubleshooting

Run `doctor` for Node version, config, integrity, executable discovery, and sandbox diagnostics. Use Node `^22.18 || >=23.6`; unsupported Node versions report their native TypeScript loader error. Authenticate provider CLIs separately and correct actionable config paths in diagnostics.

After interruption run `status --run <dir>`, then eventless `send --run <dir>` to reattach a live detached worker. Exit 3 names a lock holder; wait for its process. Exit 2 prints an engine fault frame; retain the journal and inspect its error. Rejected events use exit 0 with a frame error; correct the event and resend. `send --dry-run --event @reply.json` checks the reply without changing files. See [the contract](../..).
