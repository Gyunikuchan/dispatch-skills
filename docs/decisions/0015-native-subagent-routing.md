# ADR 0015: Native subagent and same-platform voice routing

- **Status**: Accepted
- **Date**: 2026-11-04
- **Updated**: 2026-11-23
- **Audience**: Maintainers

## Context

Heavy reading, routine utility work, and multi-increment designs bloat orchestrator context and token spend when executed inline on the lead model. In addition, shelling out to the session host's own CLI for a review or `ask` voice hid the voice from the host UI, whereas running it as a native subagent trades CLI sandbox isolation for prompt-scoped write boundaries that need post-round verification.

## Decision

### Role routing and utility tier

The orchestrator acts as the user's deputy ([ADR 0012](0012-orchestrator-user-deputy.md)) and carries the routing table, context guard, and launch/continuation rules inline in [`SKILL.md`](../../skills/dispatch/SKILL.md#routing) so every branch has them without an extra reference read:

- **Explorer subagents (`utility-subagents`):** Handle research, triage, finding evidence, sweeps, grounding maps ([ADR 0014](0014-ground-first-intent-and-evidence-based-level.md)), and advisory plan/design `brief fix-review-lite` passes.
- **Utility subagents in write mode (`utility-subagents`):** Handle runtime verification (`brief verifier`), post-integration test pruning (`brief test-cleanup`), map corrections exceeding the context-guard threshold, and deterministic mechanical integration fixes. `utility-subagents` (renamed from `explore-subagents`) requires a `context-limit` and never falls back to writer models.
- **Writers (`write-subagents`):** Handle plan tasks and remaining integration review fixes ([ADR 0008](0008-task-based-plans-and-bounded-parallel-writers.md)); may launch research explorers and task-scoped utility subagents.
- **Reviewers and voices:** Read directly and launch no subagents (so cheap-model misses cannot filter into every review voice).
- **Orchestrator:** Retains decisions, rulings, ledger, user gates, spec/plan authoring, submitted-change inspection, `focus` bullets, small map/integration fixes, and terse inline retro note merges.

### Child orchestrators for design increments

Each design increment runs in its own parent-owned session via a child orchestrator where verified (Claude Code via documented model/effort inheritance), or chains sequentially on other hosts ([child orchestrators](../../skills/dispatch/references/providers.md#child-orchestrators)). The child first reports `capability-ready` or `capability-missing` and waits for continuation; the parent retains the design session, user gates, every `by: "user"` record, deviation rulings, and caller commits.

### Same-platform read voices as native subagents

Every review or `ask` voice whose provider equals the session host runs as a native subagent (in primary targets and reserves) with no host-CLI fallback ([native slots](../../skills/dispatch/references/providers.md#native-slots)):

- The first `review run` or `ask run` call returns native slot descriptors (`slot`, `provider`, `promptPath`, `replyPath`, `attempt` `<slot>#<nonce>`, `cwd`, `launchAs`) without launching CLIs. After the orchestrator launches every native slot and retains its handle, an immediate rerun starts the CLI wave in parallel (`cliWave: "pending"`), and a final rerun consumes all replies once complete. Failed or `BLOCKED:` native attempts are reported via `--native-failed '<attempt>=<reason>'` and cascade to reserves, then `failed`.
- Because native voices lack CLI sandboxes and rely on prompt write boundaries (`replyPath` only), rounds with a native voice snapshot and compare each review checkout before launch and after replies arrive, reporting any difference in `repositoryChanges` ([review coverage](../../skills/dispatch/references/review-coverage.md#repository-changes-from-native-voices)).

### Topic-based continuation

Continue a retained subagent when a follow-up depends on material it already read; launch fresh for an unrelated topic. Dispatch defines no cache-TTL clock rule because subagent cache state is unobservable and host TTLs vary. Reviewers never continue across rounds.

## Consequences

Heavy reading and mechanical work move off the lead model, same-platform voices run visibly in the host UI alongside the CLI wave, and checkout comparison guards native voice write boundaries without a host CLI sandbox.
