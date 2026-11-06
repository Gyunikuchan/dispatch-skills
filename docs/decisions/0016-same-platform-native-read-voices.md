# ADR 0016: Same-platform read voices run as native subagents

- **Status**: Accepted
- **Date**: 2026-11-05
- **Audience**: Maintainers

## Context

A review or ask voice on the session host's own platform shelled out to that platform's CLI, so the user could not watch it in the host UI. Native reviewers lose the CLI's structural read-only controls: the prompt carries the write boundary instead, and a write-capable agent reading untrusted code has more reach than a sandboxed CLI delegate. A stuck native voice with no failure route would stop a review that passes today.

## Decision

Every read-delegate target whose provider equals the session host is native-first, in targets and reserves, for ask, plan, design and code review. The route comes from current host and config on each launch (`nativeSubagents: false` opts a provider out; `nativeSubagentsOnly` targets keep their native-only behaviour), so a saved roster never carries a stale route across rounds.

The first call returns native descriptors before any CLI launch; the next call runs the CLI wave while native voices run (`cliWave: "pending"`); a later call consumes the replies (`cliWave: "done"` while a native voice is unfinished). A descriptor carries `slot`, `provider`, `promptPath`, `replyPath`, `attempt` (`<slot>#<nonce>`), `cwd` and configured `model`/`effort`, and the orchestrator runs exactly those, trying configured models in order and working in `cwd`. A reported failure, invalid or `BLOCKED:` reply, or host change moves the slot to its CLI cascade from the base prompt, then the reserve, then `failed`. Failure is reported with repeatable `--native-failed '<attempt>=<reason>'`; an explicit report wins over any reply file, which is kept as `.invalid-<n>`.

A round with a native voice compares each review checkout before native launch and after native replies arrive, and reports any difference in `repositoryChanges` without discarding work. The orchestrator inspects each changed path, treats a clean result as unproven for changed in-scope paths, and records an explained change (or a user decision to keep the work) as a `note` with key `repository-changes:<review>:<round>`; an unexplained change stops before delivery or approval.

## Consequences

Host-platform voices are visible in the host UI and run alongside the CLI wave, so reviews that include one do not get slower. Native reviewers stay write-capable by design and write only `replyPath` by prompt rule; the change comparison, not a sandbox, catches any other checkout edit. Providers that must stay on the CLI set `nativeSubagents: false`. Native token usage stays unmeasured in diagnostics.
