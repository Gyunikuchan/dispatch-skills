# Providers

Use `doctor run` to inspect skill integrity, config validity, selected level and configured writer models. Execution discovers binaries and modes and enforces sandbox support. Authenticate outside Dispatch. Configuration is authoritative for model and reasoning effort; pass each resolved value exactly, including max. A host capability mismatch is a named blocker, not permission to substitute a model.

Provider-specific controls and failure parsing live in [Claude](../scripts/providers/claude.ts), [Antigravity](../scripts/providers/agy.ts), [Copilot](../scripts/providers/copilot.ts), [OpenCode](../scripts/providers/opencode.ts) and [Codex](../scripts/providers/codex.ts).

Read delegates use provider controls, credential stripping, sensitive-file guards, output bounds and timeouts. Supported sandboxes default on. An unsupported sandbox fails the slot; configured sandbox false is an explicit opt-out. Best-effort agent permissions alone do not establish structural read-only access. Config `read-commands` lists host read commands that delegates may run; Claude adds each to its command allowlist. Provider sandboxes differ: Codex's read-only sandbox blocks all writes, but Claude's permits working-directory writes, so a listed command must write at most its own cache or index. Before launching delegates, create or refresh any index those commands query. For OpenCode resolution details see [runtime](../scripts/providers/opencode-runtime.ts).

Configured model and mode combinations cascade on failure; exhausted voices use reserves and native fallback as available. MUST rejection requests retain the original logical source slot through each fallback. The physical responder and explicit reply remain in the result; only assigned requests can establish confirmation. See [rejection confirmation](review-rules.md#rulings-and-fix-scope). One combination's failure does not exhaust all combinations. Preserve actual failure and coverage evidence.

## Native slots

For `native-pending`, read the result's slot descriptors. Launch each configured native slot with its `promptPath`, model, effort and permitted attachments; write its output to `replyPath`, then rerun the same tool call. Keep handles until terminal results. Native explorers follow [grounding's map output rule](grounding.md#publish). Native explorers, reviewers and writers may run host read tools that create or update only the tool's own cache or index, such as a code index, unless a stricter host rule forbids it. Otherwise each keeps its write boundary: explorers write only their map, reviewers edit no repository files, and task writers edit only assigned paths and run no Git write commands. If the host cannot launch the configured slot, report the capability blocker with retained evidence.

## Quota

Quota cooldown applies to the exact provider, model alias/default and launch mode for one hour from its recorded failure bucket. Effort changes share the key; other models and modes remain eligible. Use `session quota-reprobe` for one key under [session commands](toolkit.md#session-commands). Reprobe affects future selection; retain already-issued work and available results.
