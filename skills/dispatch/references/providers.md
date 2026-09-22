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
  candidate order.
- **Overrides:** `-m` or `-e` collapses each resolved platform to one target. An omitted value is
  left to the provider CLI.
- **Membership:** `--list-platforms` is authoritative: dispatchable platforms are defined solely
  by the active user configuration and are never inferred from `config.sample.jsonc`.

### Shared runner boundary

Every runner strips credentials from the delegate environment, applies the sensitive-file prompt
guardrail, enforces provider-specific read-only controls, and writes session logs under OS temp.
These are defense-in-depth controls, not a complete secret boundary.

## Provider mechanics

### Claude Code

- **Direct runner:** `scripts/claude-run.mjs`; discovery order is CLI → Desktop → VS Code
  extension. Select with `--claude-mode`/`--mode`; probe all modes with `--test-modes` (aliases:
  `--probe-modes`, `--reachability`). The probe prints the resolved executable path.
- **Structured output:** `dispatch --response-schema-file <path>` validates a bounded JSON Schema
  and passes it to Claude as `--json-schema`. Other providers are unavailable for that invocation.
- **Read-only:** `--permission-mode plan`, a read-tool allowlist, and an explicit write-tool
  denylist.
- **Sandbox:** enabled by default through `--settings {"sandbox":{"enabled":true}}`. Set
  `read-delegates.claude.sandbox` to `false` or pass `--no-sandbox` only for compatibility. macOS uses
  Seatbelt; Linux/WSL2 uses Bubblewrap plus its network helper; managed settings may override a
  local opt-out.
- **Compatibility:** only `enabled` is forced; `allowUnsandboxedCommands` and `failIfUnavailable`
  are not. A rejected or unavailable setting returns `sandbox-unsupported` and never retries
  unsandboxed.
- **Recovery:** the JSON envelope supplies the session id; resume with
  `claude --resume <session_id>`.

### Antigravity 2.0 (`agy`)

- **Direct runner:** `scripts/agy-run.mjs`; discovery order is Antigravity CLI → Antigravity 2.0
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

- **Direct runner:** `scripts/copilot-run.mjs`; discovery order is Standalone CLI → Desktop
  cache/app → VS Code extension. Select with `--copilot-mode`; probe with `--test` (aliases:
  `--probe`, `--check`, `--test-modes`). The probe prints the resolved executable path.
- **Read-only:** `--mode plan` prevents write actions.
- **Sandbox:** enabled by default with `--experimental --sandbox`. Set
  `read-delegates.copilot.sandbox` to `false` or pass `--no-sandbox` when the CLI lacks support or
  blocks a required command. Built-in file edits are not OS-sandboxed; plan mode remains active.
- **Compatibility:** unsupported sandbox flags return `sandbox-unsupported` without an
  unsandboxed retry. The outer dispatch may choose another provider; a direct runner reports the
  upgrade or opt-out action. Quota failures may move to the next mode; authentication failures
  are returned without repeating the shared credential check.
- **Recovery:** resume with `copilot --resume <session_id>`.

### OpenCode (`opencode`)

- **Direct runner:** `scripts/opencode-run.mjs`; discovery order is OpenCode CLI → Desktop
  sidecar → VS Code extension bundle. There is no token-free remote API probe; use `--help` and
  the session log to diagnose binary or config resolution.
- **Configuration:** read the locally available `opencode.json`/`opencode.jsonc` precedence chain.
  Any configured `provider/model` is valid; with no configured model, let OpenCode select one.
  `-a` and `--json` are OpenCode-only dispatch options.
- **Read-only/local:** a loopback endpoint gets a fast `/models` preflight, a GPU concurrency
  lock, and a proxy trap that permits the local backend while blocking WAN. On Linux, Bubblewrap
  may mount the project and attachments read-only while keeping OpenCode state writable.
- **Remote:** skip the live preflight and WAN trap so the provider can reach its service. Put
  credentials in `opencode.jsonc` (`provider.<name>.options.apiKey`); ambient cloud keys are
  stripped.
- **Recovery:** the session handle is the resolved endpoint URL or
  `opencode:<provider>/<model>`. `SERVER_OFFLINE`, `CONTEXT_BUDGET_EXCEEDED`, model-load, quota,
  and timeout diagnostics are returned to the outer cascade.

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
| `model-not-loaded` | Local backend reports no loaded model | Cascade to another configured target. |
| `sandbox-unsupported` | Provider rejects requested sandbox flags/settings | Fail closed; upgrade or set that provider's sandbox option to `false`. |
| `not-found` | Missing or unlaunchable binary | Cascade or inspect the provider probe. |
| `timeout` / `buffer` | Time limit or output cap | Preserve partial output; use it when sufficient. |
| `empty-output` | Exit 0 with no response text | Treat as failure and cascade. |

### Native fallback

Use this path after `NO_DISPATCH_AVAILABLE`, a pinned non-zero result, an empty result, or another
runner failure. Configuration, integrity, membership, and `--no-config` errors are terminal:
report the exact diagnostic instead.

1. Identify the failed target and orchestrator platforms. Resolve concrete effective `model` and
   `reasoningEffort`; exclude and re-resolve a source whose cascade cannot identify them.
2. Emit a closed descriptor containing `sourceKey`, `agentType`, `model`, `reasoningEffort`, and
   `substitutesFor`, then pass it unchanged to the native launcher. Matching platforms use the
   host's native read-only subagent; differing platforms use this map:

   | Failed platform | Native subagent |
   |---|---|
   | `claude` | `Explore` |
   | `agy` | `research` |
   | `copilot` | `explore` |
   | `opencode` | `explore` |

   Reuse the exact prompt and attachments. A launcher that cannot accept the descriptor excludes
   and re-resolves the source; it never substitutes defaults, re-enters `dispatch`, or answers inline.
3. Treat fallback as a transport replacement, not a reduced review. Capture the complete final response in the failed slot's `dispatch.outputPath` (or its named
   stdout-result channel). Record the actual `agentType`, `model`, and `reasoningEffort`; reject
   missing or mismatched launch metadata. Preserve source identity, `substitutesFor`, and the
   fallback reason through `source-map.mjs --extra`.
4. Run the unchanged parsing, sanitization, verification, adjudication, ruling, and consensus pipeline through artifact update and checkpoint. A clean fallback participates like a clean direct report; an invalid
   fallback remains failed.

A named agent type above is read-only by construction. A default subagent is write-capable, so its
read-only boundary is prompt-enforced: instruct it to return claims and evidence only and to make
no file edits. A generated prompt file and its attachments are inputs to this path, not finished
artifacts: prune them only after this fallback consumes them or reaches a terminal outcome.

**Done when:** the matching fallback has a terminal result in the failed slot's normal report
channel, the caller has processed it through the same pipeline as a direct result, and its fallback
source metadata and reason are recorded.

For an orchestrated review wave, a same-platform failure takes the native branch immediately.
Other targets may use ordered reserves before step 3; use each reserve at most once per wave and
record `<failed target> → <reserve>: <reason>`.

## Integrity and diagnosis

- `INTEGRITY_VIOLATION` means the skill hash manifest rejected a modified skill file; stop rather
  than dispatching.
- For `CLI_NOT_FOUND`, `SERVER_OFFLINE`, or `CONTEXT_BUDGET_EXCEEDED`, read the banner's log path,
  then run the affected runner with `--help` or its documented probe before changing config.
