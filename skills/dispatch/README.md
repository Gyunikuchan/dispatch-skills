# dispatch

Hand bounded, read-only tasks to external coding-agent CLIs and receive clean, synthesized results without polluting your primary agent's context window.

---

## What It Does

When working with an AI coding assistant (the **orchestrator**—like Claude Code, Antigravity, or GitHub Copilot), complex investigations, code trace requests, or plan reviews can flood the context window with hundreds of lines of raw search outputs and intermediate tool calls.

`dispatch` solves this by acting as a **cross-agent delegation bridge**:
1. **Delegates bounded read-only work** to an external agent CLI (Claude Code, Antigravity 2.0, Copilot, or Local OpenCode).
2. **Runs in isolation** in the background, redirecting verbose execution traces to OS temp logs.
3. **Returns only the synthesized answer** along with a persistent session handle or canvas deep-link.
4. **Preserves the orchestrator's role**: The orchestrator keeps the user brief, judgment, workspace file edits, and git commits.

```mermaid
flowchart TD
    User(["👤 User Prompt"]) --> Orchestrator["🤖 Orchestrator Agent<br/>(Claude Code / Antigravity / Copilot)"]
    Orchestrator -->|"Delegates read-only task"| Dispatch["⚡ dispatch"]
    
    Dispatch -->|"Selects available CLI"| Delegate["🔍 External Delegate CLI<br/>(Claude Code / Antigravity / Copilot / Local)"]
    
    Delegate -.->|"Streams raw tool traces"| Logs[("📝 OS Temp Logs<br/>(Keeps context clean)")]
    Delegate -->|"Returns clean answer & session link"| Orchestrator
    
    Orchestrator -->|"Presents synthesized result"| User
```

---

## Prerequisites & Installation

### Prerequisites
- **Node.js**: `v18.0.0` or higher.
- **At least one agent CLI** installed or reachable on your system:
  - **Claude Code**: Claude Desktop, Claude VS Code Extension, or standalone CLI (`claude`).
  - **Antigravity 2.0**: Antigravity Desktop app, VS Code extension, or CLI (`agy`).
  - **GitHub Copilot**: GitHub Copilot Desktop, Copilot CLI, or VS Code Extension CLI (`copilot`).
  - **OpenCode**: `opencode` binary, configured via `opencode.jsonc`'s `model` field to any `provider/model` it supports (e.g. `anthropic/claude-opus-5`, `openrouter/...`). With no `model` configured anywhere (`opencode.jsonc`, dispatch's own config), `opencode` falls back to its own CLI default — dispatch makes no assumption of Local LM Studio.

### Installation

Install `dispatch` into your current project workspace:

```bash
npx skills add Gyunikuchan/dispatch-skills --skill dispatch
```

To install globally for all projects:

```bash
npx skills add -g Gyunikuchan/dispatch-skills --skill dispatch
```

To install every skill in this repository:

```bash
npx skills add Gyunikuchan/dispatch-skills --all
```

---

## How to Use

Trigger `dispatch` directly via the slash command `/dispatch` (or natural language) in your agent chat session. You do not need to invoke lower-level scripts manually.

### 1. Basic Invocations

Delegate an investigation or trace task:

```markdown
/dispatch Investigate why token refreshes fail silently in src/auth/session.ts
```

```markdown
/dispatch Trace how discount stacking is calculated in src/domain/pricing.ts
```

### 2. Attaching Files & Context (`-f`)

Include specific files as bounded attachments:

```markdown
/dispatch -f src/services/payment.ts -f src/types/billing.ts Check for race conditions in charge capture
```

### 3. Pinning a Specific Provider (`--provider`)

Force delegation to a specific provider and bypass the automatic fallback cascade:

```markdown
/dispatch --provider agy Analyze the state transitions in src/workflow/engine.ts
```

```markdown
/dispatch --provider claude Review our GraphQL schema definition for N+1 vulnerabilities
```

### 4. Overriding Model & Reasoning Effort (`-m`, `-e`)

Specify custom models or higher reasoning effort when needed:

```markdown
/dispatch --provider copilot -m gpt-5.6-luna -e max Audit src/crypto/tokens.ts for timing attacks
```

---

## Options & Flags Reference

When invoking `/dispatch` (or reviewing execution plans), the following flags are supported:

| Option / Flag | Description | Example Slash Command / Usage |
|---|---|---|
| `-f <path>` | Attach context files (repeatable; capped at 128 KB/file, 512 KB total). | `/dispatch -f src/api.ts Audit error handling` |
| `--provider <name>` | Pin provider (`claude`, `agy`, `copilot`, `opencode`); disables cascading. | `/dispatch --provider agy Trace workflow state` |
| `-m <model>` | Override the default delegate model. | `/dispatch -m claude-opus-5 Review core types` |
| `-e <level>` | Override reasoning effort (`low`, `medium`, `high`, `max`). | `/dispatch -e max Verify crypto primitives` |
| `-t <sec>` | Override execution timeout (default: `1800` seconds / 30 mins). | `/dispatch -t 300 Quick dependency check` |
| `--allow-same-agent` | Allow cascading back to the orchestrator's own CLI as a last resort. | `/dispatch --allow-same-agent Analyze query plan` |
| `--orchestrator <name>` | Override auto-detected host platform (`claude`, `agy`, `copilot`, `opencode`). | `/dispatch --orchestrator claude ...` |
| `--json` | Request structured JSON output (OpenCode provider only). | `/dispatch --provider opencode --json Parse AST` |
| `-v` | Stream live verbose execution traces to the active terminal. | `/dispatch -v Run complex benchmark trace` |
| `--no-config` | Skip loading the cascade config; requires `--provider`. | `/dispatch --no-config --provider claude ...` |
| `--validate-only` | Validate the loaded config and exit. | `node scripts/dispatch.mjs --validate-only` |

