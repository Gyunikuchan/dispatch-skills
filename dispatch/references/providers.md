# Dispatch Providers Reference

Technical specifications, binary discovery paths, session monitoring mechanics, and sandboxing rules for dispatch providers.

---

## 1. Provider Specifications

| Provider | Key | CLI Binary | Direct Runner | Default Model | Default Effort | Default Mode | Session Handle |
|----------|-----|------------|---------------|---------------|----------------|--------------|----------------|
| **Claude Code** | `claude` | `claude` | `scripts/claude-run.mjs` | `claude-opus-5` | `medium` | Read-only | `claude --resume <session_id>` |
| **Antigravity 2.0** | `agy` | `agy` | `scripts/agy-run.mjs` | `gemini-3.8-flash` | `medium` | `--mode plan` | `conversation://<id>` |
| **GitHub Copilot** | `copilot` | `copilot` | `scripts/copilot-run.mjs` | `gpt-5.6-luna` | `max` | `--mode plan` | `copilot --resume <session_id>` |
| **Local OpenCode** | `local` | `opencode` | `scripts/local-run.mjs` | `lmstudio/qwen3.8-27b-ridge` | `null` (server default) | Read-only | Local server logs |

---

## 2. Claude Code (`claude`)

### Defaults & Overrides
- **Default Model**: `claude-opus-5` (override via `-m <model>`)
- **Default Reasoning Effort**: `medium` (override via `-e <level>`, e.g. `low`, `medium`, `high`, `max`)
- **Default Mode**: Read-only (`--allowedTools`)
- **Mode Override**: `--claude-mode <desktop|vscode|cli>` (explicit execution mode)
- **Reachability Probe**: `--test-modes` (tests reachability via `--version` across all modes without token consumption)

### Order of Preference
1. **Claude Desktop (`desktop`)**:
   - macOS: `~/Library/Application Support/Claude/claude-code/<version>/claude.app/Contents/MacOS/claude`
   - Windows: `%APPDATA%\Claude\claude-code\<version>\claude.exe`, `%LOCALAPPDATA%\Claude\claude-code\...`
   - Linux: `~/.config/Claude/claude-code/<version>/claude`, `~/.local/share/Claude/...`
2. **Claude VS Code Extension (`vscode`)**:
   - Cross-platform: `CLAUDE_CODE_EXECPATH` environment variable
   - Extension scan: `~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude` (`claude.exe` on Windows)
   - Agent-host SDK cache:
     - macOS: `~/Library/Application Support/Code/agent-host/sdk-cache/claude/**/claude`
     - Windows: `%APPDATA%\Code\agent-host\sdk-cache\claude\**\claude.exe`
     - Linux: `~/.config/Code/agent-host/sdk-cache/claude/**/claude`
3. **Claude CLI (`cli`)**:
   - macOS / Linux: `~/.local/bin/claude`, `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`, NVM / global npm, system `$PATH`
   - Windows: `%APPDATA%\npm\claude.cmd`, `%USERPROFILE%\.local\bin\claude.exe`, system `PATH` (`where.exe`)

### Sandboxing & Isolation
- **Tool Restriction**: Passed `--allowedTools` restricts tool types (`Read`, `Bash(grep *)`, `Bash(find *)`), not individual filesystem paths.
- **Safety Prompt**: Restricts denied directories (`.ssh/`, `.aws/`, `.gnupg/`, `.docker/`, `.kube/`, `.password-store/`) and denied file patterns (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `*token*`, `*secret*`).
- **Sandbox Boundary**: Delegate session inherits the host process sandbox boundaries.
- **Mode Cascade**: Discovery probes test `--version` without token spend. On `auth` or `quota` failure, `runClaude` cascades to the next available mode unless pinned.

### Session Monitoring
- **Resume Command**: Captured `session_id` from JSON envelope (`--output-format json`) emits `claude --resume <session_id>`.
- **Error Classification**: JSON envelope exposes `is_error` and `subtype` (e.g. `error_max_turns`) for cascade routing.
- **Session History**: Stored in `~/.claude/projects/`; resumable in terminal or IDE tabs.

---

## 3. Antigravity 2.0 (`agy`)

### Defaults & Overrides
- **Default Model**: `gemini-3.8-flash` (override via `-m <model>`)
- **Default Reasoning Effort**: `medium` (override via `-e <level>`, e.g. `low`, `medium`, `high`)
- **Default Mode**: `--mode plan` (structural read-only)
- **Mode Override**: `--agy-mode <antigravity-2.0|antigravity-vscode|antigravity-cli|auto>`
- **Reachability Probe**: `--test-reachability` (tests reachability across all modes without token consumption)

