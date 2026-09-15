# Dispatch provider reference

Use this file after `SKILL.md` routes you to provider-specific mechanics. It is the source for provider routing, isolation, discovery, session recovery, and failure diagnosis; the effective model and membership config remains the selected `config*.jsonc` file.

## Shared routing and runtime

### Candidate order

- **Unpinned:** candidates are diversity-sorted: each platform's first candidate runs before any platform's second. The detected orchestrator platform runs after other platforms; candidates matching the orchestrator model run last within that platform.
- **Pinned:** `--provider <key>` removes cross-provider fallback but preserves that provider's candidate order.
- **Overrides:** `-m` or `-e` collapses each resolved platform to one target. An omitted model or effort is left to the provider CLI.
- **Membership:** `--list-platforms` is authoritative. Do not infer dispatchable platforms from `config.default.jsonc` when an override file exists.

### Provider summary

| Provider | Key | Direct runner | Read-only invocation | Session handle |
|----------|-----|---------------|----------------------|----------------|
| Claude Code | `claude` | `scripts/claude-run.mjs` | `--permission-mode plan`; native Bash sandbox enabled | `claude --resume <session_id>` |
| Antigravity 2.0 | `agy` | `scripts/agy-run.mjs` | `--mode plan`; headless read tools auto-approved | `conversation://<conversation-id>` |
| GitHub Copilot | `copilot` | `scripts/copilot-run.mjs` | `--mode plan`; experimental command sandbox enabled | `copilot --resume <session_id>` |
| OpenCode | `opencode` | `scripts/opencode-run.mjs` | `run --auto --pure`; Linux may add Bubblewrap | Endpoint URL or `opencode:<provider>/<model>` |

All runners strip credentials from the delegate environment, apply the shared sensitive-file prompt guardrail, enforce provider-specific read-only controls, and write session logs under OS temp. These checks are defense in depth, not a complete secret boundary.

## Claude Code

- **Discovery:** CLI -> Desktop -> VS Code extension. Select one with `--claude-mode`/`--mode`; probe all modes with `--test-modes` (aliases: `--probe-modes`, `--reachability`). The probe prints the resolved executable path.
- **Read-only layers:** `--permission-mode plan` plus the read-tool allowlist and explicit write-tool denylist.
- **Native sandbox:** enabled by default through `--settings {"sandbox":{"enabled":true}}`. Set `platforms.claude.sandbox` to `false` or pass `--no-sandbox` only when compatibility requires it. The sandbox uses Seatbelt on macOS and Bubblewrap plus its network helper on Linux/WSL2; managed settings can override a local opt-out.
- **Compatibility:** only the `enabled` setting is forced; `allowUnsandboxedCommands` and `failIfUnavailable` are not forced. A rejected or unavailable setting is `sandbox-unsupported`, returns a non-zero result, and never silently retries unsandboxed.
- **Recovery:** the JSON envelope supplies the session id; resume with `claude --resume <session_id>`. Logs are in OS temp.

## Antigravity 2.0

- **Discovery:** Antigravity CLI -> Antigravity 2.0 Desktop -> Antigravity VS Code extension. Select one with `--agy-mode`/`--mode-variant`; probe with `--test-reachability` or `--test-modes`.
- **Invocation:** headless `--print --output-format json --mode plan --dangerously-skip-permissions`. Plan mode is the structural write boundary; the permission flag only auto-approves headless read tools.
- **Mode cascade:** token, subscription, or execution failures move to the next available mode unless the mode is pinned.
- **Recovery:** the JSON envelope supplies `conversation://<conversation-id>`; transcript logs are under the Antigravity brain directory. A brief-file spill is exposed through `--add-dir` because `agy` has no file-attachment flag.

## GitHub Copilot

- **Discovery:** Standalone CLI -> Desktop cache/app -> VS Code extension. Select one with `--copilot-mode`; probe with `--test` (aliases: `--probe`, `--check`, `--test-modes`). The probe prints the resolved executable path.
- **Read-only layers:** `--mode plan` prevents write actions.
- **Command sandbox:** enabled by default with `--experimental --sandbox`. Set `platforms.copilot.sandbox` to `false` or pass `--no-sandbox` when the CLI lacks support or the sandbox blocks required commands. Built-in file edits are not made OS-sandboxed; structural plan mode remains active.
- **Compatibility:** an unsupported sandbox is `sandbox-unsupported`, returns non-zero, and does not silently retry without it. The outer dispatch may choose another provider; a direct runner reports the upgrade/opt-out action.
- **Recovery:** resume with `copilot --resume <session_id>`. Logs are in OS temp. Quota failures may move to the next mode; authentication is returned without repeating the same shared credential check.

