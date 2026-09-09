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
- **Mode Override**: `--claude-mode <desktop|vscode|cli>` (explicit execution mode)
- **Reachability Probe**: `--test-modes` (tests reachability up to `--version` across all modes without token consumption)

### Order of Preference
1. **Claude Desktop (`desktop`)**:
   - macOS: `~/Library/Application Support/Claude/claude-code/<version>/claude.app/Contents/MacOS/claude`
   - Windows: `%APPDATA%\Claude\claude-code\<version>\claude.exe`, `%LOCALAPPDATA%\Claude\claude-code\...`
   - Linux: `~/.config/Claude/claude-code/<version>/claude`, `~/.local/share/Claude/...`
2. **Claude VS Code Extension (`vscode`)**:
   - Cross-platform: `CLAUDE_CODE_EXECPATH` environment variable
   - Extensions scan: `~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude` (`claude.exe` on Windows)
   - Agent-host SDK cache:
     - macOS: `~/Library/Application Support/Code/agent-host/sdk-cache/claude/**/claude`
     - Windows: `%APPDATA%\Code\agent-host\sdk-cache\claude\**\claude.exe`
     - Linux: `~/.config/Code/agent-host/sdk-cache/claude/**/claude`
3. **Claude CLI (`cli`)**:
   - macOS / Linux: `~/.local/bin/claude`, `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`, NVM / global npm, system `$PATH`
   - Windows: `%APPDATA%\npm\claude.cmd`, `%USERPROFILE%\.local\bin\claude.exe`, system `PATH` (`where.exe`)

### Multi-Mode Cascade & Token Availability
Not all modes may be subscribed or hold tokens on a given machine. Discovery probes test binary reachability via `--version` (zero token consumption). If execution on the preferred mode encounters an `auth` or `quota` failure, `runClaude` automatically cascades to the next available mode in preference order unless pinned.

### Read-Only Path Scope
Claude Code's `--allowedTools` provides tool-type restriction (only `Read`, `Bash(grep *)`, `Bash(find *)`, etc.), not path-level restriction — the glob `*` matches any characters in the command string. A delegate can technically read files outside the workspace via allowed tools like `grep` or `find`. Path scoping is enforced by:

1. **Safety prompt**: explicitly lists denied directories (`.ssh/`, `.aws/`, `.gnupg/`, `.docker/`, `.kube/`, `.password-store/`) and denied file patterns (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `*token*`, `*secret*`).
2. **Claude Code's own sandbox**: the delegate session inherits the host's sandbox restrictions, which provide an outer boundary.

This is a known limitation of prompt-level path enforcement — it relies on the model following the safety instructions.

### Session Monitoring
- **Resume Command**: The runner passes `--output-format json` and reads `session_id` from the result envelope, emitting `claude --resume <session_id>`. Plain `-p` text output carries no session id, so the envelope is the only reliable source.
- **Error Subtypes**: The same envelope exposes `is_error` and `subtype` (for example `error_max_turns`), which the cascade uses to classify a failure before deciding whether to try another provider.
- **Session History**: Persisted in `~/.claude/projects/` and can be resumed in terminal or IDE terminal tabs.

---

## 3. Antigravity 2.0 (`agy`)

### Defaults & Overrides
- **Default Model**: `gemini-3.8-flash` (override via `-m <model>`)
- **Default Reasoning Effort**: `medium` (override via `-e <level>`, e.g. `low`, `medium`, `high`)

### Order of Preference
1. **Antigravity 2.0 (Desktop app)**:
   - macOS: `~/.gemini/antigravity/bin/agy`, `/Applications/Antigravity.app/Contents/Resources/bin/agy`
   - Windows: `%LOCALAPPDATA%\Google\Antigravity\bin\agy.exe`, `%APPDATA%\Google\Antigravity\bin\agy.exe`, `%ProgramFiles%\Antigravity\bin\agy.exe`
   - Linux: `~/.gemini/antigravity/bin/agy`, `/opt/Antigravity/agy`
