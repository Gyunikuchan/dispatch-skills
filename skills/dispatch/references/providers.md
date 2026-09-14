# Dispatch Providers Reference

Technical specifications, binary discovery paths, session monitoring mechanics, and sandboxing rules for dispatch providers.

---

## 1. Provider Specifications

Model and reasoning-effort defaults come from [`config.default.jsonc`](../config.default.jsonc) (or a project/machine override; see [Configuration](../SKILL.md#configuration) in `SKILL.md`). A runner given no model/effort (no CLI flag, no config entry) omits `-m`/`-e` entirely and lets the underlying CLI apply its own default.

Unpinned cascade order is diversity-sorted from the config's `platforms` key order: each platform's first array entry comes before any platform's second, and the orchestrator's platform comes last (sorted the same way). An in-slot `model` array stays within its one slot; `-m`/`-e` collapse a platform to one candidate; a pinned `--provider` walks that platform's entries in order.

| Provider | Key | CLI Binary | Direct Runner | Default Mode | Session Handle |
|----------|-----|------------|---------------|--------------|----------------|
| **Claude Code** | `claude` | `claude` | `scripts/claude-run.mjs` | Read-only | `claude --resume <session_id>` |
| **Antigravity 2.0** | `agy` | `agy` | `scripts/agy-run.mjs` | `--mode plan` | `conversation://<id>` |
| **GitHub Copilot** | `copilot` | `copilot` | `scripts/copilot-run.mjs` | `--mode plan` | `copilot --resume <session_id>` |
| **OpenCode** | `opencode` | `opencode` | `scripts/opencode-run.mjs` | Read-only | Local server logs |

---

## 2. Claude Code (`claude`)

### Defaults & Overrides
- **Model/Effort**: from `config.default.jsonc`'s `platforms.claude` entry (override via `-m <model>`/`-e <level>`); `model` may be an array there, tried in order as fallback models within this one cascade slot. No config entry and no `-m` means no `-m` flag reaches `claude` at all.
- **Default Mode**: Read-only (`--permission-mode plan`, `--allowedTools`, `--disallowedTools`)
- **Mode Override**: `--claude-mode <cli|desktop|vscode>` (explicit execution mode)
- **Reachability Probe**: `--test-modes` (tests reachability via `--version` across all modes without token consumption)

### Order of Preference
1. **Claude CLI (`cli`)**:
   - macOS / Linux: `~/.local/bin/claude`, `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`, NVM / global npm, system `$PATH`
   - Windows: `%APPDATA%\npm\claude.cmd`, `%USERPROFILE%\.local\bin\claude.exe`, system `PATH` (`where.exe`)
2. **Claude Desktop (`desktop`)**:
   - macOS: `~/Library/Application Support/Claude/claude-code/<version>/claude.app/Contents/MacOS/claude`
   - Windows: `%APPDATA%\Claude\claude-code\<version>\claude.exe`, `%LOCALAPPDATA%\Claude\claude-code\...`
   - Linux: `~/.config/Claude/claude-code/<version>/claude`, `~/.local/share/Claude/...`
3. **Claude VS Code Extension (`vscode`)**:
   - Cross-platform: `CLAUDE_CODE_EXECPATH` environment variable
   - Extension scan: `~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude` (`claude.exe` on Windows)
   - Agent-host SDK cache:
     - macOS: `~/Library/Application Support/Code/agent-host/sdk-cache/claude/**/claude`
     - Windows: `%APPDATA%\Code\agent-host\sdk-cache\claude\**\claude.exe`
     - Linux: `~/.config/Code/agent-host/sdk-cache/claude/**/claude`

### Sandboxing & Isolation
- **Tool Restriction**: `--permission-mode plan` plus `--allowedTools` restricts tool types (`Read`, `Glob`, `Grep`, `Bash(git diff*)`, `Bash(grep *)`, …), not individual filesystem paths; commands that write or execute through their own arguments (`find`, `awk`, `sort`) and web tools (`WebFetch`, `WebSearch`) are excluded, and `--disallowedTools Write Edit NotebookEdit` denies write tools outright.
- **Safety Prompt**: Restricts denied directories (`.ssh/`, `.aws/`, `.gnupg/`, `.docker/`, `.kube/`, `.password-store/`) and denied file patterns (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `*token*`, `*secret*`).
- **Sandbox Boundary**: Delegate session inherits the host process sandbox boundaries.
- **Model & Mode Cascade**: Discovery probes test `--version` without token spend. If a model is not available or fails, `runClaude` falls back across whatever candidate models were configured (an array `model` in `config.default.jsonc`'s `platforms.claude`, or a single `-m` override). On `auth` or `quota` exhaustion across models, it cascades to the next available mode unless pinned.

### Session Monitoring
- **Resume Command**: Captured `session_id` from JSON envelope (`--output-format json`) emits `claude --resume <session_id>`.
- **Error Classification**: JSON envelope exposes `is_error` and `subtype` (e.g. `error_max_turns`) for cascade routing.
- **Session History**: Stored in `~/.claude/projects/`; resumable in terminal or IDE tabs.

---

## 3. Antigravity 2.0 (`agy`)

### Defaults & Overrides
- **Model/Effort**: from `config.default.jsonc`'s `platforms.agy` entry (override via `-m <model>`/`-e <level>`); `model` may be an array there, tried in order as fallback models within this one cascade slot. No config entry and no `-m`/`-e` means neither flag reaches `agy` at all.
- **Default Mode**: `--mode plan` (structural read-only)
- **Mode Override**: `--agy-mode <antigravity-cli|antigravity-2.0|antigravity-vscode|auto>`
- **Reachability Probe**: `--test-reachability` (tests reachability across all modes without token consumption)

### Order of Preference
1. **Antigravity CLI (`antigravity-cli`)**:
   - Cross-platform: `~/.gemini/bin/agy`, `~/.local/bin/agy`, system `$PATH`
2. **Antigravity Desktop (`antigravity-2.0`)**:
   - macOS: `~/.gemini/antigravity/bin/agy`, `/Applications/Antigravity.app/Contents/Resources/bin/agy`
   - Windows: `%LOCALAPPDATA%\Google\Antigravity\bin\agy.exe`, `%APPDATA%\Google\Antigravity\bin\agy.exe`, `%ProgramFiles%\Antigravity\bin\agy.exe`
   - Linux: `~/.gemini/antigravity/bin/agy`, `/opt/Antigravity/agy`
3. **Antigravity VS Code Extension (`antigravity-vscode`)**:
   - macOS: `~/.gemini/antigravity-ide/bin/agy`, `~/Library/Application Support/Code/User/globalStorage/google.google-antigravity/bin/agy`
   - Windows: `%APPDATA%\Code\User\globalStorage\google.google-antigravity\bin\agy.exe`
   - Linux: `~/.gemini/antigravity-ide/bin/agy`, `~/.config/Code/User/globalStorage/google.google-antigravity/bin/agy`

### Sandboxing & Isolation
- **Structural Read-Only**: Enforced via `--mode plan`. Edits are blocked at the runtime level.
- **Claude Code Sandbox Constraint**: Antigravity binds a local TCP socket for its language server, conflicting with Claude Code's Bash tool sandbox (`bind: operation not permitted`). Runs pass `dangerouslyDisableSandbox: true`; safety is maintained structurally via `--mode plan`.
- **Headless Permissions**: Runs pass `--dangerously-skip-permissions` to auto-approve tool execution requests (e.g. file reading, search) without interactive prompts in headless mode, while write operations are structurally prevented by `--mode plan`.

### Session Monitoring
- **Deep-Link**: Emits `conversation://<conversation-id>` on init and completion for direct canvas navigation in the Antigravity desktop app (available in desktop mode).
- **Transcript Logs**: Trajectory JSONL logs stored in `~/.gemini/antigravity/brain/<conversation-id>/.system_generated/logs/transcript.jsonl` (or mode-specific `JETSKI_APP_DATA_DIR` directory).

---

## 4. GitHub Copilot (`copilot`)

### Defaults & Overrides
- **Model/Effort**: from `config.default.jsonc`'s `platforms.copilot` entry (override via `-m <model>`/`-e <level>`); `model` may be an array there, tried in order as fallback models within this one cascade slot. No config entry and no `-m`/`-e` means neither flag reaches `copilot` at all.
- **Default Mode**: `--mode plan` (structural read-only)
- **Mode Override**: `--copilot-mode <cli|desktop|vscode|auto>` (explicit execution mode)
- **Reachability Probe**: `--test` / `--probe` (tests reachability via `--version` across all modes without token consumption)

### Order of Preference
1. **Copilot CLI (`cli`)**:
   - macOS: `/opt/homebrew/bin/copilot`, `/usr/local/bin/copilot`, `~/.local/bin/copilot`, `~/.npm-global/bin/copilot`, system `$PATH`
   - Windows: `%APPDATA%\npm\copilot.cmd`, `%LOCALAPPDATA%\npm\copilot.cmd`, `%LOCALAPPDATA%\Programs\copilot\copilot.exe`, `%ProgramFiles%\GitHub Copilot\copilot.exe`, system `PATH`
   - Linux: `/usr/local/bin/copilot`, `/usr/bin/copilot`, `/home/linuxbrew/.linuxbrew/bin/copilot`, `~/.local/bin/copilot`, system `$PATH`
2. **GitHub Copilot Desktop (`desktop`)**:
   - macOS: `~/Library/Caches/github-copilot-sdk/cli/<version>/copilot`, `~/Library/Caches/copilot/pkg/darwin-*/<version>/copilot`, `~/Library/Application Support/GitHub Copilot`, `/Applications/GitHub Copilot.app`
   - Windows: `%LOCALAPPDATA%\github-copilot-sdk\cli\<version>\copilot.exe`, `%LOCALAPPDATA%\github-copilot\cli`, `%LOCALAPPDATA%\Programs\GitHub Copilot\resources\bin\copilot.exe`, `%ProgramFiles%\GitHub Copilot`
   - Linux: `~/.cache/github-copilot-sdk/cli/<version>/copilot`, `~/.cache/copilot/pkg/linux-*/<version>/copilot`, `~/.local/share/github-copilot-sdk`, `/opt/GitHub Copilot`
3. **Copilot VS Code Extension (`vscode`)**:
   - macOS: `~/Library/Application Support/Code{, - Insiders}/User/globalStorage/github.copilot-chat/copilotCli/copilot`, `VSCodium`, `Cursor`
   - Windows: `%APPDATA%\Code\User\globalStorage\github.copilot-chat\copilotCli\copilot.{bat,cmd,exe,ps1}` (`Code - Insiders`, `VSCodium`, `%LOCALAPPDATA%`)
   - Linux: `~/.config/Code{, - Insiders}/User/globalStorage/github.copilot-chat/copilotCli/copilot`, `VSCodium`, Flatpak, Snap

### Sandboxing & Isolation
- **Structural Read-Only**: Enforced via `--mode plan`.
- **Safety Prompt & Integrity Check**: Prepends standard denied path rules; tracks workspace mutations via pre/post git status checks.
- **Token Independence**: Reachability probes validate binary launch without requiring active tokens or subscriptions.

### Session Monitoring
- **Resume Command**: Emits `copilot --resume <session_id>` when session ID is present in CLI output.
- **Session Logs**: Persisted via runner session loggers in the OS temp directory (`agent-dispatch-logs`).

---

## 5. OpenCode (`opencode`)

### Defaults & Overrides
- **Model/Effort**: from `config.default.jsonc`'s `platforms.opencode` entry (override via `-m <provider>/<model>`/`-e <level>`; `-e` reaches `opencode` as `--variant <effort>`); `model` may be an array inside a candidate entry, tried in order as fallback models within that one cascade slot (each model re-resolves locality, preflight and GPU lock). Supports an array of candidate entries to cascade across multiple models (e.g. the shipped default of OpenCode Go GLM (`opencode-go/glm-5.3-flash`) -> DeepSeek (`opencode-go/deepseek-v4.1-flash`) -> LM Studio (`lmstudio/qwen3.8-27b-ridge`)). With no `model` configured anywhere — neither dispatch's config nor `opencode.jsonc` — no `-m` flag reaches `opencode`, and `opencode`'s own CLI default applies; dispatch makes no assumption of Local LM Studio.
- **Default Mode**: Read-only prompt + network isolation
- **Reachability Probe**: branches on whether the resolved endpoint host is a loopback address
  (`isLocalEndpointHost`). Local (an `lmstudio/...` model resolved to its loopback endpoint, or any
  other loopback-bound backend): preflight HTTP probe against the resolved `baseURL` (e.g.
  `http://127.0.0.1:1234/v1`) — fast, free, and safe against a machine the user just started.
  Remote, or nothing configured at all (`resolveOpencodeSettings`'s `isLocal: false`): no live
  network probe — `isOpencodeAvailable()` degrades to a binary-presence probe (`opencode` on
  `$PATH`), mirroring `isClaudeAvailable`/`isCopilotAvailable`/`isAgyAvailable`; actual
  reachability is left to `opencode`'s own execution, whose `auth`/`quota`/`not-found` failures
  are classified normally.
- **Config**: merged across every locally-readable tier of opencode's own precedence order (https://opencode.ai/docs/config/#precedence-order): global (`~/.config/opencode/`, `XDG_CONFIG_HOME`-aware) → `OPENCODE_CONFIG` → project root → `.opencode/` directories → `OPENCODE_CONFIG_CONTENT` → OS-managed config dirs, for model, agent, and limit overrides. `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`, and `XDG_CONFIG_HOME` also pass through to the spawned delegate's environment so it resolves the same config. Remote config and macOS MDM `.mobileconfig` are excluded — see `readOpencodeConfig` in `opencode-run.mjs`.

### Order of Preference
1. **OpenCode (`opencode`)**:
   - Cross-platform: `opencode` binary on system `$PATH`, connecting to whatever provider endpoint
     resolves from the configured `model` (`lmstudio/...` resolves to local `http://127.0.0.1:1234/v1`
     by convention; any other `provider/model` string resolves elsewhere). With no `model`
     configured anywhere, `opencode`'s own CLI default applies.

### Sandboxing & Isolation
- **WAN Confinement**: applies only when the resolved endpoint is local. Outbound network traffic is trapped to dead proxy `127.0.0.1:0` via `HTTP_PROXY`/`HTTPS_PROXY`; `NO_PROXY=127.0.0.1,localhost` permits local backend communication. A remote provider's entire purpose is reaching WAN, so no proxy variables are set at all for that case — reachability and auth are opencode's own concern.
- **Credential Stripping**: Environment variables are filtered through `SAFE_ENV_WHITELIST`, removing API tokens, SSH keys, and cloud credentials, regardless of provider. A remote provider's own credentials belong in `opencode.jsonc`'s `provider.<name>.options.apiKey`, resolved by `opencode`'s own subprocess — not in this process's environment.
- **Attachment Boundary**: File attachments (`-f`) outside the workspace root, Antigravity brain, agent config directories, and OS temp dir are read with a warning; the sensitive-file denylist (checked against the resolved real path) is the gate, and a denylisted file is skipped with the same warning.
- **Platform Constraints**: Linux uses Bubblewrap (`bwrap`) filesystem read-only mounts when available. macOS and Windows rely on prompt guardrails and pre/post git integrity checks — no structural read-only boundary.
- **Accepted risk**: every run passes `opencode run --auto`, which auto-approves any permission not explicitly denied. It is kept because headless runs cannot answer permission prompts. Residual boundary: Linux with `bwrap` — read-only mounts; macOS/Windows (and Linux without `bwrap`) — the prompt guardrail plus the git integrity check only.
- **GPU Concurrency Lock**: only acquired when the resolved endpoint is local (prevents concurrent hooks from thrashing local VRAM); a remote API call has no such contention and is not serialized behind it.

### Session Monitoring
- **Server Endpoint**: Monitored via the resolved LM Studio endpoint (default `http://127.0.0.1:1234`) when the endpoint is local.
- **Session Logs**: Stored via runner session loggers in the OS temp directory (`agent-dispatch-logs`).
- **Git Integrity**: Detects workspace changes across runs via `git status --porcelain` diffs.

---

## 6. Orchestrator Detection

`detectOrchestrator()` in [`scripts/common.mjs`](../scripts/common.mjs) (re-exported by `dispatch.mjs`) inspects host CLI environment markers to skip dispatching back to the orchestrator's own platform:

| Orchestrator | Markers |
|--------------|---------|
| Antigravity | `ANTIGRAVITY_AGENT`, `ANTIGRAVITY_CONVERSATION_ID`, `ANTIGRAVITY_SESSION_ID`, `GEMINI_CLI` |
| Claude Code | `CLAUDECODE`, `CLAUDE_CODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT` |
| Copilot CLI | `COPILOT_AGENT`, `COPILOT_CLI_SESSION_ID` |
| OpenCode | `OPENCODE_PORT`, `OPENCODE_AGENT` |

`VSCODE_PID` is excluded from detection as it is set across all VS Code terminals regardless of driving agent. Pass `--orchestrator <name>` to override detection.

---

## 7. Failure Classification

`classifyFailure()` in [`scripts/common.mjs`](../scripts/common.mjs) classifies execution errors to guide cascade routing:

| Kind | Trigger | Cascade Behaviour |
|------|---------|-------------------|
| `quota` | Usage limit, rate limit, credit balance, HTTP 429 | Cascade to next provider with independent limits |
| `context-overflow` | Prompt too long, context length exceeded | Cascade to next provider |
| `auth` | 401/403, invalid key, unauthenticated session | Report non-retryable error, cascade |
| `model-not-loaded` | `No models loaded`, `model not loaded` (local backend with no model in memory; OpenCode preflight also warns when LM Studio reports no loaded model — run `lms load <model>`) | Non-retryable on OpenCode; cascades to the next provider like any other failure (unpinned runs follow the normal cascade; pinned runs return it) |
| `not-found` | Missing binary, `ENOENT` | Report non-retryable error, cascade |
| `timeout` | Execution timeout | Retain and return partial output if no fallback succeeds |

Exit code `0` with empty output is classified as a failure, capturing CLIs that exit clean while logging quota exhaustion to stderr.

---

## 8. Git Integrity Check

Every runner snapshots `git status --porcelain` before and after execution. Any detected difference triggers a `gitIntegrityViolation` warning.

- **False Positives**: Snapshots capture all workspace changes. Concurrent processes (IDE auto-save, file watchers, linters, background builds) may trigger warnings unrelated to delegate actions. Investigate warnings before treating them as security breaches.
