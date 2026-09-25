# Dispatch provider reference

Read this reference before choosing a provider-specific mode, sandbox override, binary probe,
session-resume command, or failure fallback. The selected `config*.jsonc` remains authoritative for
membership and effective model/effort; this file defines provider mechanics and diagnostics.

## Routing and shared boundaries

### Candidate order

- **Unpinned:** diversity-sort candidates so every platform's first candidate runs before any
  platform's second. Put the detected orchestrator platform after alternatives; within that
  platform, put candidates matching the orchestrator model last.
- **Pinned:** `--provider <key>` removes cross-provider fallback but preserves that provider's
  candidate order. Review `--pins all` selects every eligible target in policy order; each target
  is an independent voice, and only its own configured model list is a native fallback cascade.
- **Overrides:** `-m` or `-e` collapses each resolved platform to one target. An omitted value is
  left to the provider CLI.
- **Membership:** `--list-platforms` is authoritative: dispatchable platforms are defined solely
  by the active user configuration and are never inferred from `config.sample.jsonc`.

### Shared runner boundary

Every runner strips credentials from the delegate environment, applies the sensitive-file prompt
guardrail, enforces provider-specific read-only controls, and writes logs to the run's OS-temp session directory.
These are defense-in-depth controls, not a complete secret boundary.

## Provider mechanics

### Claude Code

- **Direct runner:** `scripts/runners/claude.mjs`; discovery order is CLI → Desktop → VS Code
  extension. Select with `--claude-mode`/`--mode`; probe all modes with `--test-modes` (aliases:
  `--probe-modes`, `--reachability`). The probe prints the resolved executable path.
- **Structured output:** `dispatch --response-schema-file <path>` validates a bounded JSON Schema
  and passes it to Claude as `--json-schema`. Other providers are unavailable for that invocation.
- **Read-only:** `--permission-mode plan`, a read-tool allowlist, and an explicit write-tool
  denylist.
- **Sandbox:** enabled by default through `--settings {"sandbox":{"enabled":true}}`. Set
  `read-delegates.claude.sandbox` to `false` or pass `--no-sandbox` only for compatibility. macOS uses
  Seatbelt; Linux/WSL2 uses Bubblewrap plus its network helper; managed settings may override a
  local opt-out. Native Windows is unsupported: Claude prints a "Sandbox disabled" advisory, the
  run proceeds unsandboxed, and a successful run emits one `[dispatch] WARNING:` line (use WSL2).
- **Compatibility:** only `enabled` is forced; `allowUnsandboxedCommands` and `failIfUnavailable`
  are not. A rejected setting (`sandbox-unsupported`) reruns the same model once unsandboxed with
  a downgrade warning and `sandboxDowngraded` in structured output.
- **Recovery:** the JSON envelope supplies the session id; resume with
  `claude --resume <session_id>`.

### Antigravity 2.0 (`agy`)

- **Direct runner:** `scripts/runners/agy.mjs`; discovery order is Antigravity CLI → Antigravity 2.0
  Desktop → Antigravity VS Code extension. Select with `--agy-mode`/`--mode-variant`; probe with
  `--test-reachability` or `--test-modes`.
- **Invocation:** headless `--print --output-format json --mode plan --dangerously-skip-permissions`.
  Plan mode is the structural write boundary; the permission flag only auto-approves headless
  read tools.
- **Mode cascade:** token, subscription, or execution failures move to the next available mode
  unless the mode is pinned.
- **Recovery:** the JSON envelope supplies `conversation://<conversation-id>`; transcript logs
  live under the Antigravity brain directory. Because `agy` has no file-attachment flag, expose a
  brief-file spill through `--add-dir`.

### GitHub Copilot (`copilot`)

- **Direct runner:** `scripts/runners/copilot.mjs`; discovery order is Standalone CLI → Desktop
  cache/app → VS Code extension. Select with `--copilot-mode`; probe with `--test` (aliases:
  `--probe`, `--check`, `--test-modes`). The probe prints the resolved executable path.
- **Read-only:** `--mode plan` prevents write actions.
- **Sandbox:** enabled by default with `--experimental --sandbox`. Set
  `read-delegates.copilot.sandbox` to `false` or pass `--no-sandbox` when the CLI lacks support or
  blocks a required command. Built-in file edits are not OS-sandboxed; plan mode remains active.
