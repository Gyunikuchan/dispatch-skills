# Providers

Use `doctor run` to inspect skill integrity, config validity, selected level and configured writer models. Execution discovers binaries and modes and enforces sandbox support. Authenticate outside Dispatch. Configuration is authoritative for model and reasoning effort; pass each resolved value exactly, including max. A host capability mismatch is a named blocker, not permission to substitute a model.

Provider-specific controls and failure parsing live in [Claude](../scripts/providers/claude.ts), [Antigravity](../scripts/providers/agy.ts), [Copilot](../scripts/providers/copilot.ts), [OpenCode](../scripts/providers/opencode.ts) and [Codex](../scripts/providers/codex.ts).

## OpenCode private launches

Dispatch launches OpenCode runs with `--standalone run` and inspects effective settings with separate `--standalone debug config` and `--standalone debug agents` commands. The same run argument builder serves the CLI, Desktop and VS Code adapter modes. Each command starts a private server and uses the filtered environment passed to that invocation. Settings present only in an already-running managed service are not inherited. Dispatch does not edit global OpenCode settings, stop the shared service or retry an unsupported binary without `--standalone`. Inline `OPENCODE_CONFIG_CONTENT` is refused because Dispatch cannot verify the effective config.

Private startup can repeat server and MCP initialization, add latency and use more concurrent resources; the cost is unmeasured. Standalone separates server lifecycle. It is not a filesystem or security sandbox. Read-only agent checks and environment filtering still apply.

A binary that rejects `--standalone` returns an actionable configuration failure; upgrade to a supported v2 binary. Dispatch never falls back to the shared service. The common argument builder covers all adapter modes, but binary support and descendant shutdown depend on the installed build; argument coverage alone does not prove runtime behavior.

Teardown is bounded. OpenCode runs and inspection use Windows process-tree termination or POSIX process-group termination and check exit evidence. If required exit evidence or the Windows `taskkill` result is not confirmed, Dispatch reports a lifecycle failure; retain the worktree and inspect the reported blocker before cleanup.

Standalone isolates the private CLI/server lifecycle; normal CLI exit does not prove all descendants are gone. Children can detach, escape the owned process group or start through another service. Node-only Windows `taskkill` cannot prove orphan exit after the parent exits; POSIX bounded checks cover only the owned group. Dispatch adds no Job Object, native helper or PowerShell prerequisite. Surviving descendants can still lock a worktree. Use [partial cleanup recovery](worktree-cleanup.md) to retain and report blocked paths; do not kill shared or unrelated services.

## Shared provider controls

Read delegates use provider controls, credential stripping, sensitive-file guards, output bounds and timeouts. Supported sandboxes default on. An unsupported sandbox fails the slot; configured sandbox false is an explicit opt-out. Best-effort agent permissions alone do not establish structural read-only access. Config `read-commands` lists host read commands that delegates may run; Claude and Copilot add each to their command allowlist. Codex (read-only sandbox, no per-command allowlist), Antigravity (no per-command control) and OpenCode (permissions from its read-only agent) do not apply `read-commands`. Provider sandboxes differ: Codex's read-only sandbox blocks all writes, but Claude's permits working-directory writes, so a listed command must write at most its own cache or index, such as a code index. Before launching delegates, create or refresh any index those commands query. For OpenCode resolution details see [runtime](../scripts/providers/opencode-runtime.ts).

Configured model and mode combinations cascade on failure; exhausted voices use reserves and native fallback as available. MUST rejection requests retain the original logical source slot through each fallback. The physical responder and explicit reply remain in the result; only assigned requests can establish confirmation. See [rejection confirmation](review-rules.md#rulings-and-fix-scope). One combination's failure does not exhaust all combinations. Preserve actual failure and coverage evidence.

## Subagent context

Before every new subagent launch, read this section and request a fresh context without parent conversation history through the host's explicit control when available. Apply this to explorers, reviewers, writers, retries, fallbacks, replacements and permitted nested launches. Follow the active host tool contract; do not guess a control or claim isolation when it is unsupported or unverifiable. In those cases, continue with the available launch behavior. Context freshness alone is not a capability blocker or run gate.

Give each new agent a self-contained brief or references to accessible artifacts. Include the objective, governing intent and decisions, constraints, current state, next action and required evidence. Resolve artifact references for the recipient. Include the short launch instruction in each permitted descendant brief so it can act without locating this reference; this section owns the full policy. Keep required reply schemas, configured models and efforts, permissions and review gates unchanged; this section grants no delegation or write authority. Report unsupported or unverifiable freshness once in the existing final handoff or walkthrough, grouped by host and affected roles with the reason.

Treat a continuing agent as the same launch: retain its live handle, task state and completed evidence. Before a replacement launch, reconcile the prior launch under the existing recovery rules and give the replacement a fresh brief with the current task state and evidence. Do not replace or duplicate work only to obtain fresh context.

## Native slots

For `native-pending`, read the result's slot descriptors. Launch each configured native slot with its `promptPath`, model, effort and permitted attachments; write its output to `replyPath`, then rerun the same tool call. Keep handles until terminal results. Native explorers follow [grounding's map output rule](grounding.md#publish). Native explorers, reviewers and writers may run host read tools that create or update only the tool's own cache or index, such as a code index, unless a stricter host rule forbids it. Otherwise each keeps its write boundary: explorers write only their map, reviewers edit no repository files, and task writers edit only assigned paths and run no Git write commands. If the host cannot launch the configured slot, report the capability blocker with retained evidence.

## Quota

Quota cooldown applies to the exact provider, model alias/default and launch mode for one hour from its recorded failure bucket. Effort changes share the key; other models and modes remain eligible. Use `session quota-reprobe` for one key under [session commands](toolkit.md#session-commands). Reprobe affects future selection; retain already-issued work and available results.