2. **Antigravity VS Code Extension**:
   - macOS: `~/.gemini/antigravity-ide/bin/agy`, `~/Library/Application Support/Code/User/globalStorage/google.google-antigravity/bin/agy`
   - Windows: `%APPDATA%\Code\User\globalStorage\google.google-antigravity\bin\agy.exe`
   - Linux: `~/.gemini/antigravity-ide/bin/agy`, `~/.config/Code/User/globalStorage/google.google-antigravity/bin/agy`
3. **Antigravity CLI (standalone)**:
   - Cross-platform: `~/.gemini/bin/agy`, `~/.local/bin/agy`, system `$PATH`

### Claude Code Sandbox Constraint
Antigravity requires binding a local TCP socket to start its language server. When dispatched from Claude Code, this conflicts with the Bash tool sandbox and the run fails with `listen tcp 127.0.0.1:0: bind: operation not permitted`. Run the dispatch command with `dangerouslyDisableSandbox: true`. The runner enforces read-only structurally (`--mode plan`), so disabling the sandbox does not weaken safety.

### Headless Permissions
Read-only headless runs pass `--mode plan`. `plan` mode forbids edits; some read tools may be auto-denied in headless mode when no human is present to approve them. Interactive runs (`-i`) allow a human to answer permission prompts directly.

### Session Monitoring
- **Deep-link**: Emits `conversation://<conversation-id>` on initialization and completion. Clicking this link within the Antigravity desktop application navigates directly to the subagent's conversation canvas.
- **Transcript Logs**: Full trajectory JSONL logs are stored in `~/.gemini/antigravity/brain/<conversation-id>/.system_generated/logs/transcript.jsonl`.
- **Interactive Mode**: Pass `-i` or `--interactive` to spawn an interactive Antigravity CLI session in the current terminal.

---

## 4. GitHub Copilot CLI (`copilot`)

### Defaults & Overrides
- **Default Model**: `gpt-5.6-luna` (override via `-m <model>`)
- **Default Reasoning Effort**: `max` (override via `-e <level>`, e.g. `low`, `medium`, `high`, `max`)

### Execution Modes & Preference Order
1. **Copilot VS Code Extension (`vscode`)** (Priority 1)
   - macOS: `~/Library/Application Support/Code{, - Insiders}/User/globalStorage/github.copilot-chat/copilotCli/copilot`, `VSCodium`, `Cursor`
   - Windows: `%APPDATA%\Code\User\globalStorage\github.copilot-chat\copilotCli\copilot.{bat,cmd,exe,ps1}` (and `Code - Insiders`, `VSCodium`, `%LOCALAPPDATA%`)
   - Linux: `~/.config/Code{, - Insiders}/User/globalStorage/github.copilot-chat/copilotCli/copilot`, `VSCodium`, Flatpak, Snap
2. **Standalone Copilot CLI (`cli`)** (Priority 2 / Fallback)
   - System `$PATH` (`copilot` / `copilot.cmd`)
   - macOS: `/opt/homebrew/bin/copilot`, `/usr/local/bin/copilot`, `~/.local/bin/copilot`, `~/.npm-global/bin/copilot`
   - Windows: `%APPDATA%\npm\copilot.cmd`, `%LOCALAPPDATA%\npm\copilot.cmd`, `%LOCALAPPDATA%\Programs\copilot\copilot.exe`, `%ProgramFiles%\GitHub Copilot\copilot.exe`
   - Linux: `/usr/local/bin/copilot`, `/usr/bin/copilot`, `/home/linuxbrew/.linuxbrew/bin/copilot`, `~/.local/bin/copilot`

### Reachability Testing
- Probed via `--version` (`testCopilotReachability` / `probeCopilotModes` / `node scripts/copilot-run.mjs --test`).
- Does **not** require active Copilot subscriptions or tokens: reachability validates binary execution so environments without tokens still detect and fall back cleanly.

