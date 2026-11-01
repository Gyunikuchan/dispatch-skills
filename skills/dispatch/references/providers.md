# Providers

Use `doctor run` for integrity, config, level and writer models. Execution discovers binaries/modes and enforces sandbox support. Authenticate outside Dispatch. Pass configured model and effort exactly, including max. Report host capability mismatches as blockers; never substitute models.

Provider-specific controls and failure parsing live in [Claude](../scripts/providers/claude.ts), [Antigravity](../scripts/providers/agy.ts), [Copilot](../scripts/providers/copilot.ts), [OpenCode](../scripts/providers/opencode.ts) and [Codex](../scripts/providers/codex.ts).

## Subagent context

Before every new subagent launch, read this section and request a fresh context without parent conversation history through the host's explicit control when available. Apply this to explorers, reviewers, writers, retries, fallbacks, replacements and permitted nested launches. Follow the active host tool contract; do not guess a control or claim isolation when it is unsupported or unverifiable. In those cases, continue with the available launch behavior. Context freshness alone is not a capability blocker or run gate.

Give each new agent a self-contained brief or accessible artifact references: objective, governing intent/decisions, constraints, current state, next action and required evidence. Resolve references for the recipient. Include the short launch instruction in each permitted descendant brief so it can act without locating this reference; this section owns the full policy. Keep required reply schemas, configured models and efforts, permissions and review gates unchanged; this section grants no delegation or write authority. Report unsupported or unverifiable freshness once in the existing final handoff or walkthrough, grouped by host and affected roles with the reason.

Continuation is the same launch: retain its live handle, task state and evidence. Before replacement, reconcile the prior launch under recovery rules and give a fresh brief with current state/evidence. Never replace or duplicate work solely for fresh context.

## Native slots

For `native-pending`, read the result's slot descriptors. Launch each configured native slot on a write-capable agent type with an instruction to read and execute its `promptPath`, write its reply to `replyPath` and reply with the path, using its model, effort and permitted attachments; do not read or paste the prompt body. If the agent cannot read files, read the prompt and pass it inline. When the host has no write-capable agent type, override the prompt's reply channel at launch: require the complete reply inline in the same format. Treat `BLOCKED: <reason>` as a capability or coverage blocker, not a reply body; retain and report it without writing it to `replyPath` or rerunning it as an answer. If a complete reply arrives inline without a file, save it to `replyPath`, whether the host required it or the agent returned it unasked. Rerun the same tool call only after the complete reply is in `replyPath`. Keep handles until terminal results. Native explorers follow [grounding's map output rule](grounding.md#publish). Native explorers, reviewers and writers may run host read tools that create or update only the tool's own cache or index, such as a code index, unless a stricter host rule forbids it. Otherwise each keeps its write boundary: explorers write only their map, reviewers and ask voices write only `replyPath`, and task writers edit only assigned paths and run no Git write commands. If the host cannot launch the configured slot, report the capability blocker with retained evidence.

## Shared provider controls

Read delegates use provider controls, credential stripping, sensitive-file guards, output bounds and timeouts. Supported sandboxes default on. An unsupported sandbox fails the slot; configured sandbox false is an explicit opt-out. Best-effort agent permissions alone do not establish structural read-only access. Config `read-commands` lists host read commands that delegates may run; Claude and Copilot add each to their command allowlist. Codex (read-only sandbox, no per-command allowlist), Antigravity (no per-command control) and OpenCode (permissions from its read-only agent) do not apply `read-commands`. Provider sandboxes differ: Codex's read-only sandbox blocks all writes, but Claude's permits working-directory writes, so a listed command must write at most its own cache or index, such as a code index. Before launching delegates, create or refresh any index those commands query. For OpenCode resolution details see [runtime](../scripts/providers/opencode-runtime.ts).

Configured model and mode combinations cascade on failure; exhausted voices use reserves and native fallback as available. MUST rejection requests retain the original logical source slot through each fallback. The physical responder and explicit reply remain in the result; only assigned requests can establish confirmation. See [rejection confirmation](review-rules.md#rulings-and-fix-scope). One combination's failure does not exhaust all combinations. Preserve actual failure and coverage evidence.

## Quota

Quota cooldown applies to the exact provider, model alias/default and launch mode for one hour from its recorded failure bucket. Effort changes share the key; other models/modes remain eligible. Use `session quota-reprobe` for one key under [session commands](toolkit.md#session-commands). Reprobe affects future selection; retain already-issued work and available results.

## OpenCode private launches

Dispatch launches OpenCode runs with `--standalone run` and inspects effective settings with separate `--standalone debug config` and `--standalone debug agents` commands. The same run argument builder serves the CLI, Desktop and VS Code adapter modes. Each command starts a private server and uses the filtered environment passed to that invocation. Settings present only in an already-running managed service are not inherited. Dispatch does not edit global OpenCode settings, stop the shared service or retry an unsupported binary without `--standalone`. Inline `OPENCODE_CONFIG_CONTENT` is refused because Dispatch cannot verify the effective config.

Private startup can repeat server/MCP initialization, latency and resource use; cost is unmeasured. Standalone separates lifecycle, not filesystem/security isolation. Read-only agent checks and environment filtering still apply.

A binary that rejects `--standalone` returns an actionable configuration failure; upgrade to a supported v2 binary. Dispatch never falls back to the shared service. The common argument builder covers all adapter modes, but binary support and descendant shutdown depend on the installed build; argument coverage alone does not prove runtime behavior.

Teardown is bounded. OpenCode runs and inspection use Windows process-tree termination or POSIX process-group termination and check exit evidence. If required exit evidence or the Windows `taskkill` result is not confirmed, Dispatch reports a lifecycle failure; retain the worktree and inspect the reported blocker before cleanup.

Standalone isolates the private CLI/server lifecycle; normal CLI exit does not prove all descendants are gone. Children can detach, escape the owned process group or start through another service. Node-only Windows `taskkill` cannot prove orphan exit after the parent exits; POSIX bounded checks cover only the owned group. Dispatch adds no Job Object, native helper or PowerShell prerequisite. Surviving descendants can still lock a worktree. Use [partial cleanup recovery](worktree-cleanup.md) to retain and report blocked paths; do not kill shared or unrelated services.