- **Compatibility:** unsupported sandbox flags (`sandbox-unsupported`) rerun the same model once
  unsandboxed with a downgrade warning. Quota failures may move to the next mode; authentication
  failures are returned without repeating the shared credential check.
- **Recovery:** resume with `copilot --resume <session_id>`.

### OpenCode (`opencode`)

- **Direct runner:** `scripts/runners/opencode.mjs`; discovery order is OpenCode CLI → Desktop
  sidecar → VS Code extension bundle. There is no token-free remote API probe; use `--help` and
  the session log to diagnose binary or config resolution.
- **Requires opencode CLI v2.** Argv is v2-only (`run --auto [--agent] [-m model[#effort]]
  [--format json] -- <prompt>`); `--pure` and `--variant` are never emitted, and there is no v1
  fallback. Reasoning effort folds into the model as `model#effort` rather than a standalone flag; a `Variant unavailable` rejection reruns that model once without effort.
- **Configuration:** read the locally available `opencode.json`/`opencode.jsonc` precedence chain,
  using v2 keys only (opencode v2 migrates v1 config files itself). Any configured
  `provider/model` is valid; with no configured model, let OpenCode select one. `-a` and `--json`
  are OpenCode-only dispatch options.
- **Read-only/local:** a loopback endpoint gets a fast `/models` preflight, a GPU concurrency
  lock, and a proxy trap that permits the local backend while blocking WAN.
- **Sandbox:** effective `read-delegates.opencode.sandbox` (default `true`) wraps the run in Linux
  Bubblewrap, mounting the project and attachments read-only while keeping OpenCode state
  writable. `false` or `--no-sandbox` bypasses Bubblewrap even when installed; `true` without it
  (non-Linux or missing) runs `process-hardened` with a downgrade warning.
- **Remote:** skip the live preflight and WAN trap so the provider can reach its service. Put
  credentials in `opencode.jsonc` (`providers.<name>.settings.apiKey`); ambient cloud keys are
  stripped.
- **Recovery:** the session handle is the resolved endpoint URL or
  `opencode:<provider>/<model>`. `SERVER_OFFLINE`, `CONTEXT_BUDGET_EXCEEDED`, model-load, quota,
  and timeout diagnostics are returned to the outer cascade.

### Codex (`codex`)

- **Direct runner:** `scripts/runners/codex.mjs`; discovery order is standalone CLI → Desktop
  bundle → VS Code extension bundle. Select with `--codex-mode`; inspect token-free reachability
  with `--test-modes` or `--probe`. Only executable CLI bundles qualify as modes.
- **Read-only:** `codex exec --json --sandbox read-only` with approvals disabled. The runner
  parses final assistant messages from JSONL; tool events remain in the OS-temp log. When Codex
  rejects the sandbox, the same target retries once unsandboxed with a warning and
  `sandboxDowngraded` metadata. Explicit `sandbox: false` selects unrestricted execution.
- **Recovery:** the JSONL `thread.started` ID gives `codex exec resume <id>`.
- **Nested hosts:** launching Codex from another Codex task may need host permission to access
  `CODEX_HOME` for CLI state. A denied launch fails and enters the normal target/provider cascade.

## Orchestrator detection

Unpinned dispatch puts the detected host platform after alternatives and demotes its active model
behind other models on that platform. `--orchestrator` and `--orchestrator-model` override
detection.

| Host | Platform markers | Model markers |
|---|---|---|
| Antigravity | `ANTIGRAVITY_AGENT`, `ANTIGRAVITY_CONVERSATION_ID`, `ANTIGRAVITY_SESSION_ID`, `GEMINI_CLI` | `ANTIGRAVITY_MODEL`, `GEMINI_MODEL` |
| Claude Code | `CLAUDECODE`, `CLAUDE_CODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT` | `CLAUDE_MODEL`, `ANTHROPIC_MODEL` |
| Copilot CLI | `COPILOT_AGENT`, `COPILOT_CLI_SESSION_ID` | `COPILOT_MODEL`, `GITHUB_COPILOT_MODEL` |
| OpenCode | `OPENCODE_PORT`, `OPENCODE_AGENT` | `OPENCODE_MODEL` |
| Codex | `CODEX_THREAD_ID`, `CODEX_CLI`, `CODEX_APP_SERVER` | `CODEX_MODEL` |