## OpenCode

- **Configuration:** reads the locally available `opencode.json`/`opencode.jsonc` precedence chain. Any configured `provider/model` is valid; no configured model leaves model selection to OpenCode. `-a` and `--json` are OpenCode-only dispatch options.
- **Discovery:** OpenCode CLI -> Desktop sidecar -> VS Code extension bundle. There is no token-free remote API probe; use `--help` and the session log to diagnose binary/config resolution.
- **Local endpoint:** a loopback endpoint gets a fast `/models` preflight, a GPU concurrency lock, and proxy trapping that permits the local backend while blocking WAN. Linux uses Bubblewrap when available to mount the project and attachments read-only while keeping OpenCode state writable.
- **Remote endpoint:** skips the live preflight and WAN trap so the provider can reach its service. Put provider credentials in `opencode.jsonc` (`provider.<name>.options.apiKey`); ambient cloud keys are stripped.
- **Recovery:** the session handle is the resolved endpoint URL or `opencode:<provider>/<model>`. Logs are in OS temp. `SERVER_OFFLINE`, `CONTEXT_BUDGET_EXCEEDED`, model-load, quota, and timeout diagnostics are returned to the outer cascade.

## Orchestrator detection

Unpinned dispatch detects the host platform and puts it after alternative platforms. On the detected platform, the active model is demoted behind alternatives. `--orchestrator` and `--orchestrator-model` override detection.

| Host | Platform markers | Model markers |
|------|------------------|---------------|
| Antigravity | `ANTIGRAVITY_AGENT`, `ANTIGRAVITY_CONVERSATION_ID`, `ANTIGRAVITY_SESSION_ID`, `GEMINI_CLI` | `ANTIGRAVITY_MODEL`, `GEMINI_MODEL` |
| Claude Code | `CLAUDECODE`, `CLAUDE_CODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT` | `CLAUDE_MODEL`, `ANTHROPIC_MODEL` |
| Copilot CLI | `COPILOT_AGENT`, `COPILOT_CLI_SESSION_ID` | `COPILOT_MODEL`, `GITHUB_COPILOT_MODEL` |
| OpenCode | `OPENCODE_PORT`, `OPENCODE_AGENT` | `OPENCODE_MODEL` |

`VSCODE_PID` is ignored because it is present in ordinary VS Code terminals.

## Failure classification

The outer cascade treats a non-zero result, empty output, or thrown runner error as a candidate failure. Pinned runs stop after their provider's candidates are exhausted; unpinned runs continue to the next candidate.

| Kind | Typical signal | Dispatch response |
|------|----------------|-------------------|
| `quota` | Usage/rate limit, credit balance, HTTP 429 | Cascade to the next candidate. |
| `context-overflow` | Prompt or context length exceeded | Cascade; otherwise narrow the brief. |
| `auth` | 401/403, missing login, invalid key | Report the non-retryable provider error; outer unpinned cascade may continue. |
| `model-not-loaded` | Local backend reports no loaded model | Cascade to another configured target. |
| `sandbox-unsupported` | Provider rejects requested sandbox flags/settings | Fail closed; upgrade or set the provider sandbox option to `false`. |
| `not-found` | Missing or unlaunchable binary | Cascade or inspect the provider probe. |
| `timeout` / `buffer` | Time limit or output cap | Preserve partial output; use it when sufficient. |
| `empty-output` | Exit 0 with no response text | Treat as failure and cascade. |

## Hash verification and diagnosis

- `INTEGRITY_VIOLATION` means the skill hash manifest rejected a modified skill file; stop rather than dispatching.
- `CLI_NOT_FOUND`, `SERVER_OFFLINE`, and `CONTEXT_BUDGET_EXCEEDED` are runner diagnostics. Read the banner's log path, then run the affected runner with `--help` or its documented probe before changing config.