### Order of Preference
1. **Antigravity Desktop (`desktop`)**:
   - macOS: `~/.gemini/antigravity/bin/agy`, `/Applications/Antigravity.app/Contents/Resources/bin/agy`
   - Windows: `%LOCALAPPDATA%\Google\Antigravity\bin\agy.exe`, `%APPDATA%\Google\Antigravity\bin\agy.exe`, `%ProgramFiles%\Antigravity\bin\agy.exe`
   - Linux: `~/.gemini/antigravity/bin/agy`, `/opt/Antigravity/agy`
2. **Antigravity VS Code Extension (`vscode`)**:
   - macOS: `~/.gemini/antigravity-ide/bin/agy`, `~/Library/Application Support/Code/User/globalStorage/google.google-antigravity/bin/agy`
   - Windows: `%APPDATA%\Code\User\globalStorage\google.google-antigravity\bin\agy.exe`
   - Linux: `~/.gemini/antigravity-ide/bin/agy`, `~/.config/Code/User/globalStorage/google.google-antigravity/bin/agy`
3. **Antigravity CLI (`cli`)**:
   - Cross-platform: `~/.gemini/bin/agy`, `~/.local/bin/agy`, system `$PATH`

### Sandboxing & Isolation
- **Structural Read-Only**: Enforced via `--mode plan`. Edits are blocked at the runtime level.
- **Claude Code Sandbox Constraint**: Antigravity binds a local TCP socket for its language server, conflicting with Claude Code's Bash tool sandbox (`bind: operation not permitted`). Runs pass `dangerouslyDisableSandbox: true`; safety is maintained structurally via `--mode plan`.
- **Headless Permissions**: Runs are strictly headless; unapproved interactive tools are auto-denied.

### Session Monitoring
- **Deep-Link**: Emits `conversation://<conversation-id>` on init and completion for direct canvas navigation in the Antigravity desktop app.
- **Transcript Logs**: Trajectory JSONL logs stored in `~/.gemini/antigravity/brain/<conversation-id>/.system_generated/logs/transcript.jsonl`.

---

## 4. GitHub Copilot (`copilot`)

### Defaults & Overrides
- **Default Model**: `gpt-5.6-luna` (override via `-m <model>`)
- **Default Reasoning Effort**: `max` (override via `-e <level>`, e.g. `low`, `medium`, `high`, `max`)
- **Default Mode**: `--mode plan` (structural read-only)
- **Mode Override**: `--copilot-mode <desktop|vscode|cli|auto>` (explicit execution mode)
- **Reachability Probe**: `--test` / `--probe` (tests reachability via `--version` across all modes without token consumption)

### Order of Preference
1. **GitHub Copilot Desktop (`desktop`)**:
   - macOS: `~/Library/Caches/github-copilot-sdk/cli/<version>/copilot`, `~/Library/Caches/copilot/pkg/darwin-*/<version>/copilot`, `~/Library/Application Support/GitHub Copilot`, `/Applications/GitHub Copilot.app`
   - Windows: `%LOCALAPPDATA%\github-copilot-sdk\cli\<version>\copilot.exe`, `%LOCALAPPDATA%\github-copilot\cli`, `%LOCALAPPDATA%\Programs\GitHub Copilot\resources\bin\copilot.exe`, `%ProgramFiles%\GitHub Copilot`
   - Linux: `~/.cache/github-copilot-sdk/cli/<version>/copilot`, `~/.cache/copilot/pkg/linux-*/<version>/copilot`, `~/.local/share/github-copilot-sdk`, `/opt/GitHub Copilot`
2. **Copilot VS Code Extension (`vscode`)**:
   - macOS: `~/Library/Application Support/Code{, - Insiders}/User/globalStorage/github.copilot-chat/copilotCli/copilot`, `VSCodium`, `Cursor`
   - Windows: `%APPDATA%\Code\User\globalStorage\github.copilot-chat\copilotCli\copilot.{bat,cmd,exe,ps1}` (`Code - Insiders`, `VSCodium`, `%LOCALAPPDATA%`)
   - Linux: `~/.config/Code{, - Insiders}/User/globalStorage/github.copilot-chat/copilotCli/copilot`, `VSCodium`, Flatpak, Snap
3. **Copilot CLI (`cli`)**:
   - macOS: `/opt/homebrew/bin/copilot`, `/usr/local/bin/copilot`, `~/.local/bin/copilot`, `~/.npm-global/bin/copilot`, system `$PATH`
   - Windows: `%APPDATA%\npm\copilot.cmd`, `%LOCALAPPDATA%\npm\copilot.cmd`, `%LOCALAPPDATA%\Programs\copilot\copilot.exe`, `%ProgramFiles%\GitHub Copilot\copilot.exe`, system `PATH`
   - Linux: `/usr/local/bin/copilot`, `/usr/bin/copilot`, `/home/linuxbrew/.linuxbrew/bin/copilot`, `~/.local/bin/copilot`, system `$PATH`