`VSCODE_PID` is ignored because ordinary VS Code terminals also set it.

## Failure classification

The outer cascade treats a non-zero result, empty output, or thrown runner error as a candidate
failure. Unpinned runs continue to the next candidate; pinned runs stop after that provider's
candidates are exhausted.

| Kind | Typical signal | Dispatch response |
|---|---|---|
| `quota` | Usage/rate limit, credit balance, HTTP 429 | Cascade to the next candidate. |
| `context-overflow` | Prompt or context length exceeded | Cascade; otherwise narrow the brief. |
| `auth` | 401/403, missing login, invalid key | Report the non-retryable provider error; an unpinned run may continue. |
| `model-not-found` | Claude reports a 404 or an unavailable selected model | Cascade to another configured target. |
| `cli-outdated` | Claude reports `claude_code_version_too_old` for the model | Cascade to another configured target; upgrade Claude Code. |
| `model-not-loaded` | Local backend reports no loaded model | Cascade to another configured target. |
| `sandbox-unsupported` | Provider rejects requested sandbox flags/settings | Rerun unsandboxed once; stderr warning plus `sandboxDowngraded`/`warnings` in result and slot output. |
| `not-found` | Missing or unlaunchable binary | Cascade or inspect the provider probe. |
| `timeout` / `buffer` | Time limit or output cap | Preserve partial output; use it when sufficient. |
| `empty-output` | Exit 0 with no response text | Treat as failure and cascade. |

### Native fallback

The driver emits `native-fallback` only for a runner failure on the orchestrator's own platform;
other platforms' failures are recorded with their kind. Configuration, integrity, membership, and
`--no-config` errors are terminal: report the exact diagnostic instead.

1. Pass the closed descriptor (`sourceKey`, `agentType`, `model`, `reasoningEffort`,
   `substitutesFor`, `cascadePosition`, `modelCascade`) unchanged to the host's native read-only
   subagent. Instruct it to read the generated prompt file in full as its authoritative
   instructions, and pass the attachment paths the action names. A host that cannot set reasoning
   effort (Claude Code's Agent tool) reports the configured value and states that limitation. A
   launcher that cannot honour the descriptor replies `failed`; never substitute defaults, re-enter
   `dispatch`, or answer inline.
2. Resolve the configured model against the native catalog or a verified binding in
   `native-model-mappings.json`. For a provider-qualified launcher ID, report `actual.model` and
   `mapping: {configuredModel, launcherModel, provider}`; the driver independently checks the
   binding. Capture the full reply at `outputPath`, or report `failed: {kind, reason}`. Keep the
   configured and actual model IDs distinct in the source record. A CLI quota or auth failure
   does not establish native unavailability.
3. Walk the **model cascade** within this slot: a native quota, unsupported, execution, or
   unverified mapping failure advances its position. A first model mismatch permits correction;
   a repeated mismatch records `availability`. Exhaustion records the source as failed. Empty
   early captures retry post-wave; terminal empty captures are named failures.

The descriptor's `agentType` is read-only by construction. A default subagent is write-capable, so
its read-only boundary is prompt-enforced: instruct it to return claims and evidence only and to
make no file edits.

**Done when:** every emitted `native-fallback` has a reply, and its output sits in the action's
`outputPath` or its reply carries `failed`.

For an orchestrated multi-dispatch review wave, the launch action precomputes same-platform
fallback descriptors at `cascadePosition: 0` (the target's first model). After launch, run
`node dispatch.mjs --slots <slotsPath>` once and inspect the failed slots it prints; start all
matching failures as parallel native fallbacks while the wave continues, then never poll again.
An omitted or empty early capture retries its slot post-wave at position 0; a confirmed mapping
rejection resumes at position 1. A successful early capture is final. Targets without a same-platform
fallback may use ordered reserves instead; use each reserve at most once per wave and record
`<failed target> → <reserve>: <reason>`.

## Integrity and diagnosis

- `INTEGRITY_VIOLATION` means the skill hash manifest rejected a modified skill file; stop rather
  than dispatching.
- For `CLI_NOT_FOUND`, `SERVER_OFFLINE`, or `CONTEXT_BUDGET_EXCEEDED`, read the banner's log path,
  then run the affected runner with `--help` or its documented probe before changing config.
