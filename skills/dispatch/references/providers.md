# Providers

Run `doctor [--level L] [--json]` before diagnosing config, executable discovery, level resolution, target order, phase policies, writers, integrity, or sandbox support. CLI, desktop, and VS Code candidates come from declarative specs; authenticate outside dispatch. Direct single-provider dispatch is `start ask --provider P`.

Provider-specific launch modes, read-only flags, sandbox rules, failure parsing, and resume commands are owned by these implementations:

| Provider | Spec |
|---|---|
| Claude Code | [`claude.ts`](../scripts/providers/claude.ts) |
| Antigravity | [`agy.ts`](../scripts/providers/agy.ts) |
| GitHub Copilot | [`copilot.ts`](../scripts/providers/copilot.ts) |
| OpenCode | [`opencode.ts`](../scripts/providers/opencode.ts) |
| Codex | [`codex.ts`](../scripts/providers/codex.ts) |

Use Doctor for the executable and modes available in the current environment. Configuration is authoritative for model and effort; do not infer a model default from the provider key or an older provider table.

Read delegates use provider-specific controls, credential stripping, sensitive-file guards, bounded output, and timeouts. Sandbox defaults on for supported providers. `sandbox-unsupported` fails the slot; choosing `sandbox: false` in config is the explicit opt-out. For Codex, that opt-out selects `danger-full-access`; `approval_policy="never"` suppresses approval prompts and does not restrict writes. OpenCode uses a verified deny-by-default agent when available, otherwise it can select best-effort `explore`, which may grant shell access; see [agent resolution](../scripts/providers/opencode-runtime.ts). Best-effort agent permissions without OS sandboxing do not establish a structural read-only boundary. Credential and attachment guards remain separate controls; they do not restrict all delegate writes.

Modes and model arrays cascade within one voice; exhausted voices use unused reserves once per wave, then same-platform native fallback, or a named failure. Per-provider resume handles accompany successful captures.

For `native`, preserve each descriptor's `sourceKey`, `agentType`, `model`, `reasoningEffort`, `substitutesFor`, `cascadePosition`, `modelCascade`, prompt/output paths, and attachments. Launch the requested model and effort through the host platform's native subagent surface, passing both explicitly; host runtimes otherwise use their default model. Report what actually launched: `NATIVE_RESULTS` `mapping.launcherModel` and `launcherEffort`, one capture per slot; `WRITE_LAUNCHED` rows `model` and `effort`. The driver rejects missing values and undisclosed differences. When the host cannot launch the configured values, report the actual ones with a `substitution` reason; writer substitutions become user-visible concerns. Capture every listed slot before one `NATIVE_RESULTS` reply; the driver reconciles every target and parses native and CLI reports uniformly.

When a `native` or `write` frame carries `data.diagnostics.attest`, add the listed optional fields to each `NATIVE_RESULTS` slot and each task write receipt (`WRITE_ENVELOPE`, `WRITE_FAILED`, `WRITE_CANCELLED`): `tokens`, the subagent's total tokens, and `durationMs`, its launch-to-result wall time. Both are non-negative integers. Use only values the host runtime reports; omit the rest.

The detached internal worker publishes an exclusive claim before launching slots, then heartbeat, per-slot outcomes, and completion; these recovery files and the launch fence are removed when the run reaches `done`. Recover through `status` and eventless `send`; a live same-host claim reattaches, a dead/stale claim is fenced, and a foreign-host claim faults. See [the contract](../SKILL.md) for the host loop.