### Session Monitoring
- **Resume Command**: Captures session ID from output and emits `copilot --resume <session_id>`. Absent when the CLI prints no id.

---

## 5. Local OpenCode + LM Studio

### Prerequisites
- LM Studio running with local server started on `http://127.0.0.1:1234/v1`.
- `opencode` CLI installed and reachable.

### Sandboxing Guarantee
- **WAN Confinement**: Proxies outbound network traffic to `127.0.0.1:0` via `HTTP_PROXY`/`HTTPS_PROXY` while keeping `NO_PROXY=127.0.0.1,localhost` for LM Studio.
- **Credential Stripping**: Environment variables are strictly filtered through `SAFE_ENV_WHITELIST`, stripping API tokens, SSH keys, and cloud secrets.
- **Boundary Restriction**: File attachments (`-f`) are confined to the workspace root, Antigravity brain, agent config directories, and OS temp dir.

### Known Limitations
- **Read-only enforcement is prompt-level on macOS and Windows.** OpenCode's `--auto --pure` flags do not provide a structural read-only mode equivalent to Claude Code's `--allowedTools` or Antigravity/Copilot's `--mode plan`. On Linux, Bubblewrap (`bwrap`) provides filesystem-level read-only binding when available. On macOS and Windows, the only enforcement layers are the safety prompt prepended to the task and the post-run git integrity check. Local models are less reliable at following prompt constraints than cloud models, so writes are possible if the model ignores the guardrail.
- **Git integrity check detects but does not revert.** A `git status --porcelain` snapshot is compared before and after the run. Violations are flagged as warnings; the runner does not roll back changes.

---

## 6. Orchestrator Detection

`detectOrchestrator()` in [`scripts/dispatch.mjs`](../scripts/dispatch.mjs) reads the markers each host CLI exports, so the cascade can skip the orchestrator's own platform:

| Orchestrator | Markers |
|--------------|---------|
| Antigravity | `ANTIGRAVITY_AGENT`, `ANTIGRAVITY_CONVERSATION_ID`, `ANTIGRAVITY_SESSION_ID`, `GEMINI_CLI` |
| Claude Code | `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT` |
| Copilot CLI | `COPILOT_AGENT`, `COPILOT_CLI_SESSION_ID` |
| OpenCode | `OPENCODE_PORT`, `OPENCODE_AGENT` |

`VSCODE_PID` is deliberately not a marker: it is set in any VS Code terminal regardless of which agent is driving it. Pass `--orchestrator <name>` when detection cannot see the host.

---

## 7. Failure Classification

`classifyFailure()` in [`scripts/common.mjs`](../scripts/common.mjs) tags a failed run so the cascade knows what it is looking at:

| Kind | Trigger | Cascade behaviour |
|------|---------|-------------------|
| `quota` | Usage limit, rate limit, credit balance, HTTP 429 | Try the next provider — a different vendor has separate limits |
| `context-overflow` | Prompt too long, context length exceeded | Try the next provider; shrink attachments if it repeats |
| `auth` | 401/403, invalid key, not signed in | Reported as not retryable, then cascades |
| `not-found` | Binary missing, ENOENT | Reported as not retryable, then cascades |
| `timeout` | Runner timeout | Partial output retained and returned if nothing better follows |

A provider that exits `0` with empty output is treated as a failure, not a silent success: CLIs routinely report quota exhaustion on stderr and still exit clean.

---

## 8. Git Integrity Check

Every runner snapshots `git status --porcelain` before and after the delegate run. A difference triggers a `gitIntegrityViolation` warning in the result.

**False positives**: the snapshot captures all workspace changes, not just those from the delegate. Concurrent processes — IDE auto-save, file watchers, background builds, linters, test runners — can modify files during the run and trigger a violation that is unrelated to the delegate. The warning should be investigated, not treated as proof of a read-only breach.
