# Dispatch Providers Reference

Technical specifications, binary discovery paths, session monitoring mechanics, and sandboxing rules for dispatch providers.

---

## 1. Provider Specifications

Model and reasoning-effort defaults come from [`config.default.jsonc`](../config.default.jsonc) (or a project/machine override; see [Configuration](../SKILL.md#configuration) in `SKILL.md`). Runners given no model/effort omit `-m`/`-e` entirely, allowing the underlying CLI to apply its default.

Unpinned cascade order is diversity-sorted from config `platforms` key order: each platform's first entry precedes any second entry, and the orchestrator's platform comes last (with candidates matching the active orchestrator model demoted behind alternative models). Candidate `model` arrays try alternatives within their single cascade slot; `-m`/`-e` collapse a platform to one candidate; `--provider` walks that platform's entries in order.

| Provider | Key | CLI Binary | Direct Runner | Default Mode | Session Handle |
|----------|-----|------------|---------------|--------------|----------------|
| **Claude Code** | `claude` | `claude` | `scripts/claude-run.mjs` | Read-only | `claude --resume <session_id>` |
| **Antigravity 2.0** | `agy` | `agy` | `scripts/agy-run.mjs` | `--mode plan` | `conversation://<id>` |
| **GitHub Copilot** | `copilot` | `copilot` | `scripts/copilot-run.mjs` | `--mode plan` | `copilot --resume <session_id>` |
| **OpenCode** | `opencode` | `opencode` | `scripts/opencode-run.mjs` | Read-only | Local server logs |

### Safe Environment Variable Pass-Through

Delegates execute in a sanitized environment with credentials stripped. Safe variables pass through:
- **Proxy & Networking**: `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY`
- **TLS & Certificates**: `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`
- **System & Locale**: `PATH`, `PATHEXT`, `TERM`, `HOME`, `USERPROFILE`, `SYSTEMROOT`, `COMSPEC`, `SHELL`, `TMPDIR`, `TEMP`, `TMP`, `USER`, `USERNAME`, `LOGNAME`, `TZ`, `LANG`, `LC_ALL`, `LC_CTYPE`
- **XDG & Config**: `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`, `CLAUDE_CONFIG_DIR`, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`

---

## 2. Claude Code (`claude`)

### Defaults & Overrides
- **Model/Effort**: from `config.default.jsonc` (`platforms.claude`); override via `-m <model>`/`-e <level>` (`-e` passes through to `--effort`). `model` arrays cascade within this slot. Unset values omit flags, defaulting to CLI behaviour.
- **Default Mode**: Read-only (`--permission-mode plan`, `--allowedTools`, `--disallowedTools`)
- **Mode Override**: `--claude-mode <cli|desktop|vscode>`
- **Reachability Probe**: `--test-modes` (tests `--version` across all modes without token spend)

### Order of Preference
1. **Claude CLI (`cli`)**:
   - macOS / Linux: `~/.local/bin/claude`, `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`, NVM / global npm, `$PATH`
   - Windows: `%APPDATA%\npm\claude.cmd`, `%USERPROFILE%\.local\bin\claude.exe`, system `PATH`
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
- **Tool Restriction**: `--permission-mode plan` with `--allowedTools` restricts tool categories (`Read`, `Glob`, `Grep`, `Bash(git diff*)`, `Bash(grep *)`); write/execution commands (`find`, `awk`, `sort`) and web tools (`WebFetch`, `WebSearch`) are excluded; `--disallowedTools Write Edit NotebookEdit` blocks file edits.
- **Safety Prompt**: Restricts sensitive directories (`.ssh/`, `.aws/`, `.gnupg/`, `.docker/`, `.kube/`, `.password-store/`) and sensitive file patterns (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `*token*`, `*secret*`).
- **Sandbox Boundary**: Inherits host process sandbox boundaries.
- **Model & Mode Cascade**: Discovery probes test `--version` without token spend. On `auth` or `quota` exhaustion across candidate models, cascades to the next mode unless pinned.

### Session Monitoring
- **Resume Command**: Captured `session_id` from JSON envelope (`--output-format json`) emits `claude --resume <session_id>`.
- **Error Classification**: JSON envelope exposes `is_error` and `subtype` for cascade routing.
- **Session History**: Stored in `~/.claude/projects/`.

---

## 3. Antigravity 2.0 (`agy`)

### Defaults & Overrides
- **Model/Effort**: from `config.default.jsonc` (`platforms.agy`); override via `-m <model>`/`-e <level>` (`-e` passes through to `-e`). `model` arrays cascade within this slot. Unset values omit flags.
- **Default Mode**: `--mode plan` (structural read-only)
- **Mode Override**: `--agy-mode <antigravity-cli|antigravity-2.0|antigravity-vscode|auto>`
- **Reachability Probe**: `--test-reachability` (tests reachability without token spend)

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
- **Structural Read-Only**: Enforced via `--mode plan`. Edits are blocked at runtime.
- **Claude Code Sandbox Constraint**: Antigravity binds a local TCP socket for its language server, conflicting with Claude Code's Bash sandbox (`bind: operation not permitted`). Invocations pass `dangerouslyDisableSandbox: true`; safety remains structurally enforced by `--mode plan`.
- **Headless Permissions**: Invocations pass `--dangerously-skip-permissions` to auto-approve read tools headlessly while file modifications remain structurally prevented.

### Session Monitoring
- **Deep-Link**: Emits `conversation://<conversation-id>` on init and completion.
- **Transcript Logs**: JSONL trajectory logs stored in `~/.gemini/antigravity/brain/<conversation-id>/.system_generated/logs/transcript.jsonl` (or mode-specific `JETSKI_APP_DATA_DIR`).

---

## 4. GitHub Copilot (`copilot`)

### Defaults & Overrides
- **Model/Effort**: from `config.default.jsonc` (`platforms.copilot`); override via `-m <model>`/`-e <level>` (`-e` passes through to `-e`). `model` arrays cascade within this slot. Unset values omit flags.
- **Sandbox**: set `platforms.copilot.sandbox` to `false` to disable the paired `--experimental --sandbox` flags (Copilot gates the sandbox behind `--experimental`). It defaults to `true` in the shipped config.
- **Default Mode**: `--mode plan` (structural read-only)
- **Mode Override**: `--copilot-mode <cli|desktop|vscode|auto>`
- **Reachability Probe**: `--test` / `--probe` (tests `--version` across all modes without token spend)

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
- **Optional Command Sandbox**: When `platforms.copilot.sandbox` is enabled, shell commands run inside Copilot CLI's experimental OS-level sandbox. The required `--experimental` flag also opts into Copilot CLI's broader experimental feature surface. This is defense in depth: built-in file edits are not OS-sandboxed, sandbox policies may block legitimate build or service commands, and host prerequisites vary by platform.
- **Safety Prompt & Integrity Check**: Prepends standard denied path rules; tracks workspace mutations via pre/post git status checks.
- **Token Independence**: Reachability probes validate binary launch without requiring active subscriptions.

### Session Monitoring
- **Resume Command**: Emits `copilot --resume <session_id>` when session ID is detected.
- **Session Logs**: Persisted in OS temp directory (`agent-dispatch-logs`).

---

## 5. OpenCode (`opencode`)

### Defaults & Overrides
- **Model/Effort**: from `config.default.jsonc` (`platforms.opencode`); override via `-m <provider>/<model>`/`-e <level>` (`-e` maps to `--variant <effort>`). `model` arrays inside candidates cascade within their slot. Unset values omit `-m`, applying CLI defaults.
- **Default Mode**: Read-only prompt + network isolation
- **Reachability Probe**:
  - Local endpoint (loopback host `127.0.0.1` / `localhost`): Preflight HTTP probe against baseURL (`http://127.0.0.1:1234/v1`).
  - Remote endpoint / Unconfigured: Binary-presence probe (`isOpencodeAvailable()`), leaving runtime reachability to standard error classification.
- **Config Precedence**: Merges locally-readable tiers (`~/.config/opencode/`, `OPENCODE_CONFIG`, project root, `.opencode/`, `OPENCODE_CONFIG_CONTENT`). Passes config environment variables to spawned delegate.

### Order of Preference
1. **OpenCode CLI**: `opencode` binary on `$PATH` (`where.exe`/`which`, preferring `.exe` over `.cmd/.bat` on Windows).
2. **OpenCode Desktop**: CLI sidecar binary bundled inside desktop app (`%LOCALAPPDATA%\OpenCode`, `/Applications/OpenCode.app`, `/opt/opencode-desktop`).
3. **OpenCode VS Code Extension**: CLI binary bundled inside `sst-dev.opencode(-v2)` extension directory (best-effort fallback).

### Sandboxing & Isolation
- **WAN Confinement**: For local endpoints, traps outbound network to dead proxy `127.0.0.1:0` (`HTTP_PROXY`/`HTTPS_PROXY`) with `NO_PROXY=127.0.0.1,localhost`. Remote endpoints bypass proxy confinement.
- **Credential Stripping**: `SAFE_ENV_WHITELIST` filters subprocess environment; remote credentials belong in `opencode.jsonc`.
- **Attachment Boundary**: Attachments (`-f`) outside workspace root, Antigravity brain, agent config dirs, and OS temp dir trigger warnings; sensitive denylisted files are skipped.
- **Platform Constraints**: Linux uses Bubblewrap (`bwrap`) read-only mounts when available. macOS, Windows, and Linux without `bwrap` rely on prompt guardrails and pre/post git integrity checks (`opencode run --auto` auto-approves permissions headlessly).
- **GPU Concurrency Lock**: Serializes local backend runs to prevent VRAM thrashing; remote API runs bypass the lock.

### Session Monitoring
- **Server Endpoint**: Monitored via resolved endpoint when local (`http://127.0.0.1:1234`).
- **Session Logs**: Stored in OS temp directory (`agent-dispatch-logs`).
- **Git Integrity**: Detects workspace changes via pre/post `git status --porcelain` diffs.

---

## 6. Orchestrator Detection

`detectOrchestrator()` in [`scripts/common.mjs`](../scripts/common.mjs) inspects host CLI environment markers to prevent self-dispatch:

| Orchestrator | Platform Markers | Model Markers |
|--------------|------------------|---------------|
| Antigravity | `ANTIGRAVITY_AGENT`, `ANTIGRAVITY_CONVERSATION_ID`, `ANTIGRAVITY_SESSION_ID`, `GEMINI_CLI` | `ANTIGRAVITY_MODEL`, `GEMINI_MODEL` |
| Claude Code | `CLAUDECODE`, `CLAUDE_CODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT` | `CLAUDE_MODEL`, `ANTHROPIC_MODEL` |
| Copilot CLI | `COPILOT_AGENT`, `COPILOT_CLI_SESSION_ID` | `COPILOT_MODEL`, `GITHUB_COPILOT_MODEL` |
| OpenCode | `OPENCODE_PORT`, `OPENCODE_AGENT` | `OPENCODE_MODEL` |

`VSCODE_PID` is excluded from detection (set across all VS Code terminals). Override detection with `--orchestrator <name>` and `--orchestrator-model <model>`.

`detectOrchestratorModel()` pairs detected model with orchestrator host to demote same-platform + same-model candidates to the end of the candidate list.

---

## 7. Failure Classification

`classifyFailure()` in [`scripts/common.mjs`](../scripts/common.mjs) classifies execution errors to guide cascade routing:

| Kind | Trigger | Cascade Behaviour |
|------|---------|-------------------|
| `quota` | Usage limit, rate limit, credit balance, HTTP 429 | Cascade to next provider |
| `context-overflow` | Prompt too long, context length exceeded | Cascade to next provider |
| `auth` | 401/403, invalid key, unauthenticated session | Report non-retryable error, cascade |
| `model-not-loaded` | `No models loaded`, `model not loaded` (local backend uninitialized) | Non-retryable on OpenCode; cascades to next provider |
| `not-found` | Missing binary, `ENOENT` | Report non-retryable error, cascade |
| `timeout` | Execution timeout | Retain and return partial output if no fallback succeeds |

Exit code `0` with empty output is classified as a failure, capturing CLIs that exit clean while logging quota exhaustion to stderr.

---

## 8. Git Integrity Check

Runners snapshot `git status --porcelain` before and after execution. Any detected difference triggers a `gitIntegrityViolation` warning.

- **False Positives**: Snapshots capture all workspace changes. Concurrent processes (IDE auto-save, file watchers, linters, background builds) may trigger warnings unrelated to delegate actions. Investigate warnings before treating them as security breaches.