### Sandboxing & Isolation
- **Structural Read-Only**: Enforced via `--mode plan`.
- **Safety Prompt & Integrity Check**: Prepends standard denied path rules; tracks workspace mutations via pre/post git status checks.
- **Token Independence**: Reachability probes validate binary launch without requiring active tokens or subscriptions.

### Session Monitoring
- **Resume Command**: Emits `copilot --resume <session_id>` when session ID is present in CLI output.
- **Session Logs**: Persisted via runner session loggers in the OS temp directory (`agent-dispatch-logs`).

---

## 5. Local OpenCode (`local`)

### Defaults & Overrides
- **Default Model**: `lmstudio/qwen3.8-27b-ridge` (override via `-m <model>`)
- **Default Reasoning Effort**: `null` (server default)
- **Default Mode**: Read-only prompt + network isolation
- **Reachability Probe**: Preflight HTTP probe against `http://127.0.0.1:1234/v1`

### Order of Preference
1. **Local OpenCode (`opencode`)**:
   - Cross-platform: `opencode` binary on system `$PATH` connecting to local LM Studio server at `http://127.0.0.1:1234/v1`

### Sandboxing & Isolation
- **WAN Confinement**: Outbound network traffic is trapped to dead proxy `127.0.0.1:0` via `HTTP_PROXY`/`HTTPS_PROXY`; `NO_PROXY=127.0.0.1,localhost` permits local LM Studio communication.
- **Credential Stripping**: Environment variables are filtered through `SAFE_ENV_WHITELIST`, removing API tokens, SSH keys, and cloud credentials.
- **Attachment Boundary**: File attachments (`-f`) are confined to workspace root, Antigravity brain, agent config directories, and OS temp dir.
- **Platform Constraints**: Linux uses Bubblewrap (`bwrap`) filesystem read-only mounts when available. macOS and Windows enforce read-only boundaries through prompt guardrails and pre/post git integrity checks.

### Session Monitoring
- **Server Endpoint**: Monitored via local server endpoint at `http://127.0.0.1:1234`.
- **Session Logs**: Stored via runner session loggers in the OS temp directory (`agent-dispatch-logs`).
- **Git Integrity**: Detects workspace changes across runs via `git status --porcelain` diffs.

---

## 6. Orchestrator Detection

`detectOrchestrator()` in [`scripts/dispatch.mjs`](../scripts/dispatch.mjs) inspects host CLI environment markers to skip dispatching back to the orchestrator's own platform:

| Orchestrator | Markers |
|--------------|---------|
| Antigravity | `ANTIGRAVITY_AGENT`, `ANTIGRAVITY_CONVERSATION_ID`, `ANTIGRAVITY_SESSION_ID`, `GEMINI_CLI` |
| Claude Code | `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT` |
| Copilot CLI | `COPILOT_AGENT`, `COPILOT_CLI_SESSION_ID` |
| OpenCode | `OPENCODE_PORT`, `OPENCODE_AGENT` |

`VSCODE_PID` is excluded from detection as it is set across all VS Code terminals regardless of driving agent. Pass `--orchestrator <name>` to override detection.

---

## 7. Failure Classification

`classifyFailure()` in [`scripts/common.mjs`](../scripts/common.mjs) classifies execution errors to guide cascade routing:

| Kind | Trigger | Cascade Behaviour |
|------|---------|-------------------|
| `quota` | Usage limit, rate limit, credit balance, HTTP 429 | Cascade to next provider with independent limits |
| `context-overflow` | Prompt too long, context length exceeded | Cascade to next provider; shrink attachments on repeat |
| `auth` | 401/403, invalid key, unauthenticated session | Report non-retryable error, cascade |
| `not-found` | Missing binary, `ENOENT` | Report non-retryable error, cascade |
| `timeout` | Execution timeout | Retain and return partial output if no fallback succeeds |

Exit code `0` with empty output is classified as a failure, capturing CLIs that exit clean while logging quota exhaustion to stderr.

---

## 8. Git Integrity Check

Every runner snapshots `git status --porcelain` before and after execution. Any detected difference triggers a `gitIntegrityViolation` warning.

- **False Positives**: Snapshots capture all workspace changes. Concurrent processes (IDE auto-save, file watchers, linters, background builds) may trigger warnings unrelated to delegate actions. Investigate warnings before treating them as security breaches.