---

## Configuration

Cascade order and per-provider `model`/`effort` defaults live in a JSONC config, not in the runner scripts. `dispatch` loads exactly one config file — no merging across tiers — from the first of, in precedence order: `<project-root>/.dispatch/config.local.jsonc`, `skills/dispatch/config.local.jsonc`, `<project-root>/.dispatch/config.jsonc`, `skills/dispatch/config.jsonc`, then the shipped [`config.default.jsonc`](config.default.jsonc). The first three are git-ignored, so a project or machine override never lands in a commit by accident.

Schema:

```jsonc
{
  "platforms": {
    // Key order is cascade order. A platform key absent here is never dispatched.
    "claude": { "model": ["claude-opus-5", "claude-sonnet-5"], "effort": "high" },
    "agy": {},
    "copilot": { "model": "gpt-5.6-luna" }
    // "opencode" omitted: never reached by the cascade in this example.
  }
}
```

`model` accepts an array only for `claude` (tried in order as fallback models within that one cascade slot); every other platform takes a single string. An entry may be `{}` — dispatched with no `-m`/`-e` override, i.e. that CLI's own default applies. `-m`/`-e` passed to `dispatch.mjs` directly always win over the config entry.

Copy `config.default.jsonc` to `config.jsonc` (or `config.local.jsonc`) next to this skill, or under `<project-root>/.dispatch/`, and edit it to change the cascade for one project or one machine.

---

## High-Level Behavior & Invariants

- **Automatic Self-Skipping**: The dispatcher inspects environment markers to identify the host platform (e.g., detecting if it is being run from Claude Code or Antigravity). It skips delegating to the host platform by default to engage a differentiated platform/model for a different opinion and behavior, unless explicitly permitted via `--allow-same-agent`.
- **Strictly Read-Only by Design**: Delegates operate in structurally enforced read-only modes (`--mode plan` on Antigravity and Copilot; read-only tool whitelists on Claude Code; dead-end WAN proxies and credential stripping on Local OpenCode). Delegates **cannot** modify project files or make git commits. Antigravity also passes `--dangerously-skip-permissions` to auto-approve read-only tool requests without interactive prompts in headless mode — this only affects permission prompts, not the `--mode plan` write block.
- **Context Window Protection**: Raw terminal logs, tool iterations, and search sweeps are piped to temporary OS log files (`.system_generated/logs` / OS temp). The orchestrating agent receives only the final synthesized summary and session link.
- **Session Continuity & Deep-Links**: When supported, `dispatch` captures and returns session identifiers:
  - **Antigravity 2.0**: `conversation://<id>` deep-links that open directly in the Antigravity desktop canvas.
  - **Claude Code**: `claude --resume <session_id>` command handles.
  - **GitHub Copilot**: `copilot --resume <session_id>` command handles.
- **Pre/Post Git Integrity Checks**: A `git status --porcelain` snapshot is taken before and after every dispatch. Any file modifications created during the run are immediately flagged as integrity warnings.
- **Graceful Degradation**: If every external CLI candidate is missing, unauthenticated, or rate-limited, the runner falls back seamlessly to an in-process native subagent (`research` in Antigravity, `Explore` in Claude Code) or local direct execution without crashing the workflow.

---

## Nuances, Quirks & Troubleshooting

### Binary Auto-Discovery
`dispatch` automatically searches known standard locations across macOS, Linux, and Windows for Desktop applications, VS Code extension bundles, and standalone CLI binaries. You do not need to configure explicit binary paths in your environment.

### Claude Code Sandbox Behavior
When Claude Code dispatches a task to Antigravity, it executes the runner with `dangerouslyDisableSandbox: true`. This is required because Antigravity's local language server binds to a local TCP socket, which is blocked by Claude Code's restricted bash sandbox (`bind: operation not permitted`). Safety remains guaranteed through Antigravity's structural `--mode plan` flag.

### Inspecting In-Flight Progress
If a complex dispatch is taking several minutes, you can inspect the real-time activity log emitted in the launch banner:
```bash
tail -n 30 "<logFilePath>"
```

### Git Integrity False Positives
`dispatch` verifies that the delegate made no file changes. However, concurrent background tasks—such as IDE auto-saves, active file watchers, or background builds running in parallel—can trigger git integrity warnings. Always check which files were touched before assuming a violation.

### OpenCode Provider Setup
`opencode` is config-driven: it targets whatever `provider/model` `opencode.jsonc` resolves, local or remote. `dispatch` assumes nothing about which provider that is — with no `model` configured anywhere, `opencode`'s own CLI default applies, not Local LM Studio.

**Local LM Studio** — used when `opencode.jsonc`'s `model` is set to an `lmstudio/...` model:
1. Start LM Studio and launch the local server at `http://127.0.0.1:1234/v1`.
2. Ensure the `opencode` CLI binary is present on your `PATH`.
3. Dispatch with `--provider opencode` or allow the cascade to reach it.

**Any other provider** — point `opencode.jsonc`'s `model` at a `<provider>/<model>` pair (e.g.
`anthropic/claude-opus-5`, `openrouter/...`); put that provider's credentials in its
`provider.<name>.options.apiKey` entry in `opencode.jsonc` (resolved by `opencode`'s own
subprocess), not in your shell environment — dispatch strips ambient cloud API keys before the
delegate spawns. Preflight, the GPU concurrency lock, and WAN proxy-trapping only apply when the
resolved endpoint is local; a remote provider's own `auth`/`quota`/`not-found` failures surface
and cascade normally.
